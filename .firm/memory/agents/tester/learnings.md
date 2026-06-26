# Learnings: tester

## Codebase Patterns
- Test framework is Vitest; run with `npm test` or `vitest run`
- Test files colocated with source: `src/hooks/capture.test.ts`, `src/aggregator/index.test.ts`, `src/cli/index.test.ts`
- `examples/` contains sample hook event payloads — useful fixtures for unit tests
- `src/install.test.ts` exists at top of src for install script coverage

## Gotchas
- `capture.ts` must never throw or block — tests should verify error-swallowing behavior, not just happy path
- Hook payloads vary by event type (Stop vs SessionEnd vs SubagentStop) — check `examples/` for payload shapes before writing assertions
- `async_launched` status must not be treated as a test failure in tool_response assertions

## Preferences
- (none yet)

## Cross-Agent Notes
- (none yet)
