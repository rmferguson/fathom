import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  readEvents,
  aggregate,
  filterByProject,
  estimateCost,
  DEFAULT_COST_RATES,
  pruneEvents,
} from "./index";
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
    const event = makeEvent({
      event_type: "session_start",
      payload: { cwd: "/tmp", permission_mode: "default" },
    });
    fs.writeFileSync(p, JSON.stringify(event) + "\n");
    const result = await readEvents(p);
    expect(result).toHaveLength(1);
    expect(result[0].event_type).toBe("session_start");
  });

  it("skips malformed lines without throwing", async () => {
    const p = path.join(tmpDir, "events.jsonl");
    const event = makeEvent({
      event_type: "session_start",
      payload: { cwd: "/tmp", permission_mode: "default" },
    });
    fs.writeFileSync(p, "{ bad json }\n" + JSON.stringify(event) + "\n");
    const result = await readEvents(p);
    expect(result).toHaveLength(1);
  });
});

describe("filterByProject", () => {
  it("keeps only events matching the project_dir", () => {
    const events = [
      makeEvent({
        event_type: "session_start",
        project_dir: "/home/user/projects/alpha",
        payload: { cwd: "/home/user/projects/alpha", permission_mode: "default" },
      }),
      makeEvent({
        event_type: "session_start",
        project_dir: "/home/user/projects/beta",
        payload: { cwd: "/home/user/projects/beta", permission_mode: "default" },
      }),
    ];
    const result = filterByProject(events, "/home/user/projects/alpha");
    expect(result).toHaveLength(1);
    expect(result[0].project_dir).toBe("/home/user/projects/alpha");
  });

  it("strips trailing slash from filter arg", () => {
    const events = [
      makeEvent({ event_type: "pre_compact", project_dir: "/home/user/projects/alpha" }),
    ];
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
      makeEvent({
        event_type: "tool_use",
        payload: { tool_name: "Bash", tool_use_id: "1", success: true },
      }),
      makeEvent({
        event_type: "tool_use",
        payload: { tool_name: "Bash", tool_use_id: "2", success: true },
      }),
      makeEvent({
        event_type: "tool_use",
        payload: { tool_name: "Read", tool_use_id: "3", success: true },
      }),
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
          tool_name: "Agent",
          tool_use_id: "1",
          success: true,
          total_tokens: 1000,
          input_tokens: 800,
          output_tokens: 150,
          cache_read_tokens: 50,
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
      makeEvent({
        event_type: "tool_use",
        payload: { tool_name: "Bash", tool_use_id: "1", success: false },
      }),
    ];
    expect(aggregate(events).sessions[0].errors).toBe(1);
  });

  it("counts tool_failure events as errors", () => {
    const events = [
      makeEvent({
        event_type: "tool_failure",
        payload: { tool_name: "Bash", tool_use_id: "1", error: "timeout", is_interrupt: false },
      }),
    ];
    expect(aggregate(events).sessions[0].errors).toBe(1);
  });

  it("derives wall_time_ms from event timestamps", () => {
    const events = [
      makeEvent({
        event_type: "session_start",
        timestamp: "2026-04-21T10:00:00Z",
        payload: { cwd: "/tmp", permission_mode: "default" },
      }),
      makeEvent({
        event_type: "session_end",
        timestamp: "2026-04-21T10:05:00Z",
        payload: { cwd: "/tmp", hook_source: "Stop", last_assistant_message: null },
      }),
    ];
    expect(aggregate(events).sessions[0].wall_time_ms).toBe(5 * 60 * 1000);
  });

  it("deduplicates session_end — Stop wins over SessionEnd", () => {
    const events = [
      makeEvent({
        event_type: "session_start",
        timestamp: "2026-04-21T10:00:00Z",
        payload: { cwd: "/tmp", permission_mode: "default" },
      }),
      makeEvent({
        event_type: "session_end",
        timestamp: "2026-04-21T10:05:00Z",
        payload: { cwd: "/tmp", hook_source: "Stop", last_assistant_message: "done" },
      }),
      makeEvent({
        event_type: "session_end",
        timestamp: "2026-04-21T10:05:01Z",
        payload: { cwd: "/tmp", hook_source: "SessionEnd", last_assistant_message: null },
      }),
    ];
    const r = aggregate(events);
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0].wall_time_ms).toBe(5 * 60 * 1000);
  });

  it("coalesces multiple Stop events — last one wins for duration and last_assistant_message", () => {
    // Stop fires on every turn; only the last record reflects the real session end.
    const events = [
      makeEvent({
        event_type: "session_start",
        timestamp: "2026-04-21T10:00:00Z",
        payload: { cwd: "/tmp", permission_mode: "default" },
      }),
      makeEvent({
        event_type: "session_end",
        timestamp: "2026-04-21T10:02:00Z",
        payload: { cwd: "/tmp", hook_source: "Stop", last_assistant_message: "turn 1" },
      }),
      makeEvent({
        event_type: "session_end",
        timestamp: "2026-04-21T10:04:00Z",
        payload: { cwd: "/tmp", hook_source: "Stop", last_assistant_message: "turn 2" },
      }),
      makeEvent({
        event_type: "session_end",
        timestamp: "2026-04-21T10:06:00Z",
        payload: { cwd: "/tmp", hook_source: "Stop", last_assistant_message: "turn 3" },
      }),
    ];
    const r = aggregate(events);
    expect(r.sessions).toHaveLength(1);
    // Duration uses the last Stop timestamp (10:06), not the first (10:02).
    expect(r.sessions[0].wall_time_ms).toBe(6 * 60 * 1000);
    expect(r.sessions[0].ended_at).toBe("2026-04-21T10:06:00Z");
  });

  it("sorts sessions newest-first", () => {
    const events = [
      makeEvent({
        event_type: "session_start",
        session_id: "s-old",
        timestamp: "2026-04-21T09:00:00Z",
        payload: { cwd: "/tmp", permission_mode: "default" },
      }),
      makeEvent({
        event_type: "session_start",
        session_id: "s-new",
        timestamp: "2026-04-21T10:00:00Z",
        payload: { cwd: "/tmp", permission_mode: "default" },
      }),
    ];
    const r = aggregate(events);
    expect(r.sessions[0].session_id).toBe("s-new");
    expect(r.sessions[1].session_id).toBe("s-old");
  });

  it("computes top_tools across sessions", () => {
    const events = [
      makeEvent({
        event_type: "tool_use",
        session_id: "s1",
        payload: { tool_name: "Bash", tool_use_id: "1", success: true },
      }),
      makeEvent({
        event_type: "tool_use",
        session_id: "s1",
        payload: { tool_name: "Read", tool_use_id: "2", success: true },
      }),
      makeEvent({
        event_type: "tool_use",
        session_id: "s2",
        payload: { tool_name: "Bash", tool_use_id: "3", success: true },
      }),
    ];
    const r = aggregate(events);
    expect(r.top_tools[0]).toEqual({ tool: "Bash", count: 2 });
    expect(r.top_tools[1]).toEqual({ tool: "Read", count: 1 });
  });

  it("does not double-count when tool_use{success:false} and tool_failure share tool_use_id", () => {
    const events = [
      makeEvent({
        event_type: "tool_use",
        payload: { tool_name: "Bash", tool_use_id: "tu-1", success: false },
      }),
      makeEvent({
        event_type: "tool_failure",
        payload: {
          tool_name: "Bash",
          tool_use_id: "tu-1",
          error: "interrupted",
          is_interrupt: true,
        },
      }),
    ];
    expect(aggregate(events).sessions[0].errors).toBe(1);
  });

  it("counts distinct failed tool_use_ids separately", () => {
    const events = [
      makeEvent({
        event_type: "tool_use",
        payload: { tool_name: "Bash", tool_use_id: "tu-1", success: false },
      }),
      makeEvent({
        event_type: "tool_failure",
        payload: { tool_name: "Bash", tool_use_id: "tu-2", error: "x", is_interrupt: false },
      }),
      makeEvent({
        event_type: "tool_failure",
        payload: { tool_name: "Bash", tool_use_id: "tu-3", error: "y", is_interrupt: false },
      }),
    ];
    expect(aggregate(events).sessions[0].errors).toBe(3);
  });

  it("aggregates subagent dispatches and completions per agent_type", () => {
    const events = [
      makeEvent({
        event_type: "subagent_start",
        payload: { agent_id: "a-1", agent_type: "general-purpose" },
      }),
      makeEvent({
        event_type: "subagent_start",
        payload: { agent_id: "a-2", agent_type: "general-purpose" },
      }),
      makeEvent({
        event_type: "subagent_start",
        payload: { agent_id: "a-3", agent_type: "test-writer" },
      }),
      makeEvent({
        event_type: "subagent_stop",
        payload: { agent_id: "a-1", agent_type: "general-purpose" },
      }),
      makeEvent({
        event_type: "subagent_stop",
        payload: { agent_id: "a-3", agent_type: "test-writer" },
      }),
    ];
    const r = aggregate(events);
    expect(r.sessions[0].subagents["general-purpose"]).toEqual({
      agent_type: "general-purpose",
      dispatches: 2,
      completions: 1,
      total_tokens: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      cost_usd: 0,
    });
    expect(r.sessions[0].subagents["test-writer"]).toEqual({
      agent_type: "test-writer",
      dispatches: 1,
      completions: 1,
      total_tokens: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      cost_usd: 0,
    });
    expect(r.subagent_totals["general-purpose"].dispatches).toBe(2);
  });

  it("dedupes subagent_start events with same agent_id", () => {
    const events = [
      makeEvent({
        event_type: "subagent_start",
        payload: { agent_id: "a-1", agent_type: "general-purpose" },
      }),
      makeEvent({
        event_type: "subagent_start",
        payload: { agent_id: "a-1", agent_type: "general-purpose" },
      }),
    ];
    expect(aggregate(events).sessions[0].subagents["general-purpose"].dispatches).toBe(1);
  });

  it("subagent payload missing agent_type falls into 'unknown' bucket", () => {
    const events = [makeEvent({ event_type: "subagent_start", payload: { agent_id: "a-1" } })];
    expect(aggregate(events).sessions[0].subagents["unknown"].dispatches).toBe(1);
  });

  it("subagent_stop with empty agent_type resolves type from matching subagent_start", () => {
    // SubagentStop can arrive with empty agent_type when the agent was dispatched
    // before fathom was installed. Look up the type from the SubagentStart by agent_id.
    const events = [
      makeEvent({
        event_type: "subagent_start",
        payload: { agent_id: "a-1", agent_type: "general-purpose" },
      }),
      makeEvent({
        event_type: "subagent_stop",
        payload: { agent_id: "a-1", agent_type: "" },
      }),
    ];
    const r = aggregate(events);
    expect(r.sessions[0].subagents["general-purpose"]).toEqual({
      agent_type: "general-purpose",
      dispatches: 1,
      completions: 1,
      total_tokens: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      cost_usd: 0,
    });
    expect(r.sessions[0].subagents[""]).toBeUndefined();
  });

  it("orphaned subagent_stop with no matching start falls into 'unknown' bucket", () => {
    const events = [
      makeEvent({
        event_type: "subagent_stop",
        payload: { agent_id: "a-orphan", agent_type: "" },
      }),
    ];
    const r = aggregate(events);
    expect(r.sessions[0].subagents["unknown"]).toEqual({
      agent_type: "unknown",
      dispatches: 0,
      completions: 1,
      total_tokens: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      cost_usd: 0,
    });
  });

  it("computes cost_usd from Agent tool_use events", () => {
    const events = [
      makeEvent({
        event_type: "tool_use",
        payload: {
          tool_name: "Agent",
          tool_use_id: "1",
          success: true,
          input_tokens: 1000,
          output_tokens: 1000,
          cache_read_tokens: 1000,
          cache_creation_tokens: 1000,
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
      makeEvent({
        event_type: "tool_use",
        payload: { tool_name: "Bash", tool_use_id: "1", success: true, input_tokens: 1000 },
      }),
    ];
    expect(aggregate(events).sessions[0].cost_usd).toBe(0);
  });

  it("estimateCost is zero for a payload with no token data", () => {
    expect(estimateCost({ tool_name: "Agent", tool_use_id: "x", success: true })).toBe(0);
  });

  it("estimateCost uses provided rates", () => {
    const rates = { inputPer1M: 1, outputPer1M: 2, cacheReadPer1M: 0.5, cacheWritePer1M: 4 };
    const cost = estimateCost(
      {
        tool_name: "Agent",
        tool_use_id: "x",
        success: true,
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
      },
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
            tool_name: "Agent",
            tool_use_id: "1",
            success: true,
            input_tokens: 1_000_000,
            output_tokens: 1_000_000,
          },
        }),
      ];
      const r = aggregate(events);
      // 1M * $10/1M + 1M * $20/1M = $30
      expect(r.sessions[0].cost_usd).toBe(30);
    } finally {
      // restore
      for (const k of [
        "FATHOM_PRICE_INPUT",
        "FATHOM_PRICE_OUTPUT",
        "FATHOM_PRICE_CACHE_READ",
        "FATHOM_PRICE_CACHE_WRITE",
      ]) {
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
          tool_name: "Agent",
          tool_use_id: "1",
          success: true,
          cache_creation_tokens: 500,
        },
      }),
    ];
    expect(aggregate(events).sessions[0].cache_creation_tokens).toBe(500);
  });

  it("counts background agent tokens from subagent_stop when tool_use had zero tokens", () => {
    // Background agents: PostToolUse fires immediately with 0 tokens (tool_use event),
    // then SubagentStop fires later with transcript-derived tokens.
    const events = [
      makeEvent({
        event_type: "tool_use",
        payload: {
          tool_name: "Agent",
          tool_use_id: "tu-bg",
          success: true,
          total_tokens: 0,
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
          agent_id: "agent-bg",
        },
      }),
      makeEvent({
        event_type: "subagent_stop",
        payload: {
          agent_id: "agent-bg",
          agent_type: "general-purpose",
          total_tokens: 1200,
          input_tokens: 100,
          output_tokens: 200,
          cache_read_tokens: 700,
          cache_creation_tokens: 200,
        },
      }),
    ];
    const r = aggregate(events);
    expect(r.sessions[0].total_tokens).toBe(1200);
    expect(r.sessions[0].input_tokens).toBe(100);
    expect(r.sessions[0].output_tokens).toBe(200);
    expect(r.sessions[0].cache_read_tokens).toBe(700);
    expect(r.sessions[0].cache_creation_tokens).toBe(200);
    expect(r.sessions[0].cost_usd).toBeGreaterThan(0);
  });

  it("does not double-count foreground agent tokens when subagent_stop also has tokens", () => {
    // Foreground agents: PostToolUse provides real tokens, SubagentStop transcript
    // also has tokens — only count once (from tool_use).
    const events = [
      makeEvent({
        event_type: "tool_use",
        payload: {
          tool_name: "Agent",
          tool_use_id: "tu-fg",
          success: true,
          total_tokens: 1000,
          input_tokens: 800,
          output_tokens: 200,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
          agent_id: "agent-fg",
        },
      }),
      makeEvent({
        event_type: "subagent_stop",
        payload: {
          agent_id: "agent-fg",
          agent_type: "general-purpose",
          total_tokens: 1000,
          input_tokens: 800,
          output_tokens: 200,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
        },
      }),
    ];
    const r = aggregate(events);
    expect(r.sessions[0].total_tokens).toBe(1000); // not 2000
    expect(r.sessions[0].input_tokens).toBe(800);
    expect(r.sessions[0].output_tokens).toBe(200);
  });

  it("counts subagent_stop tokens for multiple background agents independently", () => {
    const events = [
      makeEvent({
        event_type: "subagent_stop",
        payload: {
          agent_id: "a-1",
          agent_type: "general-purpose",
          total_tokens: 500,
          input_tokens: 50,
          output_tokens: 100,
          cache_read_tokens: 250,
          cache_creation_tokens: 100,
        },
      }),
      makeEvent({
        event_type: "subagent_stop",
        payload: {
          agent_id: "a-2",
          agent_type: "general-purpose",
          total_tokens: 300,
          input_tokens: 30,
          output_tokens: 60,
          cache_read_tokens: 150,
          cache_creation_tokens: 60,
        },
      }),
    ];
    const r = aggregate(events);
    expect(r.sessions[0].total_tokens).toBe(800);
    expect(r.sessions[0].input_tokens).toBe(80);
  });

  it("ignores subagent_stop events with no token data (old events)", () => {
    const events = [
      makeEvent({
        event_type: "subagent_stop",
        payload: { agent_id: "a-1", agent_type: "general-purpose" },
      }),
    ];
    const r = aggregate(events);
    expect(r.sessions[0].total_tokens).toBe(0);
    expect(r.sessions[0].cost_usd).toBe(0);
  });

  // --- Gap 1: per-subagent token accumulation ---

  it("accumulates token fields into SubagentSummary bucket for background agents (subagent_stop)", () => {
    const events = [
      makeEvent({
        event_type: "subagent_stop",
        payload: {
          agent_id: "bg-1",
          agent_type: "general-purpose",
          total_tokens: 1200,
          input_tokens: 100,
          output_tokens: 200,
          cache_read_tokens: 700,
          cache_creation_tokens: 200,
        },
      }),
    ];
    const r = aggregate(events);
    const bucket = r.sessions[0].subagents["general-purpose"];
    expect(bucket.total_tokens).toBe(1200);
    expect(bucket.input_tokens).toBe(100);
    expect(bucket.output_tokens).toBe(200);
    expect(bucket.cache_read_tokens).toBe(700);
    expect(bucket.cache_creation_tokens).toBe(200);
    expect(bucket.cost_usd).toBeGreaterThan(0);
  });

  it("accumulates token fields into SubagentSummary bucket for foreground agents (tool_use)", () => {
    const events = [
      makeEvent({
        event_type: "tool_use",
        payload: {
          tool_name: "Agent",
          tool_use_id: "fg-tu",
          success: true,
          agent_id: "fg-1",
          agent_type: "general-purpose",
          total_tokens: 1000,
          input_tokens: 800,
          output_tokens: 200,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
        },
      }),
    ];
    const r = aggregate(events);
    const bucket = r.sessions[0].subagents["general-purpose"];
    expect(bucket.total_tokens).toBe(1000);
    expect(bucket.input_tokens).toBe(800);
    expect(bucket.output_tokens).toBe(200);
    expect(bucket.cost_usd).toBeGreaterThan(0);
  });

  it("does not double-count tokens in subagent bucket for foreground agent (tool_use + subagent_stop)", () => {
    // Foreground agent: tool_use has real tokens, subagent_stop also has tokens.
    // Bucket should reflect only the tool_use tokens.
    const events = [
      makeEvent({
        event_type: "tool_use",
        payload: {
          tool_name: "Agent",
          tool_use_id: "fg-tu",
          success: true,
          agent_id: "fg-1",
          agent_type: "general-purpose",
          total_tokens: 1000,
          input_tokens: 800,
          output_tokens: 200,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
        },
      }),
      makeEvent({
        event_type: "subagent_stop",
        payload: {
          agent_id: "fg-1",
          agent_type: "general-purpose",
          total_tokens: 1000,
          input_tokens: 800,
          output_tokens: 200,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
        },
      }),
    ];
    const r = aggregate(events);
    const bucket = r.sessions[0].subagents["general-purpose"];
    // Only counted once from tool_use
    expect(bucket.total_tokens).toBe(1000);
  });

  it("accumulates SubagentSummary tokens across multiple background agents of same type", () => {
    const events = [
      makeEvent({
        event_type: "subagent_stop",
        payload: {
          agent_id: "bg-1",
          agent_type: "general-purpose",
          total_tokens: 500,
          input_tokens: 50,
          output_tokens: 100,
          cache_read_tokens: 250,
          cache_creation_tokens: 100,
        },
      }),
      makeEvent({
        event_type: "subagent_stop",
        payload: {
          agent_id: "bg-2",
          agent_type: "general-purpose",
          total_tokens: 300,
          input_tokens: 30,
          output_tokens: 60,
          cache_read_tokens: 150,
          cache_creation_tokens: 60,
        },
      }),
    ];
    const r = aggregate(events);
    const bucket = r.sessions[0].subagents["general-purpose"];
    expect(bucket.total_tokens).toBe(800);
    expect(bucket.input_tokens).toBe(80);
    expect(bucket.cost_usd).toBeGreaterThan(0);
  });

  it("rolls SubagentSummary token fields into subagent_totals across sessions", () => {
    const events = [
      makeEvent({
        event_type: "subagent_stop",
        session_id: "s-1",
        payload: {
          agent_id: "bg-s1",
          agent_type: "general-purpose",
          total_tokens: 400,
          input_tokens: 40,
          output_tokens: 80,
          cache_read_tokens: 200,
          cache_creation_tokens: 80,
        },
      }),
      makeEvent({
        event_type: "subagent_stop",
        session_id: "s-2",
        payload: {
          agent_id: "bg-s2",
          agent_type: "general-purpose",
          total_tokens: 600,
          input_tokens: 60,
          output_tokens: 120,
          cache_read_tokens: 300,
          cache_creation_tokens: 120,
        },
      }),
    ];
    const r = aggregate(events);
    const total = r.subagent_totals["general-purpose"];
    expect(total.total_tokens).toBe(1000);
    expect(total.input_tokens).toBe(100);
    expect(total.cost_usd).toBeGreaterThan(0);
  });
});

describe("pruneEvents", () => {
  let tmpDir: string;
  let sinkPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fathom-prune-"));
    sinkPath = path.join(tmpDir, "events.jsonl");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  function writeEvents(events: FathomEvent[]): void {
    fs.writeFileSync(sinkPath, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }

  it("returns zeros for a nonexistent sink", async () => {
    const result = await pruneEvents(Date.now(), path.join(tmpDir, "nope.jsonl"));
    expect(result).toEqual({ removed: 0, kept: 0, bytesRecovered: 0 });
  });

  it("removes events before the cutoff and keeps events after", async () => {
    const old = makeEvent({
      event_type: "session_start",
      timestamp: "2026-01-01T00:00:00Z",
      payload: { cwd: "/", permission_mode: "default" },
    });
    const recent = makeEvent({
      event_type: "session_start",
      timestamp: "2026-04-01T00:00:00Z",
      payload: { cwd: "/", permission_mode: "default" },
    });
    writeEvents([old, recent]);

    const cutoff = Date.parse("2026-02-01T00:00:00Z");
    const result = await pruneEvents(cutoff, sinkPath);

    expect(result.removed).toBe(1);
    expect(result.kept).toBe(1);
    expect(result.bytesRecovered).toBeGreaterThan(0);

    const remaining = await readEvents(sinkPath);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].timestamp).toBe("2026-04-01T00:00:00Z");
  });

  it("removes nothing when all events are after the cutoff", async () => {
    const recent = makeEvent({ event_type: "pre_compact", timestamp: "2026-04-20T00:00:00Z" });
    writeEvents([recent]);

    const result = await pruneEvents(Date.parse("2026-01-01T00:00:00Z"), sinkPath);
    expect(result.removed).toBe(0);
    expect(result.kept).toBe(1);
    expect(result.bytesRecovered).toBe(0);

    expect(await readEvents(sinkPath)).toHaveLength(1);
  });

  it("removes everything when all events are before the cutoff", async () => {
    const old = makeEvent({ event_type: "pre_compact", timestamp: "2026-01-01T00:00:00Z" });
    writeEvents([old]);

    const result = await pruneEvents(Date.now(), sinkPath);
    expect(result.removed).toBe(1);
    expect(result.kept).toBe(0);

    expect(await readEvents(sinkPath)).toHaveLength(0);
  });

  it("keeps malformed lines rather than dropping them", async () => {
    const good = makeEvent({ event_type: "pre_compact", timestamp: "2026-04-20T00:00:00Z" });
    fs.writeFileSync(sinkPath, "{ bad json }\n" + JSON.stringify(good) + "\n");

    // cutoff far in the future: the parseable event is old and gets removed,
    // but the malformed line can't be parsed so it is kept rather than dropped.
    const result = await pruneEvents(Date.now() + 86_400_000, sinkPath);
    expect(result.removed).toBe(1);
    expect(result.kept).toBe(1);
  });

  it("leaves the sink unchanged when there is nothing to remove", async () => {
    const event = makeEvent({ event_type: "pre_compact", timestamp: "2026-04-20T00:00:00Z" });
    writeEvents([event]);
    const before = fs.readFileSync(sinkPath, "utf8");

    await pruneEvents(Date.parse("2026-01-01T00:00:00Z"), sinkPath);

    const after = fs.readFileSync(sinkPath, "utf8");
    expect(after).toBe(before);
  });
});
