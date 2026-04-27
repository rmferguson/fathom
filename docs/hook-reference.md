# Claude Code Hooks — Technical Reference

**Status:** VERIFIED — empirical spike 2026-04-14; cross-referenced with official Claude Code hooks documentation 2026-04-21  
**Scope:** Hook capabilities relevant to fathom telemetry.

---

## What fathom captures vs. what it ignores

Claude Code emits ~30 hook event types. Fathom captures only the subset that maps to a workload metric. Anything not in the **Captured** column below is silently dropped at `src/hooks/capture.ts` (see the rationale comment there).

| Hook event | Captured? | Mapped event_type | Notes |
|---|---|---|---|
| `SessionStart` | yes | `session_start` | cwd, permission_mode |
| `SessionEnd` | yes | `session_end` | hook_source = "SessionEnd" |
| `Stop` | yes | `session_end` | hook_source = "Stop" — wins coalesce |
| `PreToolUse` | yes | `tool_start` | input_size_bytes only |
| `PostToolUse` | yes | `tool_use` | tokens only on Agent tool |
| `PostToolUseFailure` | yes | `tool_failure` | dedupes against tool_use{success:false} |
| `Notification` | yes | `notification` | message + level |
| `SubagentStart` | yes | `subagent_start` | agent_id, agent_type |
| `SubagentStop` | yes | `subagent_stop` | + agent_transcript_path, last_assistant_message |
| `PreCompact` | yes | `pre_compact` | bare event |
| `UserPromptSubmit` | no | — | prompt text only; no metric value |
| `PermissionRequest` | no | — | workflow signal, not workload |
| `PermissionDenied` | no | — | workflow signal, not workload |
| `PostCompact` | no | — | PreCompact already covers compactions |
| `StopFailure` | no | — | rare; SessionEnd covers the boundary |
| `ConfigChange` | no | — | environmental, not workload |
| `CwdChanged` | no | — | environmental |
| `FileChanged` | no | — | environmental |
| `TaskCreated` | no | — | task tracker; not workload |
| `TaskCompleted` | no | — | task tracker; not workload |
| `WorktreeCreate` | no | — | workspace plumbing |
| `WorktreeRemove` | no | — | workspace plumbing |
| `Elicitation` | no | — | interactive flow |
| `ElicitationResult` | no | — | interactive flow |
| `InstructionsLoaded` | no | — | environmental |
| `TeammateIdle` | no | — | multi-agent coordination, out of scope |

To extend fathom with a new hook event: (1) add the type to `EventType` in `src/schema/v1.ts`, (2) add a handler branch in `normalize()`, (3) wire metrics into `src/aggregator/index.ts`, (4) update this table.

## Hook Event Types — full reference

| Event | Fires When | Can Block? |
|---|---|---|
| `SessionStart` | Session begins or resumes | No |
| `UserPromptSubmit` | User submits a prompt | Yes (exit 2) |
| `PreToolUse` | Before tool execution | Yes (exit 2 or JSON deny) |
| `PermissionRequest` | Permission dialog about to show | Yes |
| `PostToolUse` | After successful tool execution | Via JSON decision |
| `PostToolUseFailure` | After tool fails | No |
| `PermissionDenied` | Auto mode denies a call | No |
| `Stop` | Claude finishes responding (see note) | No |
| `StopFailure` | Claude fails to produce a Stop response | No |
| `PreCompact` | Before context compaction | No |
| `PostCompact` | After context compaction | No |
| `SessionEnd` | Session terminates | No |

> **Stop does not fire on user interrupt.** If the user presses Ctrl-C or closes the terminal, `SessionEnd` may fire but `Stop` will not. Any session-end logic tied to `Stop` has a coverage gap for aborted sessions.

Additional events: `Notification`, `ConfigChange`, `FileChanged`, `CwdChanged`, `TaskCreated`, `TaskCompleted`, `SubagentStart`, `SubagentStop`, `WorktreeCreate`, `WorktreeRemove`, `Elicitation`, `ElicitationResult`, `InstructionsLoaded`, `TeammateIdle`.

### Stop vs SessionEnd — Coexistence on Clean Exit

Both `Stop` and `SessionEnd` fire when a session closes normally (e.g. `/exit`). On an interrupted session (e.g. ctrl+c), only `SessionEnd` fires; `Stop` does not.

Consequence for fathom: mapping both to `event_type: session_end` produces **two** records per clean exit. Fathom resolves this in the aggregator via `coalesceSessionEnds()`: each `session_end` record carries a `hook_source` field (`"Stop"` or `"SessionEnd"`); when both are present for the same `session_id`, the `Stop` record is preferred (it carries `last_assistant_message`).

---

## stdin JSON Schema

All hooks receive a common base payload on stdin:

```json
{
  "session_id": "abc123",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/current/working/directory",
  "permission_mode": "default|plan|acceptEdits|auto|dontAsk|bypassPermissions",
  "hook_event_name": "PreToolUse",
  "agent_id": "optional_subagent_id",
  "agent_type": "optional_agent_name"
}
```

### UserPromptSubmit — Additional Fields

```json
{
  "prompt": "the user's message text"
}
```

No token data, no prior turn context, no model information. Only the raw prompt text.

### PreToolUse — Additional Fields

```json
{
  "tool_name": "Write",
  "tool_use_id": "toolu_01ABC123",
  "tool_input": { ... }
}
```

`tool_input` fields by tool:

| Tool | Key fields |
|---|---|
| `Bash` | `command`, `description`, `timeout`, `run_in_background` |
| `Write` | `file_path`, `content` |
| `Edit` | `file_path`, `old_string`, `new_string`, `replace_all` |
| `Read` | `file_path`, `offset`, `limit` |
| `Agent` | `prompt`, `description`, `subagent_type`, `model` |

### PostToolUse — Additional Fields

```json
{
  "tool_name": "Agent",
  "tool_use_id": "toolu_01ABC123",
  "tool_input": { ... },
  "tool_response": { ... }
}
```

**`tool_response` shape varies by tool. Confirmed shapes:**

**Agent tool** (VERIFIED 2026-04-14):
```json
{
  "status": "completed",
  "agentId": "ae073e850dc4aeefb",
  "agentType": "general-purpose",
  "content": [{ "type": "text", "text": "<output>" }],
  "totalDurationMs": 1378,
  "totalTokens": 9420,
  "totalToolUseCount": 0,
  "usage": {
    "input_tokens": 3,
    "output_tokens": 23,
    "cache_read_input_tokens": 9394,
    "cache_creation_input_tokens": 0
  }
}
```

**Bash tool** (VERIFIED 2026-04-21):
```json
{
  "stdout": "output text",
  "stderr": "",
  "interrupted": false,
  "isImage": false,
  "noOutputExpected": false
}
```
No `duration_ms`, no `status`, no token data. `interrupted: true` is the failure signal.

### PostToolUseFailure — Additional Fields (VERIFIED 2026-04-21)

```json
{
  "tool_name": "Bash",
  "tool_use_id": "toolu_01ABC123",
  "tool_input": { "command": "...", "description": "..." },
  "error": "full error string",
  "is_interrupt": false
}
```

`tool_input` is present with the same shape as PreToolUse. `is_interrupt: true` distinguishes a user interrupt from a real failure.

### SubagentStart — Additional Fields (VERIFIED 2026-04-21)

```json
{
  "agent_id": "abd2347dbf96b5f63",
  "agent_type": "general-purpose"
}
```

Note: `permission_mode` is **absent** from SubagentStart (unlike most other events).

### SubagentStop — Additional Fields (VERIFIED 2026-04-21)

```json
{
  "agent_id": "abd2347dbf96b5f63",
  "agent_type": "general-purpose",
  "stop_hook_active": false,
  "agent_transcript_path": "/home/user/.claude/projects/.../subagents/agent-<id>.jsonl",
  "last_assistant_message": "the agent's final output text"
}
```

`agent_transcript_path` is the full path to the subagent's JSONL transcript — readable after the agent completes.
`last_assistant_message` contains the full text of the subagent's final response (not truncated in testing).

### Stop — Additional Fields (VERIFIED 2026-04-21)

```json
{
  "last_assistant_message": "Claude's final response text",
  "stop_hook_active": false
}
```

`last_assistant_message` is the full text of the final response, not truncated. `stop_hook_active` is present as a payload field (not just an env var) and prevents infinite loops if the Stop hook itself triggers another stop. Identical structure to SubagentStop minus the agent-specific fields.

---

## Token Coverage — Official API Ceiling

**The hook API exposes token counts in exactly one place: PostToolUse on the `Agent` tool.**

From the official Claude Code hooks documentation:

> "Agent tool exposes token counts directly"

No other hook event exposes usage data. Confirmed absent from:
- `UserPromptSubmit` — only has the prompt text
- `Stop` — only has `last_assistant_message`
- `PostToolUse` on all non-Agent tools (Bash, Write, Read, Edit, etc.)
- `SessionStart` / `SessionEnd`
- All async events

This means hook-based telemetry captures subagent dispatch token spend only. A session using the orchestrator directly without spawning subagents will show zero tokens in fathom. This is a ceiling in the hook API, not a gap in fathom's implementation.

---

## Agent Tool — Token Data (Empirical, Spike 2026-04-14)

**The subagent dispatch tool is named `"Agent"`, not `"Task"`.**

A PostToolUse hook on the `"Agent"` tool receives:

```json
{
  "hook_event_name": "PostToolUse",
  "tool_name": "Agent",
  "tool_input": {
    "description": "the agent description string",
    "prompt": "the full prompt sent to the agent"
  },
  "tool_response": {
    "status": "completed",
    "prompt": "echo of the prompt",
    "agentId": "ae073e850dc4aeefb",
    "agentType": "general-purpose",
    "content": [
      { "type": "text", "text": "<full agent output here>" }
    ],
    "totalDurationMs": 1378,
    "totalTokens": 9420,
    "totalToolUseCount": 0,
    "usage": {
      "input_tokens": 3,
      "cache_creation_input_tokens": 0,
      "cache_read_input_tokens": 9394,
      "output_tokens": 23,
      "server_tool_use": { "web_search_requests": 0, "web_fetch_requests": 0 },
      "service_tier": "standard",
      "cache_creation": { "ephemeral_1h_input_tokens": 0, "ephemeral_5m_input_tokens": 0 },
      "iterations": [
        {
          "input_tokens": 3,
          "output_tokens": 23,
          "cache_read_input_tokens": 9394,
          "cache_creation_input_tokens": 0,
          "type": "message"
        }
      ]
    }
  }
}
```

**The `"Task"` matcher fires on task tracker tools** (`TaskCreate`, `TaskUpdate`, etc.), not on subagent spawning. Do not use `"Task"` to intercept subagent output.

---

## Transcript File Format (Empirical — Undocumented)

> **Warning:** This format is not documented by Anthropic. It is Claude Code's internal conversation log. It may change in any release without notice. Everything here is derived from observation of `~/.claude/projects/<slug>/<session_id>.jsonl` files.

The transcript referenced by `transcript_path` in hook payloads is a JSONL file. Each line is one entry. Entry types observed:

| `type` | Description |
|---|---|
| `user` | A user turn. Contains `message`, `sessionId`, `cwd`, `version`, `gitBranch`. |
| `assistant` | An assistant turn. Contains `message.usage` with full token breakdown (see below). |
| `system` | Internal metadata. Subtypes include `turn_duration`, `local_command`, `away_summary`. |
| `attachment` | Tool input/output pairs attached to turns. |
| `file-history-snapshot` | Snapshot of file state for context. |

### assistant entry — token data

```json
{
  "type": "assistant",
  "uuid": "...",
  "sessionId": "...",
  "message": {
    "model": "claude-sonnet-4-6",
    "usage": {
      "input_tokens": 2,
      "cache_creation_input_tokens": 24137,
      "cache_read_input_tokens": 0,
      "output_tokens": 196,
      "server_tool_use": { "web_search_requests": 0, "web_fetch_requests": 0 },
      "service_tier": "standard",
      "cache_creation": {
        "ephemeral_1h_input_tokens": 24137,
        "ephemeral_5m_input_tokens": 0
      },
      "iterations": [ ... ]
    }
  }
}
```

Each `assistant` entry has a unique `uuid`. Deduplication by `uuid` confirmed safe in sampled transcripts (440 lines, 148 assistant entries, 0 duplicate UUIDs).

### system / turn_duration entry

Written after each turn completes. Provides wall time and message count at that point in the conversation.

```json
{
  "type": "system",
  "subtype": "turn_duration",
  "durationMs": 73321,
  "messageCount": 202,
  "sessionId": "...",
  "timestamp": "2026-04-20T05:48:50.777Z"
}
```

### What transcript reading would enable (and why fathom doesn't do it)

Reading the transcript at `Stop` could provide complete per-session token totals (orchestrator + subagents) by summing `message.usage` across all `assistant` entries, deduplicating by `uuid`. This closes the token coverage gap.

Fathom does not do this because the format is entirely undocumented and could silently break on any Claude Code update. The correct fix is for Anthropic to expose session token totals on the `Stop` hook event directly. In the meantime, fathom's token tracking is scoped to subagent dispatch spend and documented as such.

---

## Blocking Mechanism — PreToolUse

**Exit code 2 (simplest):**
```bash
echo "Scope violation: write to $file_path not in declared scope" >&2
exit 2
```
stderr content is sent to Claude as feedback. Tool call is denied.

**JSON deny (structured):**
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Write path outside declared executor scope"
  }
}
```
Exit 0 with this stdout. Reason is sent to Claude.

**JSON allow (skip permission prompt):**
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow"
  }
}
```

**PostToolUse decision injection:**
```json
{
  "decision": "block",
  "reason": "Executor output missing required frontmatter fields: status, artifacts"
}
```
PostToolUse cannot undo execution, but `decision: block` injects feedback into Claude's context and stops the orchestrator from proceeding.

---

## Hook Scoping

Hooks are scoped by matcher in `settings.json`:

```json
{ "matcher": "Write" }          // exact tool name
{ "matcher": "Write|Edit" }     // pipe-separated exact names
{ "matcher": "^Notebook" }      // regex (any non-word char triggers regex mode)
{ "matcher": "" }               // all events
{ "matcher": "*" }              // all events
```

Fine-grained filtering with `if` field (Claude Code v2.1.85+):
```json
{
  "matcher": "Write",
  "hooks": [
    {
      "type": "command",
      "if": "Write(!src/**)",
      "command": "./check-scope.sh"
    }
  ]
}
```
The `if` field prevents process spawn when the condition doesn't match. Use this for performance-sensitive hooks.

---

## Execution Model

- **Type**: Shell command (user's default shell)
- **Working directory**: `cwd` from hook input
- **stdin**: hook JSON payload
- **stdout**: reserved for JSON control output; non-JSON is ignored
- **stderr**: error/warning messages; shown in transcript or debug log
- **Timeout**: 600s default, configurable per hook with `timeout` field (seconds)
- **Parallel execution**: multiple hooks for the same event run concurrently; identical commands deduplicated; most restrictive decision wins
- **Shell overhead**: hooks source user profile on spawn (~100ms if profile is heavy); unconditional profile output can break JSON parsing

**Environment variables available in hooks:**

| Variable | Description |
|---|---|
| `$CLAUDE_PROJECT_DIR` | Absolute project root |
| `$CLAUDE_ENV_FILE` | Path to a file for persisting env vars across hooks within a session (SessionStart, CwdChanged, FileChanged only) |
| `$CLAUDE_CODE_REMOTE` | `"true"` when running in the web environment |
| `${CLAUDE_PLUGIN_ROOT}` | Plugin installation directory |
| `${CLAUDE_PLUGIN_DATA}` | Plugin persistent data directory |

