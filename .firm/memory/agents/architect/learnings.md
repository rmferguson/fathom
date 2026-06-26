# Learnings: architect

## Codebase Patterns
- Three strict layers: Layer 1 = hook capture (Node stdlib only, no npm deps), Layer 2 = aggregator (reads events.jsonl), Layer 3 = CLI commands
- `src/schema/v1.ts` is the contract between layers — every event carries `schema_version`; schema changes require a version bump
- `capture.ts` must always exit 0 and swallow all exceptions — blocking Claude Code is a critical failure

## Gotchas
- `capture.ts` (Layer 1) cannot use npm dependencies; it compiles to `dist/hooks/capture.js` and runs in a minimal environment
- Schema versioning is load-bearing — consumers pin to a version range, so backward-compat matters

## Preferences
- (none yet)

## Cross-Agent Notes
- (none yet)
