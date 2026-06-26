# Learnings: backend

## Codebase Patterns
- Hook capture (`src/hooks/capture.ts`) is the hot path — Node stdlib only, must exit 0, no exceptions leak
- Aggregator (`src/aggregator/`) reads from `~/.fathom/events.jsonl` (overridable via `FATHOM_SINK`)
- CLI (`src/cli/`) uses Commander v12; entry point is `src/cli/index.ts` / compiled to `dist/cli/index.js`
- Install script (`src/install.ts`) registers 10 hook event types in Claude Code settings.json
- `FATHOM_OFF=1` env var disables capture without uninstalling

## Gotchas
- Stop hook fires on every turn completion, not just session exit — aggregator must use `coalesceSessionEnds()` taking the *last* Stop as the authoritative session-end marker
- `SessionEndPayload.wall_time_ms` is never populated — derive session duration from timestamp delta
- `async_launched` tool responses are not failures — they indicate background agents dispatched with `run_in_background: true`

## Preferences
- (none yet)

## Cross-Agent Notes
- (none yet)
