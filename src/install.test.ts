import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  getSettingsPath,
  loadSettings,
  installHooks,
  removeHooks,
  CAPTURE_SCRIPT,
} from "./install";

const HOOK_EVENTS = [
  "PostToolUse", "PreToolUse", "PostToolUseFailure",
  "SessionStart", "SessionEnd", "Stop", "Notification",
  "SubagentStart", "SubagentStop", "PreCompact",
];

describe("getSettingsPath", () => {
  it("returns global settings path when local=false", () => {
    expect(getSettingsPath(false)).toBe(
      path.join(os.homedir(), ".claude", "settings.json")
    );
  });

  it("returns project-local path when local=true", () => {
    expect(getSettingsPath(true)).toBe(
      path.join(process.cwd(), ".claude", "settings.local.json")
    );
  });
});

describe("loadSettings", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fathom-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("returns empty object for nonexistent file", () => {
    expect(loadSettings(path.join(tmpDir, "nope.json"))).toEqual({});
  });

  it("parses valid JSON", () => {
    const p = path.join(tmpDir, "settings.json");
    const data = { model: "sonnet", hooks: {} };
    fs.writeFileSync(p, JSON.stringify(data));
    expect(loadSettings(p)).toEqual(data);
  });

  it("returns empty object for malformed JSON", () => {
    const p = path.join(tmpDir, "settings.json");
    fs.writeFileSync(p, "{ not valid }");
    expect(loadSettings(p)).toEqual({});
  });
});

describe("installHooks", () => {
  it("registers all 10 hook events on empty settings", () => {
    const result = installHooks({});
    const hooks = result.hooks as Record<string, unknown[]>;
    for (const event of HOOK_EVENTS) {
      expect(hooks[event], `missing ${event}`).toHaveLength(1);
    }
  });

  it("each entry points to CAPTURE_SCRIPT", () => {
    const result = installHooks({});
    const hooks = result.hooks as Record<
      string,
      { matcher: string; hooks: { command: string }[] }[]
    >;
    for (const event of HOOK_EVENTS) {
      expect(hooks[event][0].hooks[0].command).toBe(`node ${CAPTURE_SCRIPT}`);
    }
  });

  it("is idempotent — running twice yields one entry per event", () => {
    const second = installHooks(installHooks({}));
    const hooks = second.hooks as Record<string, unknown[]>;
    for (const event of HOOK_EVENTS) {
      expect(hooks[event], `duplicate ${event}`).toHaveLength(1);
    }
  });

  it("removes stale src-path entries", () => {
    const stale = "node /home/user/fathom/src/hooks/capture.js";
    const existing = {
      hooks: {
        PostToolUse: [
          { matcher: "", hooks: [{ type: "command", command: stale }] },
        ],
      },
    };
    const result = installHooks(existing);
    const hooks = result.hooks as Record<
      string,
      { matcher: string; hooks: { command: string }[] }[]
    >;
    expect(hooks.PostToolUse).toHaveLength(1);
    expect(hooks.PostToolUse[0].hooks[0].command).toContain("dist/hooks/capture.js");
  });

  it("preserves non-fathom hook entries", () => {
    const existing = {
      hooks: {
        PostToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "node /other/hook.js" }] },
        ],
      },
    };
    const result = installHooks(existing);
    const hooks = result.hooks as Record<string, unknown[]>;
    // non-fathom entry plus the new fathom entry
    expect(hooks.PostToolUse).toHaveLength(2);
  });
});

describe("removeHooks", () => {
  it("returns removed=0 and empty settings when settings is empty", () => {
    const { settings, removed } = removeHooks({});
    expect(removed).toBe(0);
    expect(settings).toEqual({});
  });

  it("removes all fathom entries and prunes the hooks key", () => {
    const installed = installHooks({});
    const { settings, removed } = removeHooks(installed);
    expect(removed).toBe(HOOK_EVENTS.length);
    expect(settings).not.toHaveProperty("hooks");
  });

  it("removes fathom entries but preserves non-fathom entries", () => {
    const base = {
      hooks: {
        PostToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "node /other/hook.js" }] },
        ],
      },
    };
    const installed = installHooks(base);
    const { settings, removed } = removeHooks(installed);
    expect(removed).toBe(HOOK_EVENTS.length);
    const hooks = settings.hooks as Record<string, unknown[]>;
    expect(hooks.PostToolUse).toHaveLength(1);
    expect((hooks.PostToolUse[0] as { matcher: string }).matcher).toBe("Bash");
  });

  it("is idempotent — second call returns removed=0", () => {
    const installed = installHooks({});
    const { settings: afterFirst } = removeHooks(installed);
    const { removed } = removeHooks(afterFirst);
    expect(removed).toBe(0);
  });

  it("preserves non-hooks settings fields", () => {
    const installed = installHooks({ model: "sonnet", theme: "dark" });
    const { settings } = removeHooks(installed);
    expect(settings.model).toBe("sonnet");
    expect(settings.theme).toBe("dark");
  });
});
