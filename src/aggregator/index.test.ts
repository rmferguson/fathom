import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readEvents, aggregate, filterByProject, estimateCost, DEFAULT_COST_RATES } from "./index";
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

  it("does not double-count when tool_use{success:false} and tool_failure share tool_use_id", () => {
    const events = [
      makeEvent({ event_type: "tool_use",     payload: { tool_name: "Bash", tool_use_id: "tu-1", success: false } }),
      makeEvent({ event_type: "tool_failure", payload: { tool_name: "Bash", tool_use_id: "tu-1", error: "interrupted", is_interrupt: true } }),
    ];
    expect(aggregate(events).sessions[0].errors).toBe(1);
  });

  it("counts distinct failed tool_use_ids separately", () => {
    const events = [
      makeEvent({ event_type: "tool_use",     payload: { tool_name: "Bash", tool_use_id: "tu-1", success: false } }),
      makeEvent({ event_type: "tool_failure", payload: { tool_name: "Bash", tool_use_id: "tu-2", error: "x", is_interrupt: false } }),
      makeEvent({ event_type: "tool_failure", payload: { tool_name: "Bash", tool_use_id: "tu-3", error: "y", is_interrupt: false } }),
    ];
    expect(aggregate(events).sessions[0].errors).toBe(3);
  });

  it("aggregates subagent dispatches and completions per agent_type", () => {
    const events = [
      makeEvent({ event_type: "subagent_start", payload: { agent_id: "a-1", agent_type: "general-purpose" } }),
      makeEvent({ event_type: "subagent_start", payload: { agent_id: "a-2", agent_type: "general-purpose" } }),
      makeEvent({ event_type: "subagent_start", payload: { agent_id: "a-3", agent_type: "test-writer" } }),
      makeEvent({ event_type: "subagent_stop",  payload: { agent_id: "a-1", agent_type: "general-purpose" } }),
      makeEvent({ event_type: "subagent_stop",  payload: { agent_id: "a-3", agent_type: "test-writer" } }),
    ];
    const r = aggregate(events);
    expect(r.sessions[0].subagents["general-purpose"]).toEqual({
      agent_type: "general-purpose", dispatches: 2, completions: 1,
    });
    expect(r.sessions[0].subagents["test-writer"]).toEqual({
      agent_type: "test-writer", dispatches: 1, completions: 1,
    });
    expect(r.subagent_totals["general-purpose"].dispatches).toBe(2);
  });

  it("dedupes subagent_start events with same agent_id", () => {
    const events = [
      makeEvent({ event_type: "subagent_start", payload: { agent_id: "a-1", agent_type: "general-purpose" } }),
      makeEvent({ event_type: "subagent_start", payload: { agent_id: "a-1", agent_type: "general-purpose" } }),
    ];
    expect(aggregate(events).sessions[0].subagents["general-purpose"].dispatches).toBe(1);
  });

  it("subagent payload missing agent_type falls into 'unknown' bucket", () => {
    const events = [
      makeEvent({ event_type: "subagent_start", payload: { agent_id: "a-1" } }),
    ];
    expect(aggregate(events).sessions[0].subagents["unknown"].dispatches).toBe(1);
  });

  it("computes cost_usd from Agent tool_use events", () => {
    const events = [
      makeEvent({
        event_type: "tool_use",
        payload: {
          tool_name: "Agent", tool_use_id: "1", success: true,
          input_tokens: 1000, output_tokens: 1000,
          cache_read_tokens: 1000, cache_creation_tokens: 1000,
        },
      }),
    ];
    const r = aggregate(events);
    // 1k input @ $3/1M + 1k output @ $15/1M + 1k cache_read @ $0.30/1M + 1k cache_write @ $3.75/1M
    // = 0.003 + 0.015 + 0.0003 + 0.00375 = 0.02205
    expect(r.sessions[0].cost_usd).toBeCloseTo(0.02205, 5);
    expect(r.total_cost_usd).toBeCloseTo(0.02205, 5);
  });

  it("does not charge cost for non-Agent tool_use events", () => {
    const events = [
      makeEvent({ event_type: "tool_use", payload: { tool_name: "Bash", tool_use_id: "1", success: true, input_tokens: 1000 } }),
    ];
    expect(aggregate(events).sessions[0].cost_usd).toBe(0);
  });

  it("estimateCost is zero for a payload with no token data", () => {
    expect(
      estimateCost({ tool_name: "Agent", tool_use_id: "x", success: true })
    ).toBe(0);
  });

  it("estimateCost uses provided rates", () => {
    const rates = { inputPer1M: 1, outputPer1M: 2, cacheReadPer1M: 0.5, cacheWritePer1M: 4 };
    const cost = estimateCost(
      { tool_name: "Agent", tool_use_id: "x", success: true, input_tokens: 1_000_000, output_tokens: 1_000_000 },
      rates
    );
    expect(cost).toBe(3);
  });

  it("DEFAULT_COST_RATES is exported and stable", () => {
    expect(DEFAULT_COST_RATES.inputPer1M).toBeGreaterThan(0);
    expect(DEFAULT_COST_RATES.outputPer1M).toBeGreaterThan(0);
  });

  it("cost rates can be overridden via environment variables", () => {
    const prior = { ...process.env };
    process.env.FATHOM_PRICE_INPUT = "10";
    process.env.FATHOM_PRICE_OUTPUT = "20";
    process.env.FATHOM_PRICE_CACHE_READ = "0";
    process.env.FATHOM_PRICE_CACHE_WRITE = "0";
    try {
      const events = [
        makeEvent({
          event_type: "tool_use",
          payload: {
            tool_name: "Agent", tool_use_id: "1", success: true,
            input_tokens: 1_000_000, output_tokens: 1_000_000,
          },
        }),
      ];
      const r = aggregate(events);
      // 1M * $10/1M + 1M * $20/1M = $30
      expect(r.sessions[0].cost_usd).toBe(30);
    } finally {
      // restore
      for (const k of ["FATHOM_PRICE_INPUT", "FATHOM_PRICE_OUTPUT", "FATHOM_PRICE_CACHE_READ", "FATHOM_PRICE_CACHE_WRITE"]) {
        if (prior[k] === undefined) delete process.env[k];
        else process.env[k] = prior[k];
      }
    }
  });

  it("aggregates cache_creation_tokens", () => {
    const events = [
      makeEvent({
        event_type: "tool_use",
        payload: {
          tool_name: "Agent", tool_use_id: "1", success: true,
          cache_creation_tokens: 500,
        },
      }),
    ];
    expect(aggregate(events).sessions[0].cache_creation_tokens).toBe(500);
  });
});
