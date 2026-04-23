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
