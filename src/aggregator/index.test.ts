import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readEvents, aggregate, filterByProject } from "./index";
import { FathomEvent } from "../schema/v1";

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

describe("readEvents", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fathom-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("returns empty array for nonexistent sink", async () => {
    expect(await readEvents(path.join(tmpDir, "nope.jsonl"))).toEqual([]);
  });

  it("parses valid events", async () => {
    const p = path.join(tmpDir, "events.jsonl");
    const event = makeEvent({ event_type: "session_start", payload: { cwd: "/tmp", permission_mode: "default" } });
    fs.writeFileSync(p, JSON.stringify(event) + "\n");
    const result = await readEvents(p);
    expect(result).toHaveLength(1);
    expect(result[0].event_type).toBe("session_start");
  });

  it("skips malformed lines without throwing", async () => {
    const p = path.join(tmpDir, "events.jsonl");
    const event = makeEvent({ event_type: "session_start", payload: { cwd: "/tmp", permission_mode: "default" } });
    fs.writeFileSync(p, "{ bad json }\n" + JSON.stringify(event) + "\n");
    const result = await readEvents(p);
    expect(result).toHaveLength(1);
  });
});

describe("filterByProject", () => {
  it("keeps only events matching the project_dir", () => {
    const events = [
      makeEvent({ event_type: "session_start", project_dir: "/home/user/projects/alpha", payload: { cwd: "/home/user/projects/alpha", permission_mode: "default" } }),
      makeEvent({ event_type: "session_start", project_dir: "/home/user/projects/beta",  payload: { cwd: "/home/user/projects/beta",  permission_mode: "default" } }),
    ];
    const result = filterByProject(events, "/home/user/projects/alpha");
    expect(result).toHaveLength(1);
    expect(result[0].project_dir).toBe("/home/user/projects/alpha");
  });

  it("strips trailing slash from filter arg", () => {
    const events = [makeEvent({ event_type: "pre_compact", project_dir: "/home/user/projects/alpha" })];
    expect(filterByProject(events, "/home/user/projects/alpha/")).toHaveLength(1);
  });
});

describe("aggregate", () => {
  it("returns empty summary for no events", () => {
    const r = aggregate([]);
    expect(r.sessions).toHaveLength(0);
    expect(r.total_sessions).toBe(0);
    expect(r.total_tokens).toBe(0);
    expect(r.total_tool_calls).toBe(0);
    expect(r.top_tools).toHaveLength(0);
  });

  it("counts tool calls per tool name", () => {
    const events = [
      makeEvent({ event_type: "tool_use", payload: { tool_name: "Bash", tool_use_id: "1", success: true } }),
      makeEvent({ event_type: "tool_use", payload: { tool_name: "Bash", tool_use_id: "2", success: true } }),
      makeEvent({ event_type: "tool_use", payload: { tool_name: "Read", tool_use_id: "3", success: true } }),
    ];
    const r = aggregate(events);
    expect(r.sessions[0].tool_calls["Bash"]).toBe(2);
    expect(r.sessions[0].tool_calls["Read"]).toBe(1);
    expect(r.total_tool_calls).toBe(3);
  });

  it("sums tokens from tool_use events", () => {
    const events = [
      makeEvent({
        event_type: "tool_use",
        payload: {
          tool_name: "Agent", tool_use_id: "1", success: true,
          total_tokens: 1000, input_tokens: 800, output_tokens: 150, cache_read_tokens: 50,
        },
      }),
    ];
    const r = aggregate(events);
    expect(r.sessions[0].total_tokens).toBe(1000);
    expect(r.sessions[0].input_tokens).toBe(800);
    expect(r.sessions[0].output_tokens).toBe(150);
    expect(r.sessions[0].cache_read_tokens).toBe(50);
    expect(r.total_tokens).toBe(1000);
  });

  it("counts failed tool_use as an error", () => {
    const events = [
      makeEvent({ event_type: "tool_use", payload: { tool_name: "Bash", tool_use_id: "1", success: false } }),
    ];
    expect(aggregate(events).sessions[0].errors).toBe(1);
  });

  it("counts tool_failure events as errors", () => {
    const events = [
      makeEvent({ event_type: "tool_failure", payload: { tool_name: "Bash", tool_use_id: "1", error: "timeout", is_interrupt: false } }),
    ];
    expect(aggregate(events).sessions[0].errors).toBe(1);
  });

  it("derives wall_time_ms from event timestamps", () => {
    const events = [
      makeEvent({ event_type: "session_start", timestamp: "2026-04-21T10:00:00Z", payload: { cwd: "/tmp", permission_mode: "default" } }),
      makeEvent({ event_type: "session_end",   timestamp: "2026-04-21T10:05:00Z", payload: { cwd: "/tmp", hook_source: "Stop", last_assistant_message: null } }),
    ];
    expect(aggregate(events).sessions[0].wall_time_ms).toBe(5 * 60 * 1000);
  });

  it("deduplicates session_end — Stop wins over SessionEnd", () => {
    const events = [
      makeEvent({ event_type: "session_start", timestamp: "2026-04-21T10:00:00Z", payload: { cwd: "/tmp", permission_mode: "default" } }),
      makeEvent({ event_type: "session_end",   timestamp: "2026-04-21T10:05:00Z", payload: { cwd: "/tmp", hook_source: "Stop",       last_assistant_message: "done" } }),
      makeEvent({ event_type: "session_end",   timestamp: "2026-04-21T10:05:01Z", payload: { cwd: "/tmp", hook_source: "SessionEnd", last_assistant_message: null  } }),
    ];
    const r = aggregate(events);
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0].wall_time_ms).toBe(5 * 60 * 1000);
  });

  it("sorts sessions newest-first", () => {
    const events = [
      makeEvent({ event_type: "session_start", session_id: "s-old", timestamp: "2026-04-21T09:00:00Z", payload: { cwd: "/tmp", permission_mode: "default" } }),
      makeEvent({ event_type: "session_start", session_id: "s-new", timestamp: "2026-04-21T10:00:00Z", payload: { cwd: "/tmp", permission_mode: "default" } }),
    ];
    const r = aggregate(events);
    expect(r.sessions[0].session_id).toBe("s-new");
    expect(r.sessions[1].session_id).toBe("s-old");
  });

  it("computes top_tools across sessions", () => {
    const events = [
      makeEvent({ event_type: "tool_use", session_id: "s1", payload: { tool_name: "Bash", tool_use_id: "1", success: true } }),
      makeEvent({ event_type: "tool_use", session_id: "s1", payload: { tool_name: "Read", tool_use_id: "2", success: true } }),
      makeEvent({ event_type: "tool_use", session_id: "s2", payload: { tool_name: "Bash", tool_use_id: "3", success: true } }),
    ];
    const r = aggregate(events);
    expect(r.top_tools[0]).toEqual({ tool: "Bash", count: 2 });
    expect(r.top_tools[1]).toEqual({ tool: "Read", count: 1 });
  });
});
