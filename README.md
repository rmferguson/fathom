# fathom

[![npm](https://img.shields.io/npm/v/@aquarium-tools/fathom.svg)](https://www.npmjs.com/package/@aquarium-tools/fathom)

## Fathom Your Data

Hooks-based workflow telemetry for [Claude Code](https://claude.ai/code) sessions. Tracks tool invocations, session timing, and subagent dispatches locally.

> **Important Limitation:** Claude Code does not expose per-turn token usage through hooks. Token counts appear only for `Agent` tool completions. For most sessions, token fields will be zero.
> This tool is best used with workflows that routinely dispatch tasks via SubAgents so you can measure the effectiveness of those prompts and supporting files.

## Install

```bash
npm install -g @aquarium-tools/fathom
fathom install              # global ~/.claude/settings.json
fathom install --local      # project-local .claude/settings.local.json
```

After install, fathom hooks fire automatically during every Claude Code session.

## Usage

```bash
$ fathom summary

Project: /home/user/projects/myapp

Session: a3f8b2c1...
Started: 2026-04-21T19:46:00.123
Duration: 14.2m

Tokens
  Total:        0
  Input:        0
  Output:        0
  Cache read:   0

Top tools
  Bash                 34
  Read                 28
  Edit                 12
  Write                 4
  Agent                 2
```

*Reminder*: Token counts populate only when the `Agent` tool is invoked (Claude Code includes usage data in the Agent tool response).

## Commands

```bash
fathom summary      Last session: tool calls, duration, token counts (Agent tool only)
fathom sessions     List recent sessions with tool and timing stats
fathom trend        All-time tool call counts; token totals (Agent tool only)
fathom projects     List all projects that have recorded events
fathom export       Dump raw events as JSON or JSONL
fathom install      Register hook handlers in Claude Code settings
fathom uninstall    Remove hook handlers from Claude Code settings
```

### Project filtering

All commands default to the current git repo. Use flags to change scope:

```bash
fathom summary --project myrepo    # filter by project name or path
fathom summary --all               # all projects
```

### Export

```bash
fathom export                      # JSONL (default)
fathom export --format json        # pretty JSON
fathom export --all --format json > events.json
```

## Data

Events are written to `~/.fathom/events.jsonl` as newline-delimited JSON.

Override the sink path by exporting `FATHOM_SINK` in your shell profile. It must be set in the environment Claude Code inherits — setting it inline for the CLI command only affects reads, not where the hook handler writes events.

```bash
export FATHOM_SINK=/path/to/file    # in ~/.bashrc, ~/.zshrc, etc.
```

Disable without uninstalling:
```bash
export FATHOM_OFF=1
```

Uninstall (removes hooks from settings, leaves event data intact):
```bash
fathom uninstall              # global ~/.claude/settings.json
fathom uninstall --local      # project-local .claude/settings.local.json
```

## Schema versioning

Every event written to the sink carries a `schema_version` field (currently `1.0.0`). Downstream consumers should pin to a major version range and fail fast on a mismatch:

```ts
import type { FathomEvent } from "@aquarium-tools/fathom";

const SUPPORTED_MAJOR = 1;
function check(e: FathomEvent) {
  const major = parseInt(e.schema_version.split(".")[0], 10);
  if (major !== SUPPORTED_MAJOR) {
    throw new Error(`Unsupported fathom schema ${e.schema_version}`);
  }
}
```

Versioning rules fathom commits to:

- **Patch** (`1.0.x`): bug fixes that don't change wire format. Always safe.
- **Minor** (`1.x.0`): additive only. New optional fields, new event types, new payload variants. Existing consumers keep working.
- **Major** (`x.0.0`): breaking. Field removal, renames, or type changes. Consumers must opt in by widening their pinned range.

What this means in practice:

- Treat any field marked optional in `src/schema/v1.ts` as truly optional — it may be absent on older or newer events.
- New `event_type` values may appear within a major version. Use a default branch in your switch statements rather than asserting the union is exhaustive.
- The `hook_source` field on `session_end` events is the contract between fathom's capture and aggregation layers; consumers using `aggregate()` shouldn't need to look at it directly.

## Cost estimation

`fathom summary` and `fathom trend` print an estimated USD cost for Agent-tool usage when token data is present. Defaults assume Claude Sonnet pricing. Override via env vars (USD per 1M tokens):

```bash
export FATHOM_PRICE_INPUT=3
export FATHOM_PRICE_OUTPUT=15
export FATHOM_PRICE_CACHE_READ=0.3
export FATHOM_PRICE_CACHE_WRITE=3.75
```

Cost only reflects Agent-tool spend (the only place hooks expose tokens). Treat it as an order-of-magnitude estimate, not an invoice.

## Time-range filtering

All commands accept ISO 8601 `--since` and `--until` bounds:

```bash
fathom summary --since 2026-04-01T00:00:00Z
fathom trend   --since 2026-04-01 --until 2026-04-21
fathom export  --since 2026-04-21T12:00:00Z --format json
```

## How it works

Fathom is *workflow telemetry*, not model telemetry.

Hooks expose tool invocations, subagent dispatches, and session boundaries, but not main-session token usage or cost. Token counts are only available for `Agent` tool completions, where Claude Code includes usage data in the tool response. Per-turn token data for the top-level session isn't exposed by any hook.

Fathom registers handlers for these Claude Code's events:

- `PostToolUse`
- `PreToolUse`
- `PostToolUseFailure`
- `SessionStart`
- `SessionEnd`
- `Stop`
- `Notification`
- `SubagentStart`
- `SubagentStop`
- `PreCompact`

Where each hook invocation writes one event to the sink, while the CLI reads at query time. There are no background processes, daemons or anything you need to worry about.

## Pairs with

**[Tackline](https://github.com/tyevans/tackline)** — composable Claude Code workflows. Skills like `/blossom`, `/consensus`, and `/premortem` dispatch parallel subagents, which is when fathom's token tracking actually populates. Run `fathom summary` after a heavy session to see where the cost went.

## License

MIT
