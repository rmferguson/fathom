import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import {
  FathomEvent,
  ToolUsePayload,
  ToolFailurePayload,
  SessionEndPayload,
  SubagentPayload,
} from "../schema/v1";

/**
 * Default sink path. Honors FATHOM_SINK so reads and writes line up when the
 * env var is set (capture.ts uses the same override). Evaluated lazily so
 * tests can override the env var per-test without re-importing the module.
 */
export function defaultSinkPath(): string {
  return process.env.FATHOM_SINK ?? path.join(os.homedir(), ".fathom", "events.jsonl");
}

export interface SubagentSummary {
  agent_type: string;
  dispatches: number; // count of subagent_start events seen
  completions: number; // count of subagent_stop events seen
}

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
  cache_creation_tokens: number;
  errors: number;
  subagents: Record<string, SubagentSummary>;
  /**
   * Estimated USD cost based on Agent-tool token usage. Subagents are the only
   * source where the hook API exposes token counts, so this approximates
   * subagent dispatch spend only and undercounts the orchestrator session.
   */
  cost_usd: number;
}

export interface AggregateSummary {
  sessions: SessionSummary[];
  total_sessions: number;
  total_tokens: number;
  total_tool_calls: number;
  total_cost_usd: number;
  top_tools: Array<{ tool: string; count: number }>;
  subagent_totals: Record<string, SubagentSummary>;
}

/**
 * Token-based cost rates in USD per 1M tokens.
 *
 * These are approximations based on published Claude Sonnet pricing. The hook
 * API does not tell us which model handled a turn, so we apply a single rate
 * across all Agent-tool token spend. Treat the resulting `cost_usd` as a
 * rough order-of-magnitude estimate, not an invoice.
 *
 * Override via env vars FATHOM_PRICE_INPUT, FATHOM_PRICE_OUTPUT,
 * FATHOM_PRICE_CACHE_READ, FATHOM_PRICE_CACHE_WRITE (USD per 1M tokens).
 */
export interface CostRates {
  inputPer1M: number;
  outputPer1M: number;
  cacheReadPer1M: number;
  cacheWritePer1M: number;
}

export const DEFAULT_COST_RATES: CostRates = {
  inputPer1M: 3.0,
  outputPer1M: 15.0,
  cacheReadPer1M: 0.3,
  cacheWritePer1M: 3.75,
};

function ratesFromEnv(env: NodeJS.ProcessEnv = process.env): CostRates {
  const num = (key: string, fallback: number) => {
    const v = env[key];
    if (v === undefined) return fallback;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    inputPer1M: num("FATHOM_PRICE_INPUT", DEFAULT_COST_RATES.inputPer1M),
    outputPer1M: num("FATHOM_PRICE_OUTPUT", DEFAULT_COST_RATES.outputPer1M),
    cacheReadPer1M: num("FATHOM_PRICE_CACHE_READ", DEFAULT_COST_RATES.cacheReadPer1M),
    cacheWritePer1M: num("FATHOM_PRICE_CACHE_WRITE", DEFAULT_COST_RATES.cacheWritePer1M),
  };
}

export function estimateCost(
  payload: ToolUsePayload,
  rates: CostRates = DEFAULT_COST_RATES
): number {
  const input = payload.input_tokens ?? 0;
  const output = payload.output_tokens ?? 0;
  const cacheRead = payload.cache_read_tokens ?? 0;
  const cacheWrite = payload.cache_creation_tokens ?? 0;
  return (
    (input * rates.inputPer1M) / 1_000_000 +
    (output * rates.outputPer1M) / 1_000_000 +
    (cacheRead * rates.cacheReadPer1M) / 1_000_000 +
    (cacheWrite * rates.cacheWritePer1M) / 1_000_000
  );
}

export function filterByProject(events: FathomEvent[], projectDir: string): FathomEvent[] {
  const normalized = projectDir.replace(/\/$/, "");
  return events.filter((e) => e.project_dir === normalized);
}

export async function readEvents(sinkPath: string = defaultSinkPath()): Promise<FathomEvent[]> {
  if (!fs.existsSync(sinkPath)) return [];

  const events: FathomEvent[] = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(sinkPath),
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

export interface PruneResult {
  removed: number;
  kept: number;
  bytesRecovered: number;
}

/**
 * Remove events older than cutoffMs from the sink file.
 *
 * Streams the sink line-by-line, writing kept lines to a sibling temp file,
 * then atomically renames it over the sink. Malformed lines are kept (same
 * policy as readEvents — don't silently discard records we can't parse).
 *
 * Returns counts for the caller to display. Throws on I/O errors so the CLI
 * can report them cleanly without leaving a partial temp file behind.
 */
export async function pruneEvents(
  cutoffMs: number,
  sinkPath: string = defaultSinkPath()
): Promise<PruneResult> {
  if (!fs.existsSync(sinkPath)) return { removed: 0, kept: 0, bytesRecovered: 0 };

  const tmpPath = sinkPath + ".tmp." + process.pid;
  let removed = 0;
  let kept = 0;
  let bytesRemoved = 0;

  try {
    const out = fs.createWriteStream(tmpPath, { encoding: "utf8" });
    const rl = readline.createInterface({
      input: fs.createReadStream(sinkPath),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let drop = false;
      try {
        const ev = JSON.parse(trimmed) as { timestamp?: string };
        const ts = Date.parse(ev.timestamp ?? "");
        if (!Number.isNaN(ts) && ts < cutoffMs) drop = true;
      } catch {
        // malformed line — keep it
      }

      if (drop) {
        removed++;
        bytesRemoved += Buffer.byteLength(line + "\n");
      } else {
        kept++;
        out.write(line + "\n");
      }
    }

    await new Promise<void>((resolve, reject) => {
      out.end((err: Error | null | undefined) => (err ? reject(err) : resolve()));
    });

    fs.renameSync(tmpPath, sinkPath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }

  return { removed, kept, bytesRecovered: bytesRemoved };
}

/**
 * Coalesce duplicate session_end events for the same session_id.
 *
 * Claude Code fires the Stop hook on every turn completion, not just at final
 * exit — a long session accumulates many Stop records. It also fires SessionEnd
 * once on clean exit. The last Stop record is the authoritative end-of-session
 * marker (it carries the final last_assistant_message and the correct end
 * timestamp). SessionEnd-only records are interrupted sessions.
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

  // For each session, pick the winner: last Stop if any exist, otherwise last
  // SessionEnd. Stop fires on every turn so the last one is the real session end.
  const winners = new Map<string, FathomEvent>();
  for (const [sessionId, ends] of sessionEnds) {
    if (ends.length === 1) {
      winners.set(sessionId, ends[0]);
      continue;
    }
    const stopRecords = ends.filter((e) => (e.payload as SessionEndPayload).hook_source === "Stop");
    const winner =
      stopRecords.length > 0 ? stopRecords[stopRecords.length - 1] : ends[ends.length - 1];
    winners.set(sessionId, winner);
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

export interface AggregateOptions {
  costRates?: CostRates;
}

export function aggregate(events: FathomEvent[], options: AggregateOptions = {}): AggregateSummary {
  const rates = options.costRates ?? ratesFromEnv();

  // Deduplicate session_end events before aggregating.
  const dedupedEvents = coalesceSessionEnds(events);

  const sessionsMap = new Map<string, SessionSummary>();

  // Track which tool_use_ids have already produced an error increment.
  // PostToolUse may emit tool_use{success:false} (e.g. Bash interrupt) AND
  // PostToolUseFailure may emit tool_failure for the same call — counting
  // both would double-count. Per session we keep at most one error per id.
  const erroredIdsBySession = new Map<string, Set<string>>();
  const seenSubagentDispatchIds = new Map<string, Set<string>>();
  // Maps agent_id → agent_type so subagent_stop events with empty agent_type
  // (e.g. stops for agents dispatched before fathom was installed) can still
  // be attributed to the correct type bucket rather than creating a blank row.
  const agentTypeById = new Map<string, string>();

  function ensureSession(event: FathomEvent): SessionSummary {
    let s = sessionsMap.get(event.session_id);
    if (!s) {
      s = {
        session_id: event.session_id,
        project_dir: event.project_dir ?? "",
        started_at: event.timestamp,
        tool_calls: {},
        total_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        errors: 0,
        subagents: {},
        cost_usd: 0,
      };
      sessionsMap.set(event.session_id, s);
    }
    return s;
  }

  function recordError(sessionId: string, toolUseId: string | undefined): boolean {
    // Returns true if this error should count (not already seen for this id).
    let seen = erroredIdsBySession.get(sessionId);
    if (!seen) {
      seen = new Set();
      erroredIdsBySession.set(sessionId, seen);
    }
    if (toolUseId && seen.has(toolUseId)) return false;
    if (toolUseId) seen.add(toolUseId);
    return true;
  }

  for (const event of dedupedEvents) {
    const session = ensureSession(event);

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
      session.cache_creation_tokens += p.cache_creation_tokens ?? 0;
      if (p.tool_name === "Agent") {
        session.cost_usd += estimateCost(p, rates);
      }
      if (!p.success && recordError(event.session_id, p.tool_use_id)) {
        session.errors++;
      }
    }

    if (event.event_type === "tool_failure") {
      // PostToolUseFailure hook produces standalone tool_failure events.
      // Dedupe by tool_use_id so we don't double-count when both
      // tool_use{success:false} and tool_failure arrive for the same call.
      const p = event.payload as ToolFailurePayload;
      if (recordError(event.session_id, p.tool_use_id)) {
        session.errors++;
      }
    }

    if (event.event_type === "subagent_start") {
      const p = event.payload as SubagentPayload;
      const type = p.agent_type || "unknown";
      if (p.agent_id) agentTypeById.set(p.agent_id, type);
      const bucket = (session.subagents[type] ??= {
        agent_type: type,
        dispatches: 0,
        completions: 0,
      });
      // Dedupe in case the same agent_id is captured twice.
      const seen = seenSubagentDispatchIds.get(event.session_id) ?? new Set<string>();
      if (!p.agent_id || !seen.has(p.agent_id)) {
        bucket.dispatches++;
        if (p.agent_id) seen.add(p.agent_id);
        seenSubagentDispatchIds.set(event.session_id, seen);
      }
    }

    if (event.event_type === "subagent_stop") {
      const p = event.payload as SubagentPayload;
      // Resolve type from the matching start event when the stop arrives without
      // one — happens for agents dispatched before fathom was installed.
      const type = p.agent_type || agentTypeById.get(p.agent_id ?? "") || "unknown";
      const bucket = (session.subagents[type] ??= {
        agent_type: type,
        dispatches: 0,
        completions: 0,
      });
      bucket.completions++;
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
  const subagentTotals: Record<string, SubagentSummary> = {};
  let totalTokens = 0;
  let totalToolCalls = 0;
  let totalCost = 0;

  for (const s of sessions) {
    totalTokens += s.total_tokens;
    totalCost += s.cost_usd;
    for (const [tool, count] of Object.entries(s.tool_calls)) {
      toolTotals[tool] = (toolTotals[tool] ?? 0) + count;
      totalToolCalls += count;
    }
    for (const [type, sub] of Object.entries(s.subagents)) {
      const bucket = (subagentTotals[type] ??= {
        agent_type: type,
        dispatches: 0,
        completions: 0,
      });
      bucket.dispatches += sub.dispatches;
      bucket.completions += sub.completions;
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
    total_cost_usd: totalCost,
    top_tools: topTools,
    subagent_totals: subagentTotals,
  };
}
