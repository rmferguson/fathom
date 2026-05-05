/**
 * Fathom event schema v1.0.0
 *
 * The hook handler layer is the only layer coupled to Claude Code's hook API.
 * Everything above this file consumes the normalized FathomEvent shape.
 *
 * Schema versioning:
 * - Additive changes (new optional fields) → minor version bump
 * - Breaking changes (field removal, type change) → major version bump
 * - Consumers pin to a schema version range, not "latest"
 */

export const SCHEMA_VERSION = "1.0.0";

export type EventType =
  | "session_start"
  | "session_end"
  | "tool_start"
  | "tool_use"
  | "tool_failure"
  | "notification"
  | "subagent_start"
  | "subagent_stop"
  | "pre_compact";

export interface FathomEvent {
  schema_version: string;
  event_type: EventType;
  timestamp: string; // ISO 8601 UTC
  session_id: string;
  project_dir: string; // absolute path — CLAUDE_PROJECT_DIR or cwd fallback
  payload: EventPayload;
  /** Raw hook fields not mapped to a known payload field. Present when Claude Code
   *  sends data fathom doesn't yet have a named field for — useful for discovery. */
  extra?: Record<string, unknown>;
}

export type EventPayload =
  | ToolUsePayload
  | ToolStartPayload
  | ToolFailurePayload
  | SessionEndPayload
  | SessionStartPayload
  | NotificationPayload
  | SubagentPayload
  | GenericPayload;

export interface ToolUsePayload {
  tool_name: string;
  tool_use_id: string;
  duration_ms?: number;
  success: boolean;
  // Agent tool specific — token data is directly available
  agent_status?: string;
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  agent_id?: string;
  agent_type?: string;
}

export interface ToolStartPayload {
  tool_name: string;
  tool_use_id: string;
  input_size_bytes?: number;
}

export interface ToolFailurePayload {
  tool_name: string;
  tool_use_id: string;
  error?: string;
  is_interrupt?: boolean;
}

export interface SessionStartPayload {
  cwd: string;
  permission_mode: string;
}

export interface SessionEndPayload {
  cwd: string;
  /**
   * @deprecated Always undefined — Claude Code's Stop and SessionEnd hooks
   * never populate a wall-time field on the payload. Retained as an optional
   * field for forward compatibility in case a future hook version supplies it.
   * Aggregator currently derives session duration from
   *   Date.parse(session_end.timestamp) - Date.parse(session_start.timestamp).
   */
  wall_time_ms?: number;
  last_assistant_message?: string;
  /**
   * Which Claude Code hook fired this session_end event.
   * "Stop"       — clean exit (/exit or normal session close); richer event.
   * "SessionEnd" — fires on both clean exit and interrupt; may duplicate Stop.
   *
   * On a clean exit both hooks fire, producing two session_end records.
   * The aggregator coalesces them: when both are present for the same session_id,
   * the Stop record wins (it carries last_assistant_message; SessionEnd may not).
   * On an interrupted session only SessionEnd fires, so no coalescing is needed.
   *
   * Absent on events written by fathom versions prior to the coalescing fix —
   * the aggregator treats absent hook_source the same as "Stop" for backward
   * compatibility.
   */
  hook_source?: "Stop" | "SessionEnd";
}

export interface NotificationPayload {
  message?: string;
  level?: string;
}

export interface SubagentPayload {
  agent_id: string;
  agent_type?: string;

  /**
   * Fields present ONLY on subagent_stop events (absent on subagent_start):
   */

  /** Absolute path to the agent's JSONL transcript file, when available. */
  agent_transcript_path?: string;
  /** The final assistant message produced by the agent, if captured. */
  last_assistant_message?: string;
  /** Whether the Stop hook was active when this subagent stopped. */
  stop_hook_active?: boolean;

  /**
   * Token counts extracted from the agent's JSONL transcript at SubagentStop time.
   *
   * Population rules:
   * - Only present on `subagent_stop` events — never on `subagent_start`.
   * - Only populated when `agent_transcript_path` is set AND the transcript
   *   file is readable by the hook handler at stop time.
   * - Absent when: transcript path is missing, file is unreadable, or the
   *   transcript contains no assistant entries with usage data.
   * - Aggregator deduplication: for foreground (PostToolUse) agents, tokens
   *   may also appear on the `tool_use` event payload. The aggregator guards
   *   against double-counting via `agentIdsWithToolUseTokens` — only one
   *   source wins per agent_id. Do not sum both.
   *
   * @see capture.ts readTranscriptTokens — the function that parses these values.
   */
  total_tokens?: number;
  /** Input (prompt) tokens counted in the agent's transcript. */
  input_tokens?: number;
  /** Output (completion) tokens counted in the agent's transcript. */
  output_tokens?: number;
  /** Cache read tokens (already-cached prompt tokens) from the transcript. */
  cache_read_tokens?: number;
  /** Cache creation tokens (newly cached prompt tokens) from the transcript. */
  cache_creation_tokens?: number;
}

/**
 * Generic catch-all payload used for event types that do not have a structured
 * payload schema in this version of fathom.
 *
 * Which events use GenericPayload:
 *
 * - **`pre_compact`**: The PreCompact hook fires when the Claude Code context is
 *   about to be compacted. Fathom records the event for session timeline purposes
 *   (you can count compactions per session) but the raw hook payload has no fields
 *   worth aggregating — so the payload is an empty object `{}`.
 *   Any additional fields Claude Code sends are captured in `FathomEvent.extra`.
 *
 * All other event types map to their own specific payload interface above.
 *
 * Consumer guidance:
 * - Do not rely on any specific field being present in a GenericPayload.
 * - Check `event_type` before casting — any cast to GenericPayload should be
 *   a last resort. Prefer narrowing via `event_type` and the typed payload
 *   interfaces above.
 */
export interface GenericPayload {
  [key: string]: unknown;
}
