#!/usr/bin/env node
import * as path from "path";
import { execSync } from "child_process";
import { Command } from "commander";
import { readEvents, aggregate, filterByProject, SINK_PATH } from "../aggregator";
import { FathomEvent } from "../schema/v1";
import { runInstall, runUninstall } from "../install";

function currentProjectDir(): string {
  try {
    return execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  } catch {
    return process.cwd();
  }
}

function resolveProject(
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

  console.error(`No project matching "${query}" found.`);
  console.error(`Known projects:\n${knownDirs.map((d) => `  ${d}`).join("\n") || "  (none)"}`);
  process.exit(1);
}

interface LoadOpts { all?: boolean; project?: string }

async function loadEvents({ all, project }: LoadOpts) {
  const allEvents = await readEvents();
  if (all) return { events: allEvents, projectLabel: null };
  if (project) {
    const { events, label } = resolveProject(allEvents, project);
    return { events, projectLabel: label };
  }
  const projectDir = currentProjectDir();
  return { events: filterByProject(allEvents, projectDir), projectLabel: projectDir };
}

const program = new Command();

program
  .name("fathom")
  .description("Hooks-based telemetry for Claude Code sessions")
  .version("0.1.0");

program
  .command("summary")
  .description("Show stats for the most recent session")
  .option("--all", "Include all projects")
  .option("--project <name>", "Filter by project name or path")
  .action(async (opts) => {
    const { events, projectLabel } = await loadEvents(opts);
    if (events.length === 0) {
      console.log("No events recorded yet. Run: fathom install");
      return;
    }
    const { sessions } = aggregate(events);
    const last = sessions[0];
    if (!last) {
      console.log("No sessions found.");
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
    if (last.errors > 0) {
      console.log(`\nErrors: ${last.errors}`);
    }
  });

program
  .command("sessions")
  .description("List recent sessions")
  .option("-n, --count <n>", "Number of sessions to show", "10")
  .option("--all", "Include all projects")
  .option("--project <name>", "Filter by project name or path")
  .action(async (opts) => {
    const { events, projectLabel } = await loadEvents(opts);
    if (events.length === 0) {
      console.log("No events recorded yet. Run: fathom install");
      return;
    }
    const { sessions } = aggregate(events);
    const n = parseInt(opts.count, 10);

    if (projectLabel) console.log(`\nProject: ${projectLabel}`);
    console.log(`\n${"SESSION".padEnd(12)} ${"STARTED".padEnd(24)} ${"TOKENS".padStart(10)} ${"TOOLS".padStart(8)}`);
    console.log("─".repeat(58));

    for (const s of sessions.slice(0, n)) {
      const id = s.session_id.slice(0, 8) + "...";
      const toolCount = Object.values(s.tool_calls).reduce((a, b) => a + b, 0);
      console.log(
        `${id.padEnd(12)} ${s.started_at.slice(0, 23).padEnd(24)} ${s.total_tokens.toLocaleString().padStart(10)} ${String(toolCount).padStart(8)}`
      );
    }
  });

program
  .command("trend")
  .description("Show token usage trend across sessions")
  .option("--all", "Include all projects")
  .option("--project <name>", "Filter by project name or path")
  .action(async (opts) => {
    const { events, projectLabel } = await loadEvents(opts);
    if (events.length === 0) {
      console.log("No events recorded yet. Run: fathom install");
      return;
    }
    const { sessions, total_sessions, total_tokens, top_tools } = aggregate(events);

    if (projectLabel) console.log(`\nProject: ${projectLabel}`);
    console.log(`\nAll-time across ${total_sessions} sessions`);
    console.log(`  Total tokens:  ${total_tokens.toLocaleString()}`);
    console.log(`  Avg per session: ${Math.round(total_tokens / total_sessions).toLocaleString()}`);
    console.log(`\nTop tools (all-time)`);
    for (const { tool, count } of top_tools.slice(0, 8)) {
      console.log(`  ${tool.padEnd(20)} ${count}`);
    }
  });

program
  .command("export")
  .description("Export raw events as JSON")
  .option("--format <fmt>", "Output format: json|jsonl", "jsonl")
  .option("--all", "Include all projects")
  .option("--project <name>", "Filter by project name or path")
  .action(async (opts) => {
    const { events } = await loadEvents(opts);
    if (opts.format === "json") {
      console.log(JSON.stringify(events, null, 2));
    } else {
      for (const e of events) {
        console.log(JSON.stringify(e));
      }
    }
  });

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

program.parse();
