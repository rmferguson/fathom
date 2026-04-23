import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import { FathomEvent, ToolUsePayload, SessionEndPayload } from "../schema/v1";

export const SINK_PATH = path.join(os.homedir(), ".fathom", "events.jsonl");

export interface SessionSummary {
  session_id: string;
  project_dir: string;
  started_at: string;
  ended_at?: string;
  wall_time_ms?: number;
  tool_calls: Record<string, number>;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  errors: number;
}

export interface AggregateSummary {
  sessions: SessionSummary[];
  total_sessions: number;
  total_tokens: number;
  total_tool_calls: number;
  top_tools: Array<{ tool: string; count: number }>;
}

export function filterByProject(events: FathomEvent[], projectDir: string): FathomEvent[] {
  const normalized = projectDir.replace(/\/$/, "");
  return events.filter((e) => e.project_dir === normalized);
}

export async function readEvents(sinKPath = SINK_PATH): Promise<FathomEvent[]> {
  if (!fs.existsSync(sinKPath)) return [];

  const events: FathomEvent[] = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(sinKPath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as FathomEvent);
    } catch {
      // quarantine malformed records — don't drop silently in future, log to quarantine file
    }
  }

  return events;
}

/**
 * Coalesce duplicate session_end events for the same session_id.
 *
 * On a clean exit Claude Code fires both Stop and SessionEnd hooks, producing
 * two session_end records. The hook_source field identifies the origin. When
 * both are present, the Stop record takes precedence (it carries
 * last_assistant_message; SessionEnd may arrive without it).
 *
 * On an interrupted session only SessionEnd fires, so no coalescing is needed.
 * On older events without hook_source the first record seen is kept unchanged.
 *
 * The returned array contains at most one session_end per session_id.
 */
function coalesceSessionEnds(events: FathomEvent[]): FathomEvent[] {
  // Collect all session_end events per session, preserving order for non-end events.
  const sessionEnds = new Map<string, FathomEvent[]>();

  for (const event of events) {
    if (event.event_type === "session_end") {
      const bucket = sessionEnds.get(event.session_id) ?? [];
      bucket.push(event);
      sessionEnds.set(event.session_id, bucket);
    }
  }

  // For each session that has multiple session_end records, pick the winner.
  const winners = new Map<string, FathomEvent>();
  for (const [sessionId, ends] of sessionEnds) {
    if (ends.length === 1) {
      winners.set(sessionId, ends[0]);
      continue;
    }
    // Prefer hook_source: "Stop" when both are present.
    const stopRecord = ends.find(
      (e) => (e.payload as SessionEndPayload).hook_source === "Stop"
    );
    winners.set(sessionId, stopRecord ?? ends[ends.length - 1]);
  }

  // Rebuild the event list: for session_end events, only emit the winner and
  // only on its first occurrence (skip subsequent duplicates for the same session).
  const emitted = new Set<string>();
  const result: FathomEvent[] = [];

  for (const event of events) {
    if (event.event_type !== "session_end") {
      result.push(event);
      continue;
    }

    const winner = winners.get(event.session_id);
    if (winner === event && !emitted.has(event.session_id)) {
      result.push(event);
      emitted.add(event.session_id);
    }
    // Non-winning session_end records are dropped silently.
  }

  return result;
}

export function aggregate(events: FathomEvent[]): AggregateSummary {
  // Deduplicate session_end events before aggregating.
  const dedupedEvents = coalesceSessionEnds(events);

  const sessionsMap = new Map<string, SessionSummary>();

  for (const event of dedupedEvents) {
    if (!sessionsMap.has(event.session_id)) {
      sessionsMap.set(event.session_id, {
        session_id: event.session_id,
        project_dir: event.project_dir ?? "",
        started_at: event.timestamp,
        tool_calls: {},
        total_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        errors: 0,
      });
    }

    const session = sessionsMap.get(event.session_id)!;

    if (event.timestamp < session.started_at) {
      session.started_at = event.timestamp;
    }

    if (event.event_type === "tool_use") {
      const p = event.payload as ToolUsePayload;
      session.tool_calls[p.tool_name] = (session.tool_calls[p.tool_name] ?? 0) + 1;
      session.total_tokens += p.total_tokens ?? 0;
      session.input_tokens += p.input_tokens ?? 0;
      session.output_tokens += p.output_tokens ?? 0;
      session.cache_read_tokens += p.cache_read_tokens ?? 0;
      if (!p.success) session.errors++;
    }

    if (event.event_type === "tool_failure") {
      // PostToolUseFailure hook fires standalone tool_failure events that are
      // captured but not counted by the tool_use branch above. Sum them in.
      session.errors++;
    }

    if (event.event_type === "session_end") {
      const p = event.payload as SessionEndPayload;
      session.ended_at = event.timestamp;
      // wall_time_ms is not populated by Stop/SessionEnd hooks.
      // Derive duration from the event timestamps instead.
      session.wall_time_ms =
        p.wall_time_ms ??
        (session.started_at
          ? Date.parse(event.timestamp) - Date.parse(session.started_at)
          : undefined);
    }
  }

  const sessions = Array.from(sessionsMap.values()).sort((a, b) =>
    b.started_at.localeCompare(a.started_at)
  );

  const toolTotals: Record<string, number> = {};
  let totalTokens = 0;
  let totalToolCalls = 0;

  for (const s of sessions) {
    totalTokens += s.total_tokens;
    for (const [tool, count] of Object.entries(s.tool_calls)) {
      toolTotals[tool] = (toolTotals[tool] ?? 0) + count;
      totalToolCalls += count;
    }
  }

  const topTools = Object.entries(toolTotals)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .map(([tool, count]) => ({ tool, count }));

  return {
    sessions,
    total_sessions: sessions.length,
    total_tokens: totalTokens,
    total_tool_calls: totalToolCalls,
    top_tools: topTools,
  };
}
