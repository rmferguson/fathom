# Changelog

All notable changes to `@aquarium-tools/fathom` are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning follows [Semantic Versioning](https://semver.org/).

---

## [Unreleased] — 1.0.0

First stable release. All changes below constitute the 0.x → 1.0.0 surface.

### Breaking changes

None relative to 0.6.x. The jump to 1.0.0 signals schema stability: the
`schema_version` field is now enforced at read time. Events with a mismatched
major version are quarantined rather than silently misread.

### Added

- **`readEventsWithStats()`** — new aggregator function that returns event counts
  alongside quarantine and malformed-line counts. `readEvents()` is unchanged and
  wraps this for backward compatibility.
- **Schema major-version validation** — `readEventsWithStats()` quarantines events
  whose `schema_version` major component does not match `SCHEMA_VERSION` (currently
  `1`). Events with missing or non-semver schema_version are treated as malformed
  and excluded without crashing.
- **`isSafeTranscriptPath()`** — allow-list guard in capture.ts that restricts
  agent transcript reads to paths under `$HOME` or `os.tmpdir()`. Defense-in-depth
  against crafted paths in the hook payload.
- **`IO_TIMEOUT_MS` constant** — exported from capture.ts. Hard 2-second deadline
  on stdin reads and transcript reads to prevent capture.ts from hanging Claude Code.
- **`fathom session <id>`** — new CLI command that shows full detail for a single
  session by exact or 8-char prefix ID. Supports `--json`, `--timeline`, and `--all`.
- **`fathom sessions --group-by-project`** — rolls up session stats by project into
  one row per project with aggregated totals. Supports `--json`.
- **`fathom sessions --json`** — machine-readable JSON array with `session_id`,
  token counts, and cost estimate per session.
- **Cross-project session view** — `fathom sessions --all` adds a PROJECT column
  and searches events across all projects.
- **Per-subagent token aggregation** — token usage from background agents (dispatched
  via `run_in_background: true`) is read from the agent JSONL transcript at
  SubagentStop time and merged into the session totals.
- **`async_launched` treated as success** — Agent tool responses with
  `status: "async_launched"` are now recorded as `success: true`. Previously they
  were incorrectly marked as failures.
- **`agent_status` on tool_use events** — the raw `tool_response.status` value is
  captured in `ToolUsePayload.agent_status` for Agent tool completions.
- **`hook_source` on session_end events** — distinguishes Stop-hook records from
  SessionEnd-hook records. Enables the aggregator to prefer Stop records (which
  carry `last_assistant_message`) during coalescing.
- **`fathom prune`** — removes old events from the sink by day count
  (`--keep-days N`) or cutoff date (`--before YYYY-MM-DD`). Malformed lines
  are always preserved. Supports `--yes` to skip confirmation.
- **`extra` field on FathomEvent** — captures hook payload keys that fathom has
  no named field for, enabling forward discovery without schema changes.
- **`FATHOM_OFF` kill switch** — setting `FATHOM_OFF=1` causes capture.ts to exit
  immediately without writing, without needing to uninstall hooks.
- **LICENSE and README.md included in npm tarball** — previously only `dist/` was
  shipped.
- **PreCompact hook** — capture.ts now handles the `PreCompact` event type,
  recording a `pre_compact` event for session timeline purposes.

### Fixed

- **`coalesceSessionEnds()` uses last Stop record** — previously took the first Stop
  record; on long sessions many Stop records accumulate and the last one is
  authoritative.
- **Absent `hook_source` treated as Stop** — legacy events written before the
  `hook_source` field was added are now coalesced correctly.
- **`SessionEndPayload.wall_time_ms` never populated** — field is now documented as
  deprecated and always undefined. Session duration is derived from the difference
  between `session_end.timestamp` and `session_start.timestamp`.
- **capture.ts: `null` vs `undefined` on optional fields** — fields absent from the
  hook payload are now `undefined` in the wire schema, not `null`. Affected fields:
  `duration_ms`, `error`, `is_interrupt`, `last_assistant_message`, `message`,
  `level`, `agent_transcript_path`, `stop_hook_active`.
- **Hard I/O timeout on stdin and transcript reads** — a symlink to `/dev/zero` or
  a slow filesystem can no longer hang the capture process. Both reads now race
  against a 2-second deadline.

### Changed

- **`SessionEndPayload.hook_source`** is now `?: "Stop" | "SessionEnd"` (optional)
  in the TypeScript type. The field has always been absent on legacy events;
  the type now reflects that.
- **Sink growth estimate updated** — README now states 100–250 MB/year at ~8
  sessions/day, replacing the unsourced 160 MB/year figure. Measured from
  real dogfooding data (12 days, ~9 sessions/day, 8.3 MB).

### Deprecated

- **`SessionEndPayload.wall_time_ms`** — always `undefined`; retained for forward
  compatibility only. Do not read this field. Derive duration from timestamps.

---

## [0.6.0] — 2026-04-29

- Added per-subagent token aggregation (Gap 1) via transcript parsing at SubagentStop
- Added cross-project session view: `fathom sessions --all` with PROJECT column (Gap 2)
- Added `fathom session <id>` detail command (Gap 3)
- Added `extra` field for forward-discovery of unrecognized hook payload keys
- Fixed session duration and subagent type attribution bugs found in dogfooding
- Captures unrecognized hook fields in `extra`

## [0.5.x / 0.4.x] — 2026-04-28 to 2026-04-29

- Added `fathom prune` command (keep-days and before-date variants)
- Replaced `SINK_PATH` export with `defaultSinkPath()`; clarified cost limits in README
- Integration tests and fix for `readEvents()` honoring `FATHOM_SINK`

## [0.3.0] — 2026-04-27

- Subagent metrics, cost estimation, error deduplication, stdin guard
- `fathom sessions` with project filtering
- `fathom trend` all-time view

## [0.2.0] — 2026-04-27

- CLI hardening and observability flags (`--json`, `--since`, `--until`)
- Dropped Node 18 support (vitest@4 requires Node 20+)

## [0.1.0] — 2026-04-22

Initial release: event capture via Claude Code hooks, `fathom summary`, `fathom trend`,
`fathom export`, `fathom install / uninstall`.

[Unreleased]: https://github.com/aquarium-tools/fathom/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/aquarium-tools/fathom/releases/tag/v0.6.0
