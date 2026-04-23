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

const SCHEMA_VERSION = "1.0.0";
const DEFAULT_SINK = path.join(os.homedir(), ".fathom", "events.jsonl");
const SINK = process.env.FATHOM_SINK ?? DEFAULT_SINK;

type Rec = Record<string, unknown>;

function now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function normalize(raw: Rec): Rec | null {
  const eventName = (raw.hook_event_name as string) ?? "";
  const sessionId = (raw.session_id as string) ?? "";
  const ts = now();

  const projectDir =
    (process.env.CLAUDE_PROJECT_DIR ?? (raw.cwd as string) ?? "").replace(/\/$/, "");

  const event = (eventType: string, payload: Rec): Rec => ({
    schema_version: SCHEMA_VERSION,
    event_type: eventType,
    timestamp: ts,
    session_id: sessionId,
    project_dir: projectDir,
    payload,
  });

  if (eventName === "PostToolUse") {
    const toolName = (raw.tool_name as string) ?? "";
    const response = (raw.tool_response as Rec) ?? {};
    const usage = (response.usage as Rec) ?? {};
    const success =
      toolName === "Agent"
        ? response.status === "completed"
        : !(response.interrupted as boolean ?? false);
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
    return event("tool_use", payload);
  }

  if (eventName === "PreToolUse") {
    const toolInput = (raw.tool_input as Rec) ?? {};
    return event("tool_start", {
      tool_name: raw.tool_name ?? "",
      tool_use_id: raw.tool_use_id ?? "",
      input_size_bytes: Buffer.byteLength(JSON.stringify(toolInput)),
    });
  }

  if (eventName === "PostToolUseFailure") {
    return event("tool_failure", {
      tool_name: raw.tool_name ?? "",
      tool_use_id: raw.tool_use_id ?? "",
      error: raw.error ?? null,
      is_interrupt: raw.is_interrupt ?? null,
    });
  }

  if (eventName === "SessionStart") {
    return event("session_start", {
      cwd: raw.cwd ?? "",
      permission_mode: raw.permission_mode ?? "",
    });
  }

  if (eventName === "Stop" || eventName === "SessionEnd") {
    // Both hooks fire on clean exit, producing two session_end records.
    // hook_source lets the aggregator coalesce: Stop wins when both are present.
    return event("session_end", {
      cwd: raw.cwd ?? "",
      last_assistant_message: raw.last_assistant_message ?? null,
      hook_source: eventName as "Stop" | "SessionEnd",
    });
  }

  if (eventName === "Notification") {
    return event("notification", {
      message: raw.message ?? "",
    });
  }

  if (eventName === "SubagentStart") {
    return event("subagent_start", {
      agent_id: raw.agent_id ?? "",
      agent_type: raw.agent_type ?? "",
    });
  }

  if (eventName === "SubagentStop") {
    return event("subagent_stop", {
      agent_id: raw.agent_id ?? "",
      agent_type: raw.agent_type ?? "",
      agent_transcript_path: raw.agent_transcript_path ?? null,
      last_assistant_message: raw.last_assistant_message ?? null,
      stop_hook_active: raw.stop_hook_active ?? null,
    });
  }

  if (eventName === "PreCompact") {
    return event("pre_compact", {});
  }

  return null;
}

function main(input: string): void {
  let raw: Rec;
  try {
    raw = JSON.parse(input) as Rec;
  } catch {
    process.exit(0); // never block Claude Code
  }

  const fathomEvent = normalize(raw);
  if (fathomEvent === null) {
    process.exit(0);
  }

  try {
    fs.mkdirSync(path.dirname(SINK), { recursive: true });
    fs.appendFileSync(SINK, JSON.stringify(fathomEvent) + "\n");
  } catch {
    // telemetry failure must never affect the session
  }

  process.exit(0);
}

if (typeof require !== "undefined" && require.main === module) {
  if (process.env.FATHOM_OFF) process.exit(0);
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => { main(input); });
}
