import { describe, it, expect } from "vitest";
import { normalize } from "./capture";

const SESSION_ID = "test-session-001";

function raw(overrides: Record<string, unknown>) {
  return { session_id: SESSION_ID, ...overrides };
}

describe("normalize", () => {
  it("returns null for unknown event name", () => {
    expect(normalize(raw({ hook_event_name: "Unknown" }))).toBeNull();
  });

  it("sets schema_version, session_id, and ISO timestamp on all events", () => {
    const result = normalize(raw({ hook_event_name: "PreCompact" }));
    expect(result?.schema_version).toBe("1.0.0");
    expect(result?.session_id).toBe(SESSION_ID);
    expect(result?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("sets project_dir from raw.cwd when CLAUDE_PROJECT_DIR is unset", () => {
    const prior = process.env.CLAUDE_PROJECT_DIR;
    delete process.env.CLAUDE_PROJECT_DIR;
    try {
      const result = normalize(raw({ hook_event_name: "SessionStart", cwd: "/home/user/projects/myapp", permission_mode: "default" }));
      expect(result?.project_dir).toBe("/home/user/projects/myapp");
    } finally {
      if (prior !== undefined) process.env.CLAUDE_PROJECT_DIR = prior;
    }
  });

  it("strips trailing slash from project_dir (raw.cwd source)", () => {
    const prior = process.env.CLAUDE_PROJECT_DIR;
    delete process.env.CLAUDE_PROJECT_DIR;
    try {
      const result = normalize(raw({ hook_event_name: "SessionStart", cwd: "/home/user/projects/myapp/", permission_mode: "default" }));
      expect(result?.project_dir).toBe("/home/user/projects/myapp");
    } finally {
      if (prior !== undefined) process.env.CLAUDE_PROJECT_DIR = prior;
    }
  });

  it("strips trailing slash from project_dir (CLAUDE_PROJECT_DIR source)", () => {
    const prior = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = "/etc/foo/";
    try {
      const result = normalize(raw({ hook_event_name: "SessionStart", cwd: "/somewhere/else", permission_mode: "default" }));
      expect(result?.project_dir).toBe("/etc/foo");
    } finally {
      if (prior === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = prior;
    }
  });

  it("project_dir is empty string when CLAUDE_PROJECT_DIR and cwd are both absent", () => {
    const prior = process.env.CLAUDE_PROJECT_DIR;
    delete process.env.CLAUDE_PROJECT_DIR;
    try {
      const result = normalize(raw({ hook_event_name: "PreCompact" }));
      expect(result?.project_dir).toBe("");
    } finally {
      if (prior !== undefined) process.env.CLAUDE_PROJECT_DIR = prior;
    }
  });

  it("CLAUDE_PROJECT_DIR overrides raw.cwd", () => {
    const prior = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = "/env/wins";
    try {
      const result = normalize(raw({ hook_event_name: "SessionStart", cwd: "/cwd/loses", permission_mode: "default" }));
      expect(result?.project_dir).toBe("/env/wins");
    } finally {
      if (prior === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = prior;
    }
  });

  it("session_id defaults to empty string when missing", () => {
    const result = normalize({ hook_event_name: "PreCompact" } as Record<string, unknown>);
    expect(result?.session_id).toBe("");
  });

  it("returns null for missing hook_event_name", () => {
    expect(normalize(raw({}))).toBeNull();
  });

  describe("PostToolUse", () => {
    it("non-Agent: success when not interrupted", () => {
      const result = normalize(raw({
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_use_id: "tu-1",
        tool_response: { interrupted: false, totalDurationMs: 120 },
      }));
      expect(result?.event_type).toBe("tool_use");
      expect(result?.payload.success).toBe(true);
      expect(result?.payload.tool_name).toBe("Bash");
      expect(result?.payload.duration_ms).toBe(120);
    });

    it("non-Agent: failure when interrupted", () => {
      const result = normalize(raw({
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_use_id: "tu-2",
        tool_response: { interrupted: true },
      }));
      expect(result?.payload.success).toBe(false);
    });

    it("Agent: success when status=completed, includes token fields", () => {
      const result = normalize(raw({
        hook_event_name: "PostToolUse",
        tool_name: "Agent",
        tool_use_id: "tu-3",
        tool_response: {
          status: "completed",
          totalDurationMs: 5000,
          totalTokens: 1000,
          agentId: "agent-1",
          agentType: "general-purpose",
          usage: {
            input_tokens: 800,
            output_tokens: 150,
            cache_read_input_tokens: 50,
            cache_creation_input_tokens: 0,
          },
        },
      }));
      expect(result?.payload.success).toBe(true);
      expect(result?.payload.total_tokens).toBe(1000);
      expect(result?.payload.input_tokens).toBe(800);
      expect(result?.payload.output_tokens).toBe(150);
      expect(result?.payload.cache_read_tokens).toBe(50);
      expect(result?.payload.agent_id).toBe("agent-1");
      expect(result?.payload.agent_type).toBe("general-purpose");
    });

    it("Agent: failure when status!=completed", () => {
      const result = normalize(raw({
        hook_event_name: "PostToolUse",
        tool_name: "Agent",
        tool_use_id: "tu-4",
        tool_response: { status: "error", usage: {} },
      }));
      expect(result?.payload.success).toBe(false);
    });
  });

  it("PreToolUse: tool_start with input_size_bytes", () => {
    const input = { command: "ls -la" };
    const result = normalize(raw({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_use_id: "tu-5",
      tool_input: input,
    }));
    expect(result?.event_type).toBe("tool_start");
    expect(result?.payload.input_size_bytes).toBe(
      Buffer.byteLength(JSON.stringify(input))
    );
  });

  it("PostToolUseFailure: tool_failure with error and is_interrupt", () => {
    const result = normalize(raw({
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_use_id: "tu-6",
      error: "permission denied",
      is_interrupt: false,
    }));
    expect(result?.event_type).toBe("tool_failure");
    expect(result?.payload.error).toBe("permission denied");
    expect(result?.payload.is_interrupt).toBe(false);
  });

  it("SessionStart: session_start with cwd and permission_mode", () => {
    const result = normalize(raw({
      hook_event_name: "SessionStart",
      cwd: "/home/user/project",
      permission_mode: "default",
    }));
    expect(result?.event_type).toBe("session_start");
    expect(result?.payload.cwd).toBe("/home/user/project");
    expect(result?.payload.permission_mode).toBe("default");
  });

  it("Stop: session_end with hook_source=Stop", () => {
    const result = normalize(raw({
      hook_event_name: "Stop",
      cwd: "/tmp",
      last_assistant_message: "Done!",
    }));
    expect(result?.event_type).toBe("session_end");
    expect(result?.payload.hook_source).toBe("Stop");
    expect(result?.payload.last_assistant_message).toBe("Done!");
  });

  it("SessionEnd: session_end with hook_source=SessionEnd", () => {
    const result = normalize(raw({ hook_event_name: "SessionEnd", cwd: "/tmp" }));
    expect(result?.event_type).toBe("session_end");
    expect(result?.payload.hook_source).toBe("SessionEnd");
  });

  it("Notification: notification with message", () => {
    const result = normalize(raw({ hook_event_name: "Notification", message: "Build done" }));
    expect(result?.event_type).toBe("notification");
    expect(result?.payload.message).toBe("Build done");
  });

  it("Notification: forwards level field when present", () => {
    const result = normalize(raw({ hook_event_name: "Notification", message: "warn", level: "warning" }));
    expect(result?.payload.level).toBe("warning");
  });

  it("Notification: level is null when absent in raw payload", () => {
    const result = normalize(raw({ hook_event_name: "Notification", message: "info" }));
    expect(result?.payload.level).toBeNull();
  });

  it("PostToolUse non-Agent: omits agent-only token fields", () => {
    const result = normalize(raw({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_use_id: "tu-x",
      tool_response: { interrupted: false, totalDurationMs: 50 },
    }));
    // Token fields should not be present on non-Agent tool_use payloads.
    expect(result?.payload.total_tokens).toBeUndefined();
    expect(result?.payload.input_tokens).toBeUndefined();
  });

  it("PostToolUse: tool_response missing entirely → still returns event with success=true", () => {
    const result = normalize(raw({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_use_id: "tu-y",
    }));
    expect(result?.event_type).toBe("tool_use");
    // No tool_response → response.interrupted undefined → coerces to false → success true.
    expect(result?.payload.success).toBe(true);
  });

  it("PostToolUse Agent: missing usage object → token fields undefined, no throw", () => {
    const result = normalize(raw({
      hook_event_name: "PostToolUse",
      tool_name: "Agent",
      tool_use_id: "tu-z",
      tool_response: { status: "completed", totalTokens: 5 },
    }));
    expect(result?.payload.total_tokens).toBe(5);
    expect(result?.payload.input_tokens).toBeUndefined();
  });

  it("SubagentStart: subagent_start with agent_id and agent_type", () => {
    const result = normalize(raw({
      hook_event_name: "SubagentStart",
      agent_id: "agent-1",
      agent_type: "general-purpose",
    }));
    expect(result?.event_type).toBe("subagent_start");
    expect(result?.payload.agent_id).toBe("agent-1");
    expect(result?.payload.agent_type).toBe("general-purpose");
  });

  it("SubagentStop: subagent_stop with all fields", () => {
    const result = normalize(raw({
      hook_event_name: "SubagentStop",
      agent_id: "agent-1",
      agent_type: "general-purpose",
      agent_transcript_path: "/tmp/transcript.json",
      last_assistant_message: "task complete",
      stop_hook_active: true,
    }));
    expect(result?.event_type).toBe("subagent_stop");
    expect(result?.payload.agent_transcript_path).toBe("/tmp/transcript.json");
    expect(result?.payload.stop_hook_active).toBe(true);
  });

  it("PreCompact: pre_compact event", () => {
    const result = normalize(raw({ hook_event_name: "PreCompact" }));
    expect(result?.event_type).toBe("pre_compact");
  });
});
