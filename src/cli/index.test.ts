import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import {
  resolveProject,
  filterByTimeRange,
  parseCount,
  ProjectNotFoundError,
} from "./index";
import { FathomEvent } from "../schema/v1";

const CLI_PATH = path.resolve(__dirname, "index.ts");

/** Run the fathom CLI in a subprocess with an isolated sink and project dir. */
function runCli(args: string[], opts: { sink: string; project?: string } = { sink: "" }) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FATHOM_SINK: opts.sink,
    PATH: process.env.PATH,
  };
  if (opts.project) env.FATHOM_PROJECT = opts.project;
  // tsx is a devDependency; use the local binary.
  const tsxBin = path.resolve(__dirname, "../../node_modules/.bin/tsx");
  return spawnSync(tsxBin, [CLI_PATH, ...args], { env, encoding: "utf8" });
}

function makeEvent(
  overrides: { event_type: FathomEvent["event_type"] } & Partial<FathomEvent>
): FathomEvent {
  return {
    schema_version: "1.0.0",
    session_id: "sess-001",
    project_dir: "/home/user/projects/myapp",
    timestamp: "2026-04-21T10:00:00Z",
    payload: {},
    ...overrides,
  } as FathomEvent;
}

describe("resolveProject", () => {
  const events = [
    makeEvent({ event_type: "session_start", project_dir: "/home/user/projects/alpha" }),
    makeEvent({ event_type: "session_start", project_dir: "/home/user/projects/beta" }),
    makeEvent({ event_type: "session_start", project_dir: "/work/teamA/alpha" }),
  ];

  it("matches an exact path", () => {
    const r = resolveProject(events, "/home/user/projects/alpha");
    expect(r.label).toBe("/home/user/projects/alpha");
    expect(r.events).toHaveLength(1);
  });

  it("strips trailing slash from query", () => {
    const r = resolveProject(events, "/home/user/projects/alpha/");
    expect(r.events).toHaveLength(1);
  });

  it("matches a unique basename", () => {
    const r = resolveProject(events, "beta");
    expect(r.label).toBe("/home/user/projects/beta");
    expect(r.events).toHaveLength(1);
  });

  it("returns all matches when basename is ambiguous", () => {
    const r = resolveProject(events, "alpha");
    expect(r.events).toHaveLength(2);
    expect(r.label).toContain("alpha");
  });

  it("throws ProjectNotFoundError when nothing matches", () => {
    let err: unknown;
    try {
      resolveProject(events, "doesnotexist");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProjectNotFoundError);
    const knownDirs = (err as ProjectNotFoundError).knownDirs;
    expect(knownDirs).toContain("/home/user/projects/alpha");
    expect(knownDirs).toContain("/work/teamA/alpha");
  });
});

describe("filterByTimeRange", () => {
  const events = [
    makeEvent({ event_type: "session_start", timestamp: "2026-04-20T10:00:00Z" }),
    makeEvent({ event_type: "session_start", timestamp: "2026-04-21T10:00:00Z" }),
    makeEvent({ event_type: "session_start", timestamp: "2026-04-22T10:00:00Z" }),
  ];

  it("returns all events when no bounds are given", () => {
    expect(filterByTimeRange(events)).toHaveLength(3);
  });

  it("respects --since (inclusive)", () => {
    const r = filterByTimeRange(events, "2026-04-21T00:00:00Z");
    expect(r).toHaveLength(2);
  });

  it("respects --until (inclusive)", () => {
    const r = filterByTimeRange(events, undefined, "2026-04-21T10:00:00Z");
    expect(r).toHaveLength(2);
  });

  it("respects both bounds", () => {
    const r = filterByTimeRange(events, "2026-04-21T00:00:00Z", "2026-04-21T23:59:59Z");
    expect(r).toHaveLength(1);
  });

  it("throws on invalid --since", () => {
    expect(() => filterByTimeRange(events, "not-a-date")).toThrow(/Invalid --since/);
  });

  it("throws on invalid --until", () => {
    expect(() => filterByTimeRange(events, undefined, "garbage")).toThrow(/Invalid --until/);
  });
});

describe("parseCount", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("returns the default when value is undefined", () => {
    expect(parseCount(undefined, 10)).toBe(10);
    expect(warn).not.toHaveBeenCalled();
  });

  it("parses a valid positive integer", () => {
    expect(parseCount("5", 10)).toBe(5);
  });

  it("falls back to default and warns on NaN", () => {
    expect(parseCount("abc", 10)).toBe(10);
    expect(warn).toHaveBeenCalled();
  });

  it("falls back on negative values", () => {
    expect(parseCount("-3", 10)).toBe(10);
    expect(warn).toHaveBeenCalled();
  });

  it("falls back on zero", () => {
    expect(parseCount("0", 10)).toBe(10);
    expect(warn).toHaveBeenCalled();
  });

  it("falls back on a float", () => {
    expect(parseCount("3.5", 10)).toBe(10);
    expect(warn).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// CLI integration tests — spawn the actual CLI in a subprocess against an
// isolated sink populated with synthetic events. Slower than unit tests but
// the only way to exercise the commander wiring + I/O end-to-end.
// ---------------------------------------------------------------------------

describe("fathom CLI (integration)", () => {
  let tmpDir: string;
  let sink: string;
  const PROJECT = "/test/proj";

  function writeEvents(events: Partial<FathomEvent>[]) {
    const lines = events.map((e) => JSON.stringify({
      schema_version: "1.0.0",
      session_id: "sess-1",
      project_dir: PROJECT,
      timestamp: "2026-04-21T10:00:00Z",
      payload: {},
      ...e,
    }));
    fs.writeFileSync(sink, lines.join("\n") + "\n");
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fathom-cli-"));
    sink = path.join(tmpDir, "events.jsonl");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("summary: empty sink prints install hint and exits 0", () => {
    fs.writeFileSync(sink, "");
    const r = runCli(["summary"], { sink, project: PROJECT });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("No events recorded yet");
  });

  it("summary: prints session id, tokens, and top tools", () => {
    writeEvents([
      { event_type: "session_start", timestamp: "2026-04-21T10:00:00Z", payload: { cwd: "/x", permission_mode: "default" } },
      { event_type: "tool_use", timestamp: "2026-04-21T10:01:00Z", payload: { tool_name: "Bash", tool_use_id: "1", success: true } },
      { event_type: "tool_use", timestamp: "2026-04-21T10:02:00Z", payload: { tool_name: "Bash", tool_use_id: "2", success: true } },
      { event_type: "tool_use", timestamp: "2026-04-21T10:03:00Z", payload: { tool_name: "Read", tool_use_id: "3", success: true } },
      { event_type: "session_end", timestamp: "2026-04-21T10:05:00Z", payload: { cwd: "/x", hook_source: "Stop", last_assistant_message: "done" } },
    ]);
    const r = runCli(["summary"], { sink, project: PROJECT });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Session: sess-1");
    expect(r.stdout).toContain("Bash");
    expect(r.stdout).toContain("Read");
    expect(r.stdout).toContain("Duration: 5.0m");
  });

  it("summary --json: emits parseable JSON", () => {
    writeEvents([
      { event_type: "session_start", timestamp: "2026-04-21T10:00:00Z", payload: { cwd: "/x", permission_mode: "default" } },
      { event_type: "tool_use", timestamp: "2026-04-21T10:01:00Z", payload: { tool_name: "Bash", tool_use_id: "1", success: true } },
    ]);
    const r = runCli(["summary", "--json"], { sink, project: PROJECT });
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.session.session_id).toBe("sess-1");
    expect(parsed.top_tools[0]).toEqual({ tool: "Bash", count: 1 });
  });

  it("sessions: lists all sessions and shows truncation hint", () => {
    const events: Partial<FathomEvent>[] = [];
    for (let i = 0; i < 12; i++) {
      events.push({
        event_type: "session_start",
        session_id: `sess-${String(i).padStart(2, "0")}`,
        timestamp: `2026-04-${String(10 + i).padStart(2, "0")}T10:00:00Z`,
        payload: { cwd: "/x", permission_mode: "default" },
      });
    }
    writeEvents(events);
    const r = runCli(["sessions", "-n", "5"], { sink, project: PROJECT });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("... 7 more session");
    expect(r.stdout).toContain("total 12");
  });

  it("sessions: invalid --count falls back to default with warning", () => {
    writeEvents([
      { event_type: "session_start", timestamp: "2026-04-21T10:00:00Z", payload: { cwd: "/x", permission_mode: "default" } },
    ]);
    const r = runCli(["sessions", "-n", "abc"], { sink, project: PROJECT });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("Invalid --count value");
  });

  it("trend --json: includes total_cost_usd and subagent_totals", () => {
    writeEvents([
      { event_type: "subagent_start", payload: { agent_id: "a-1", agent_type: "general-purpose" } },
      { event_type: "subagent_stop",  payload: { agent_id: "a-1", agent_type: "general-purpose" } },
      { event_type: "tool_use", payload: {
        tool_name: "Agent", tool_use_id: "1", success: true,
        input_tokens: 1_000_000, output_tokens: 0,
      } },
    ]);
    const r = runCli(["trend", "--json"], { sink, project: PROJECT });
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.total_cost_usd).toBeGreaterThan(0);
    expect(parsed.subagent_totals["general-purpose"].dispatches).toBe(1);
  });

  it("export: defaults to JSONL, one event per line", () => {
    writeEvents([
      { event_type: "session_start", timestamp: "2026-04-21T10:00:00Z", payload: { cwd: "/x", permission_mode: "default" } },
      { event_type: "tool_use", timestamp: "2026-04-21T10:01:00Z", payload: { tool_name: "Bash", tool_use_id: "1", success: true } },
    ]);
    const r = runCli(["export"], { sink, project: PROJECT });
    expect(r.status).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).event_type).toBe("session_start");
  });

  it("export --format json: emits a single pretty-printed array", () => {
    writeEvents([
      { event_type: "tool_use", timestamp: "2026-04-21T10:01:00Z", payload: { tool_name: "Bash", tool_use_id: "1", success: true } },
    ]);
    const r = runCli(["export", "--format", "json"], { sink, project: PROJECT });
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
  });

  it("export --since: filters by timestamp", () => {
    writeEvents([
      { event_type: "tool_use", timestamp: "2026-04-20T10:00:00Z", payload: { tool_name: "A", tool_use_id: "1", success: true } },
      { event_type: "tool_use", timestamp: "2026-04-22T10:00:00Z", payload: { tool_name: "B", tool_use_id: "2", success: true } },
    ]);
    const r = runCli(["export", "--since", "2026-04-21T00:00:00Z"], { sink, project: PROJECT });
    expect(r.status).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).payload.tool_name).toBe("B");
  });

  it("--project: unknown project exits non-zero with helpful stderr", () => {
    writeEvents([
      { event_type: "tool_use", payload: { tool_name: "Bash", tool_use_id: "1", success: true } },
    ]);
    const r = runCli(["summary", "--project", "doesnotexist"], { sink, project: PROJECT });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("No project matching");
    expect(r.stderr).toContain("Known projects");
  });

  it("projects: prints recorded project dirs", () => {
    writeEvents([
      { event_type: "tool_use", payload: { tool_name: "B", tool_use_id: "1", success: true }, project_dir: "/a/x" },
      { event_type: "tool_use", payload: { tool_name: "B", tool_use_id: "2", success: true }, project_dir: "/b/y" },
    ]);
    const r = runCli(["projects"], { sink });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("/a/x");
    expect(r.stdout).toContain("/b/y");
  });
});

// ---------------------------------------------------------------------------
// End-to-end: capture → sink → aggregate. Verifies the contract between
// Layer 1 (hook handler) and Layer 2 (aggregator) without going through CLI.
// ---------------------------------------------------------------------------

describe("e2e: capture → sink → aggregate", () => {
  let tmpDir: string;
  let sink: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fathom-e2e-"));
    sink = path.join(tmpDir, "events.jsonl");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("captures a representative session and aggregates correctly", async () => {
    // Use main() directly rather than spawning capture.js, so we exercise the
    // same parse → normalize → write pipeline without process boundary noise.
    const { main } = await import("../hooks/capture");
    const { readEvents, aggregate } = await import("../aggregator");

    const session = "e2e-1";
    const send = (payload: Record<string, unknown>) =>
      main(JSON.stringify({ session_id: session, ...payload }), sink);

    send({ hook_event_name: "SessionStart", cwd: "/proj", permission_mode: "default" });
    send({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "tu-1", tool_input: { command: "ls" } });
    send({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "tu-1", tool_response: { interrupted: false, totalDurationMs: 50 } });
    send({ hook_event_name: "PostToolUse", tool_name: "Agent", tool_use_id: "tu-2", tool_response: {
      status: "completed", totalTokens: 1000, totalDurationMs: 5000,
      usage: { input_tokens: 800, output_tokens: 150, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 },
    } });
    send({ hook_event_name: "SubagentStart", agent_id: "a-1", agent_type: "general-purpose" });
    send({ hook_event_name: "SubagentStop", agent_id: "a-1", agent_type: "general-purpose" });
    send({ hook_event_name: "Stop", cwd: "/proj", last_assistant_message: "done" });
    send({ hook_event_name: "SessionEnd", cwd: "/proj" });

    const events = await readEvents(sink);
    // 1 session_start + 1 pre + 2 post + 2 subagent + 2 session_end = 8
    expect(events).toHaveLength(8);
    const r = aggregate(events);
    expect(r.sessions).toHaveLength(1);
    const s = r.sessions[0];
    expect(s.tool_calls["Bash"]).toBe(1);
    expect(s.tool_calls["Agent"]).toBe(1);
    expect(s.total_tokens).toBe(1000);
    expect(s.subagents["general-purpose"].dispatches).toBe(1);
    expect(s.subagents["general-purpose"].completions).toBe(1);
    expect(s.cost_usd).toBeGreaterThan(0);
    // Session ends were coalesced (Stop + SessionEnd) → only 1 session.
    expect(s.ended_at).toBeDefined();
  });
});
