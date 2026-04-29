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
   */
  hook_source: "Stop" | "SessionEnd";
}

export interface NotificationPayload {
  message?: string;
  level?: string;
}

export interface SubagentPayload {
  agent_id: string;
  agent_type?: string;
  // SubagentStop only
  agent_transcript_path?: string;
  last_assistant_message?: string;
  stop_hook_active?: boolean;
  // Token fields parsed from transcript at SubagentStop time (absent on SubagentStart).
  // Present for both foreground and background agents once the transcript is available.
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
}

export interface GenericPayload {
  [key: string]: unknown;
}
