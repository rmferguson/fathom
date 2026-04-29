#!/usr/bin/env node
/**
 * Fathom hook capture handler — Layer 1
 *
 * Called by Claude Code on hook events. Reads the hook payload from stdin,
 * normalizes it to the Fathom v1 event schema, and appends to the local sink.
 *
 * Constraints: Node stdlib only. Always exits 0. Never blocks Claude Code.
 *
 * Environment:
 *   FATHOM_SINK  Override default sink path (~/.fathom/events.jsonl)
 *   FATHOM_OFF   Set to any value to disable capture without removing the hook
 *
 * Session-end deduplication
 * --------------------------
 * Both Stop and SessionEnd hook events map to event_type: "session_end". On a
 * clean exit, Claude Code fires both hooks, which would produce two records with
 * the same session_id. To allow the aggregator to coalesce them correctly, each
 * session_end record carries a `hook_source` field ("Stop" or "SessionEnd").
 *
 * Aggregator coalesce rule: when both records are present for the same session,
 * prefer the Stop record (it carries last_assistant_message). On an interrupted
 * session only SessionEnd fires, so no coalescing is needed there.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";

const SCHEMA_VERSION = "1.0.0";
const DEFAULT_SINK = path.join(os.homedir(), ".fathom", "events.jsonl");
const SINK = process.env.FATHOM_SINK ?? DEFAULT_SINK;

/**
 * Maximum bytes of stdin we'll buffer from a single hook invocation.
 *
 * Claude Code hook payloads are generally small (KBs to low MBs for tool
 * responses with large content blocks). 8 MiB is comfortably above any
 * realistic real-world payload while still preventing an unbounded
 * accumulation that could OOM the capture process. Override via
 * FATHOM_MAX_STDIN_BYTES if you have a legitimate larger payload.
 *
 * On overflow we abandon the event silently — telemetry must never block
 * Claude Code, and oversized events are most likely an upstream bug.
 */
export const MAX_STDIN_BYTES = (() => {
  const env = process.env.FATHOM_MAX_STDIN_BYTES;
  if (env !== undefined) {
    const n = Number(env);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return 8 * 1024 * 1024;
})();

type Rec = Record<string, unknown>;

function now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

// Fields present on every raw hook payload — never interesting as extras.
const UNIVERSAL_KEYS = new Set(["hook_event_name", "session_id", "cwd"]);

/** Returns a record of fields in `raw` not in `knownKeys` or the universal set.
 *  Returns undefined when nothing is left, so the extra key is omitted entirely. */
function pickExtra(raw: Rec, knownKeys: string[]): Rec | undefined {
  const result: Rec = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!UNIVERSAL_KEYS.has(k) && !knownKeys.includes(k)) result[k] = v;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function normalize(raw: Rec): Rec | null {
  const eventName = (raw.hook_event_name as string) ?? "";
  const sessionId = (raw.session_id as string) ?? "";
  const ts = now();

  const projectDir = (process.env.CLAUDE_PROJECT_DIR ?? (raw.cwd as string) ?? "").replace(
    /\/$/,
    ""
  );

  const event = (eventType: string, payload: Rec, extra?: Rec): Rec => ({
    schema_version: SCHEMA_VERSION,
    event_type: eventType,
    timestamp: ts,
    session_id: sessionId,
    project_dir: projectDir,
    payload,
    ...(extra !== undefined ? { extra } : {}),
  });

  if (eventName === "PostToolUse") {
    const toolName = (raw.tool_name as string) ?? "";
    const response = (raw.tool_response as Rec) ?? {};
    const usage = (response.usage as Rec) ?? {};
    const success =
      toolName === "Agent"
        ? response.status === "completed"
        : !((response.interrupted as boolean) ?? false);
    const payload: Rec = {
      tool_name: toolName,
      tool_use_id: raw.tool_use_id ?? "",
      success,
      duration_ms: response.totalDurationMs ?? null,
    };
    if (toolName === "Agent") {
      Object.assign(payload, {
        total_tokens: response.totalTokens,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_read_tokens: usage.cache_read_input_tokens,
        cache_creation_tokens: usage.cache_creation_input_tokens,
        agent_id: response.agentId,
        agent_type: response.agentType,
      });
    }
    return event(
      "tool_use",
      payload,
      pickExtra(raw, ["tool_name", "tool_use_id", "tool_response"])
    );
  }

  if (eventName === "PreToolUse") {
    const toolInput = (raw.tool_input as Rec) ?? {};
    return event(
      "tool_start",
      {
        tool_name: raw.tool_name ?? "",
        tool_use_id: raw.tool_use_id ?? "",
        input_size_bytes: Buffer.byteLength(JSON.stringify(toolInput)),
      },
      pickExtra(raw, ["tool_name", "tool_use_id", "tool_input"])
    );
  }

  if (eventName === "PostToolUseFailure") {
    return event(
      "tool_failure",
      {
        tool_name: raw.tool_name ?? "",
        tool_use_id: raw.tool_use_id ?? "",
        error: raw.error ?? null,
        is_interrupt: raw.is_interrupt ?? null,
      },
      pickExtra(raw, ["tool_name", "tool_use_id", "error", "is_interrupt"])
    );
  }

  if (eventName === "SessionStart") {
    return event(
      "session_start",
      { cwd: raw.cwd ?? "", permission_mode: raw.permission_mode ?? "" },
      pickExtra(raw, ["permission_mode"])
    );
  }

  if (eventName === "Stop" || eventName === "SessionEnd") {
    // Both hooks fire on clean exit, producing two session_end records.
    // hook_source lets the aggregator coalesce: Stop wins when both are present.
    return event(
      "session_end",
      {
        cwd: raw.cwd ?? "",
        last_assistant_message: raw.last_assistant_message ?? null,
        hook_source: eventName as "Stop" | "SessionEnd",
      },
      pickExtra(raw, ["last_assistant_message"])
    );
  }

  if (eventName === "Notification") {
    return event(
      "notification",
      { message: raw.message ?? "", level: raw.level ?? null },
      pickExtra(raw, ["message", "level"])
    );
  }

  if (eventName === "SubagentStart") {
    return event(
      "subagent_start",
      { agent_id: raw.agent_id ?? "", agent_type: raw.agent_type ?? "" },
      pickExtra(raw, ["agent_id", "agent_type"])
    );
  }

  if (eventName === "SubagentStop") {
    return event(
      "subagent_stop",
      {
        agent_id: raw.agent_id ?? "",
        agent_type: raw.agent_type ?? "",
        agent_transcript_path: raw.agent_transcript_path ?? null,
        last_assistant_message: raw.last_assistant_message ?? null,
        stop_hook_active: raw.stop_hook_active ?? null,
      },
      pickExtra(raw, [
        "agent_id",
        "agent_type",
        "agent_transcript_path",
        "last_assistant_message",
        "stop_hook_active",
      ])
    );
  }

  if (eventName === "PreCompact") {
    return event("pre_compact", {}, pickExtra(raw, []));
  }

  // Intentionally unhandled hook events.
  //
  // Claude Code emits ~30 hook event types (see docs/hook-reference.md). Fathom
  // captures only the ones above — those are the events that produce metrics
  // worth aggregating (tool calls, sessions, subagents, compactions). Returning
  // null here drops everything else silently, which is the correct behavior:
  //
  //   - UserPromptSubmit       — only carries prompt text; not a metric.
  //   - PermissionRequest /    — workflow signals, not workload signals.
  //     PermissionDenied
  //   - PostCompact            — pair with PreCompact; PreCompact alone is enough.
  //   - StopFailure            — rare; SessionEnd already covers session boundaries.
  //   - ConfigChange,          — environmental, not workload.
  //     CwdChanged, FileChanged
  //   - TaskCreated /          — task tracker tooling, not workload metrics.
  //     TaskCompleted
  //   - WorktreeCreate /       — workspace plumbing, not workload metrics.
  //     WorktreeRemove
  //   - Elicitation /          — interactive input flows, no aggregation value.
  //     ElicitationResult
  //   - InstructionsLoaded     — environmental, fires on session start.
  //   - TeammateIdle           — multi-agent coordination, out of scope.
  //
  // Adding a new event type means: (1) extend the EventType union in
  // schema/v1.ts, (2) add a handler branch above, (3) update the aggregator
  // if the event should affect metrics, (4) document in docs/hook-reference.md.
  return null;
}

interface TranscriptTokens {
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

/**
 * Read token usage from a subagent transcript JSONL file.
 *
 * The transcript records one entry per turn. Each "assistant" turn has a
 * message.usage object. A single API message may appear twice (streaming
 * intermediate + final), so we deduplicate by message.id and take the last
 * occurrence (highest output_tokens). Cap at 16 MiB to avoid unbounded reads.
 *
 * Returns null if the file is missing, unreadable, or empty.
 */
export async function readTranscriptTokens(
  transcriptPath: string
): Promise<TranscriptTokens | null> {
  try {
    if (!fs.existsSync(transcriptPath)) return null;
    const stat = fs.statSync(transcriptPath);
    if (stat.size > 16 * 1024 * 1024) return null; // skip outlier-sized files
    const rl = readline.createInterface({
      input: fs.createReadStream(transcriptPath),
      crlfDelay: Infinity,
    });
    const byId = new Map<
      string,
      { input: number; output: number; cacheRead: number; cacheCreate: number }
    >();
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as Rec;
        if (obj.type !== "assistant") continue;
        const msg = obj.message as Rec | undefined;
        if (!msg?.usage || !msg?.id) continue;
        const u = msg.usage as Rec;
        byId.set(msg.id as string, {
          input: (u.input_tokens as number) ?? 0,
          output: (u.output_tokens as number) ?? 0,
          cacheRead: (u.cache_read_input_tokens as number) ?? 0,
          cacheCreate: (u.cache_creation_input_tokens as number) ?? 0,
        });
      } catch {
        // skip malformed lines
      }
    }
    if (byId.size === 0) return null;
    let input = 0,
      output = 0,
      cacheRead = 0,
      cacheCreate = 0;
    for (const t of byId.values()) {
      input += t.input;
      output += t.output;
      cacheRead += t.cacheRead;
      cacheCreate += t.cacheCreate;
    }
    return {
      total_tokens: input + output + cacheRead + cacheCreate,
      input_tokens: input,
      output_tokens: output,
      cache_read_tokens: cacheRead,
      cache_creation_tokens: cacheCreate,
    };
  } catch {
    return null; // telemetry failure must never affect the session
  }
}

export async function main(input: string, sinkPath: string = SINK): Promise<void> {
  let raw: Rec;
  try {
    raw = JSON.parse(input) as Rec;
  } catch {
    return; // never block Claude Code
  }

  const fathomEvent = normalize(raw);
  if (fathomEvent === null) {
    return;
  }

  // Augment subagent_stop events with token data from the transcript file.
  // Background agents don't populate tokens in PostToolUse; the transcript is
  // the only reliable source of per-subagent token usage.
  if (fathomEvent.event_type === "subagent_stop") {
    const transcriptPath = (fathomEvent.payload as Rec).agent_transcript_path as string | undefined;
    if (transcriptPath) {
      const tokens = await readTranscriptTokens(transcriptPath);
      if (tokens !== null) {
        Object.assign(fathomEvent.payload as Rec, tokens);
      }
    }
  }

  try {
    fs.mkdirSync(path.dirname(sinkPath), { recursive: true });
    fs.appendFileSync(sinkPath, JSON.stringify(fathomEvent) + "\n");
  } catch {
    // telemetry failure must never affect the session
  }
}

/**
 * Read stdin into a buffer with a hard cap. Returns null if the cap is
 * exceeded — caller should treat this as a no-op (drop the event silently).
 * Exposed for testing.
 */
export function readStdinBounded(
  stream: NodeJS.ReadableStream,
  maxBytes: number = MAX_STDIN_BYTES
): Promise<string | null> {
  return new Promise((resolve) => {
    let input = "";
    let bytes = 0;
    let aborted = false;
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      if (aborted) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) {
        aborted = true;
        resolve(null);
        return;
      }
      input += chunk;
    });
    stream.on("end", () => {
      if (!aborted) resolve(input);
    });
    stream.on("error", () => {
      if (!aborted) resolve(null);
    });
  });
}

if (typeof require !== "undefined" && require.main === module) {
  if (process.env.FATHOM_OFF) process.exit(0);
  readStdinBounded(process.stdin).then(async (input) => {
    if (input !== null) await main(input);
    process.exit(0);
  });
}
