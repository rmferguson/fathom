# fathom

Hooks-based telemetry CLI for Claude Code. Part of the [Aquarium](https://github.com/aquarium-tools) suite.

**npm package:** `@aquarium-tools/fathom`  
**CLI command:** `fathom`

## What This Is

A standalone, locally-deployed observability harness for Claude Code sessions. Captures token usage, task duration, tool call patterns, and cost signals via Claude Code's hook event system. No server required, all data stays local.

This is workflow telemetry — not model telemetry. It captures what Claude Code hooks expose (tool calls, subagent dispatches, turn duration) rather than raw API prompt/completion pairs.

## Structure

```
src/hooks/capture.ts  Layer 1 — Claude Code hook handler (Node stdlib only, must be fast)
src/schema/v1.ts      Normalized event schema — the contract between layers
src/aggregator/       Layer 2 — reads events.jsonl, computes metrics
src/cli/              Layer 3 — fathom summary | sessions | trend | export
scripts/install.ts    Registers hook handlers in Claude Code settings
docs/hook-reference.md  Verified Claude Code hook API reference (empirical, 2026-04-14)
examples/             Sample hook event payloads for testing
```

## Key Constraints

- **capture.ts must never block Claude Code** — always exits 0, swallows all exceptions
- **capture.ts uses Node stdlib only** — no npm dependencies; it runs as a compiled dist/hooks/capture.js
- **Schema versioning is load-bearing** — every event carries `schema_version`; consumers pin to a version range
- **Enforcement hooks are not here** — this package is instrumentation only; enforcement hooks belong in the consuming application

## Install

```bash
npm install -g @aquarium-tools/fathom
fathom install              # global ~/.claude/settings.json
fathom install --local      # project-local .claude/settings.local.json
```

## Commands

```
fathom summary      Last session: tokens, duration, top tools
fathom sessions     List recent sessions with key stats
fathom trend        All-time token and tool usage trends
fathom export       Dump raw events as JSON or JSONL
fathom install      Register hook handlers
```

## Data

Events sink: `~/.fathom/events.jsonl`  
Override: `FATHOM_SINK=/path/to/file`  
Disable without uninstalling: `FATHOM_OFF=1`

## Relationship to AI Firm

AI Firm consumes fathom as a dependency (or bundles it). Enforcement hooks (scope boundary checks, subagent output validation) remain in AI Firm's own settings.json. Instrumentation hooks (token tracking, tool logging, session timing) are registered by fathom.

## Task Tracker

task-tracker: beads
