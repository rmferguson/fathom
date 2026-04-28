#!/usr/bin/env node
import * as path from "path";
import { execSync } from "child_process";
import { Command } from "commander";
import { readEvents, aggregate, filterByProject, SINK_PATH } from "../aggregator";
import { FathomEvent } from "../schema/v1";
import { runInstall, runUninstall } from "../install";

/**
 * Thrown by resolveProject() when --project is set to a value that matches no
 * recorded events. Caught at the action handler so commands can fail cleanly
 * with a non-zero exit without process.exit() inside library code (which would
 * make resolveProject untestable).
 */
export class ProjectNotFoundError extends Error {
  constructor(message: string, readonly knownDirs: string[]) {
    super(message);
    this.name = "ProjectNotFoundError";
  }
}

let _cachedProjectDir: string | undefined;
function currentProjectDir(): string {
  // Memoize: shell-execing git on every CLI invocation is wasteful and the
  // cwd cannot change within a single CLI process. FATHOM_PROJECT lets users
  // override entirely, skipping the git subprocess.
  if (_cachedProjectDir !== undefined) return _cachedProjectDir;
  if (process.env.FATHOM_PROJECT) {
    _cachedProjectDir = process.env.FATHOM_PROJECT;
    return _cachedProjectDir;
  }
  try {
    _cachedProjectDir = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  } catch {
    _cachedProjectDir = process.cwd();
  }
  return _cachedProjectDir;
}

export function resolveProject(
  allEvents: FathomEvent[],
  query: string
): { events: FathomEvent[]; label: string } {
  const normalized = query.replace(/\/$/, "");
  const knownDirs = [...new Set(allEvents.map((e) => e.project_dir).filter(Boolean))];

  // Exact path match
  if (knownDirs.includes(normalized)) {
    return { events: filterByProject(allEvents, normalized), label: normalized };
  }

  // Basename match (e.g. "fathom" → "/home/user/projects/side/fathom")
  const matches = knownDirs.filter((d) => path.basename(d) === normalized);
  if (matches.length === 1) {
    return { events: filterByProject(allEvents, matches[0]), label: matches[0] };
  }
  if (matches.length > 1) {
    const filtered = allEvents.filter((e) => matches.includes(e.project_dir));
    return { events: filtered, label: matches.join(", ") };
  }

  throw new ProjectNotFoundError(`No project matching "${query}" found.`, knownDirs);
}

/**
 * Filter events to those whose timestamp falls inside [since, until].
 * Bounds are ISO 8601 strings; either may be undefined (open-ended).
 * Used by all CLI commands that accept --since/--until.
 */
export function filterByTimeRange(
  events: FathomEvent[],
  since?: string,
  until?: string
): FathomEvent[] {
  if (!since && !until) return events;
  const sinceMs = since ? Date.parse(since) : -Infinity;
  const untilMs = until ? Date.parse(until) : Infinity;
  if (Number.isNaN(sinceMs)) throw new Error(`Invalid --since value: ${since}`);
  if (Number.isNaN(untilMs)) throw new Error(`Invalid --until value: ${until}`);
  return events.filter((e) => {
    const ts = Date.parse(e.timestamp);
    return ts >= sinceMs && ts <= untilMs;
  });
}

interface LoadOpts { all?: boolean; project?: string; since?: string; until?: string }

// Cache readEvents() result for the lifetime of the CLI process so commands
// that call loadEvents() multiple times don't re-read the JSONL each time.
let _cachedEvents: FathomEvent[] | undefined;
async function loadAllEventsCached(): Promise<FathomEvent[]> {
  if (_cachedEvents !== undefined) return _cachedEvents;
  _cachedEvents = await readEvents();
  return _cachedEvents;
}

async function loadEvents({ all, project, since, until }: LoadOpts) {
  const allEvents = await loadAllEventsCached();
  let scoped: FathomEvent[];
  let projectLabel: string | null;
  if (all) {
    scoped = allEvents;
    projectLabel = null;
  } else if (project) {
    const { events, label } = resolveProject(allEvents, project);
    scoped = events;
    projectLabel = label;
  } else {
    const projectDir = currentProjectDir();
    scoped = filterByProject(allEvents, projectDir);
    projectLabel = projectDir;
  }
  scoped = filterByTimeRange(scoped, since, until);
  return { events: scoped, projectLabel };
}

/**
 * Parse the --count flag value as a positive integer. Returns the default when
 * the flag is missing or invalid (with a stderr warning). The previous
 * implementation used parseInt() unguarded, which let "abc" → NaN flow into
 * Array.prototype.slice(0, NaN) and silently return the entire list.
 */
export function parseCount(value: string | undefined, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    console.error(`Invalid --count value "${value}"; using default ${defaultValue}.`);
    return defaultValue;
  }
  return n;
}

const { version: pkgVersion } = require("../../package.json") as { version: string };

const program = new Command();

program
  .name("fathom")
  .description("Hooks-based telemetry for Claude Code sessions")
  .version(pkgVersion);

/**
 * Wraps an action handler so library exceptions (ProjectNotFoundError, bad
 * --since/--until) become a clean stderr message and exit 1, never a stack
 * trace. Keeps process.exit out of library functions; only the top-level
 * action layer gets to terminate the process.
 */
function runAction(fn: (opts: Record<string, unknown>) => Promise<void> | void) {
  return async (opts: Record<string, unknown>) => {
    try {
      await fn(opts);
    } catch (e) {
      if (e instanceof ProjectNotFoundError) {
        console.error(e.message);
        console.error(
          `Known projects:\n${e.knownDirs.map((d) => `  ${d}`).join("\n") || "  (none)"}`
        );
        process.exitCode = 1;
        return;
      }
      console.error((e as Error).message ?? String(e));
      process.exitCode = 1;
    }
  };
}

program
  .command("summary")
  .description("Show stats for the most recent session")
  .option("--all", "Include all projects")
  .option("--project <name>", "Filter by project name or path")
  .option("--since <iso>", "Only include events at or after this ISO timestamp")
  .option("--until <iso>", "Only include events at or before this ISO timestamp")
  .option("--json", "Emit machine-readable JSON instead of formatted text")
  .action(runAction(async (opts) => {
    const { events, projectLabel } = await loadEvents(opts as LoadOpts);
    if (events.length === 0) {
      if (opts.json) console.log(JSON.stringify({ session: null, projectLabel }));
      else console.log("No events recorded yet. Run: fathom install");
      return;
    }
    const { sessions } = aggregate(events);
    const last = sessions[0];
    if (!last) {
      if (opts.json) console.log(JSON.stringify({ session: null, projectLabel }));
      else console.log("No sessions found.");
      return;
    }

    if (opts.json) {
      const topTools = Object.entries(last.tool_calls)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .map(([tool, count]) => ({ tool, count }));
      console.log(JSON.stringify({ session: last, top_tools: topTools, projectLabel }, null, 2));
      return;
    }

    const durationStr = last.wall_time_ms
      ? `${(last.wall_time_ms / 60000).toFixed(1)}m`
      : "unknown";

    const topTools = Object.entries(last.tool_calls)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5);

    if (projectLabel) console.log(`\nProject: ${projectLabel}`);
    console.log(`\nSession: ${last.session_id.slice(0, 8)}...`);
    console.log(`Started: ${last.started_at}`);
    console.log(`Duration: ${durationStr}`);
    console.log(`\nTokens`);
    console.log(`  Total:        ${last.total_tokens.toLocaleString()}`);
    console.log(`  Input:        ${last.input_tokens.toLocaleString()}`);
    console.log(`  Output:       ${last.output_tokens.toLocaleString()}`);
    console.log(`  Cache read:   ${last.cache_read_tokens.toLocaleString()}`);
    console.log(`\nTop tools`);
    for (const [tool, count] of topTools) {
      console.log(`  ${tool.padEnd(20)} ${count}`);
    }
    if (last.cost_usd > 0) {
      console.log(`\nEstimated cost (Agent tool only): $${last.cost_usd.toFixed(4)}`);
    }
    const subagentEntries = Object.values(last.subagents);
    if (subagentEntries.length > 0) {
      console.log(`\nSubagents`);
      for (const sub of subagentEntries.sort((a, b) => b.dispatches - a.dispatches)) {
        console.log(`  ${sub.agent_type.padEnd(20)} ${sub.dispatches} dispatched, ${sub.completions} completed`);
      }
    }
    if (last.errors > 0) {
      console.log(`\nErrors: ${last.errors}`);
    }
  }));

program
  .command("sessions")
  .description("List recent sessions")
  .option("-n, --count <n>", "Number of sessions to show", "10")
  .option("--all", "Include all projects")
  .option("--project <name>", "Filter by project name or path")
  .option("--since <iso>", "Only include events at or after this ISO timestamp")
  .option("--until <iso>", "Only include events at or before this ISO timestamp")
  .action(runAction(async (opts) => {
    const { events, projectLabel } = await loadEvents(opts as LoadOpts);
    if (events.length === 0) {
      console.log("No events recorded yet. Run: fathom install");
      return;
    }
    const { sessions } = aggregate(events);
    const n = parseCount(opts.count as string | undefined, 10);

    if (projectLabel) console.log(`\nProject: ${projectLabel}`);
    console.log(`\n${"SESSION".padEnd(12)} ${"STARTED".padEnd(24)} ${"TOKENS".padStart(10)} ${"TOOLS".padStart(8)}`);
    console.log("─".repeat(58));

    const shown = sessions.slice(0, n);
    for (const s of shown) {
      const id = s.session_id.slice(0, 8) + "...";
      const toolCount = Object.values(s.tool_calls).reduce((a, b) => a + b, 0);
      console.log(
        `${id.padEnd(12)} ${s.started_at.slice(0, 23).padEnd(24)} ${s.total_tokens.toLocaleString().padStart(10)} ${String(toolCount).padStart(8)}`
      );
    }
    if (sessions.length > shown.length) {
      const hidden = sessions.length - shown.length;
      console.log(`\n... ${hidden} more session${hidden === 1 ? "" : "s"} not shown (total ${sessions.length}). Use -n ${sessions.length} or --count ${sessions.length} to see all.`);
    }
  }));

program
  .command("trend")
  .description("Show token usage trend across sessions")
  .option("--all", "Include all projects")
  .option("--project <name>", "Filter by project name or path")
  .option("--since <iso>", "Only include events at or after this ISO timestamp")
  .option("--until <iso>", "Only include events at or before this ISO timestamp")
  .option("--json", "Emit machine-readable JSON instead of formatted text")
  .action(runAction(async (opts) => {
    const { events, projectLabel } = await loadEvents(opts as LoadOpts);
    if (events.length === 0) {
      if (opts.json) console.log(JSON.stringify({ total_sessions: 0, total_tokens: 0, top_tools: [], projectLabel }));
      else console.log("No events recorded yet. Run: fathom install");
      return;
    }
    const summary = aggregate(events);
    const { total_sessions, total_tokens, total_cost_usd, top_tools, subagent_totals } = summary;

    if (opts.json) {
      const avg = total_sessions > 0 ? Math.round(total_tokens / total_sessions) : 0;
      console.log(JSON.stringify({
        total_sessions,
        total_tokens,
        avg_tokens_per_session: avg,
        total_cost_usd,
        top_tools: top_tools.slice(0, 8),
        subagent_totals,
        projectLabel,
      }, null, 2));
      return;
    }

    if (projectLabel) console.log(`\nProject: ${projectLabel}`);
    console.log(`\nAll-time across ${total_sessions} sessions`);
    console.log(`  Total tokens:  ${total_tokens.toLocaleString()}`);
    if (total_sessions > 0) {
      console.log(`  Avg per session: ${Math.round(total_tokens / total_sessions).toLocaleString()}`);
    }
    if (total_cost_usd > 0) {
      console.log(`  Estimated cost (Agent tool only): $${total_cost_usd.toFixed(4)}`);
    }
    console.log(`\nTop tools (all-time)`);
    for (const { tool, count } of top_tools.slice(0, 8)) {
      console.log(`  ${tool.padEnd(20)} ${count}`);
    }
    const subEntries = Object.values(subagent_totals);
    if (subEntries.length > 0) {
      console.log(`\nSubagents (all-time)`);
      for (const sub of subEntries.sort((a, b) => b.dispatches - a.dispatches)) {
        console.log(`  ${sub.agent_type.padEnd(20)} ${sub.dispatches} dispatched, ${sub.completions} completed`);
      }
    }
  }));

program
  .command("export")
  .description("Export raw events as JSON")
  .option("--format <fmt>", "Output format: json|jsonl", "jsonl")
  .option("--all", "Include all projects")
  .option("--project <name>", "Filter by project name or path")
  .option("--since <iso>", "Only include events at or after this ISO timestamp")
  .option("--until <iso>", "Only include events at or before this ISO timestamp")
  .action(runAction(async (opts) => {
    const { events } = await loadEvents(opts as LoadOpts);
    if (opts.format === "json") {
      console.log(JSON.stringify(events, null, 2));
    } else {
      for (const e of events) {
        console.log(JSON.stringify(e));
      }
    }
  }));

program
  .command("projects")
  .description("List all projects that have recorded events")
  .action(async () => {
    const events = await readEvents();
    const dirs = [...new Set(events.map((e) => e.project_dir).filter(Boolean))].sort();
    if (dirs.length === 0) {
      console.log("No projects recorded yet.");
      return;
    }
    for (const d of dirs) {
      console.log(d);
    }
  });

program
  .command("install")
  .description("Register fathom hook handlers in Claude Code settings")
  .option("--local", "Install to .claude/settings.local.json in cwd instead of ~/.claude/settings.json")
  .action((opts) => {
    runInstall(opts.local ?? false);
  });

program
  .command("uninstall")
  .description("Remove fathom hook handlers from Claude Code settings")
  .option("--local", "Uninstall from .claude/settings.local.json in cwd instead of ~/.claude/settings.json")
  .action((opts) => {
    runUninstall(opts.local ?? false);
  });

// Allow importing this module from tests without auto-parsing argv. Skip the
// CLI dispatch when loaded via `import` (require.main !== module) or when the
// FATHOM_NO_AUTORUN escape hatch is set.
if (
  typeof require !== "undefined" &&
  require.main === module &&
  !process.env.FATHOM_NO_AUTORUN
) {
  program.parse();
}

// Test-only: lets vitest reset the readEvents cache between cases.
export function _resetCachesForTest() {
  _cachedEvents = undefined;
  _cachedProjectDir = undefined;
}

export { program };
