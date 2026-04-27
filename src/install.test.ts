import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  getSettingsPath,
  loadSettings,
  installHooks,
  removeHooks,
  runInstall,
  runUninstall,
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

// ---------------------------------------------------------------------------
// runInstall / runUninstall: drive the full filesystem flow against a sandbox
// settings.json. These exercise the public API the CLI calls into.
// ---------------------------------------------------------------------------

describe("runInstall / runUninstall (filesystem)", () => {
  let tmpDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fathom-install-"));
    // local=true installs to <cwd>/.claude/settings.local.json — point cwd at our sandbox
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    logSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("runInstall(local=true) creates settings.local.json with all 10 hook events", () => {
    runInstall(true);
    const settingsPath = path.join(tmpDir, ".claude", "settings.local.json");
    expect(fs.existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    for (const event of HOOK_EVENTS) {
      expect(settings.hooks[event], `missing ${event}`).toBeDefined();
      expect(settings.hooks[event][0].hooks[0].command).toBe(`node ${CAPTURE_SCRIPT}`);
    }
  });

  it("runInstall preserves existing non-fathom settings", () => {
    const settingsPath = path.join(tmpDir, ".claude", "settings.local.json");
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      model: "sonnet",
      hooks: {
        PostToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "node /other/hook.js" }] },
        ],
      },
    }));
    runInstall(true);
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(settings.model).toBe("sonnet");
    // both the original entry and the fathom entry should be present
    expect(settings.hooks.PostToolUse).toHaveLength(2);
  });

  it("runInstall is idempotent (running twice yields one entry per event)", () => {
    runInstall(true);
    runInstall(true);
    const settingsPath = path.join(tmpDir, ".claude", "settings.local.json");
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    for (const event of HOOK_EVENTS) {
      expect(settings.hooks[event]).toHaveLength(1);
    }
  });

  it("runUninstall on missing settings file is a no-op", () => {
    // No settings file exists.
    expect(() => runUninstall(true)).not.toThrow();
  });

  it("runUninstall removes fathom entries and prunes hooks key", () => {
    runInstall(true);
    runUninstall(true);
    const settingsPath = path.join(tmpDir, ".claude", "settings.local.json");
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(settings).not.toHaveProperty("hooks");
  });

  it("runUninstall preserves non-fathom hooks", () => {
    const settingsPath = path.join(tmpDir, ".claude", "settings.local.json");
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PostToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "node /other/hook.js" }] },
        ],
      },
    }));
    runInstall(true);
    runUninstall(true);
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(settings.hooks.PostToolUse).toHaveLength(1);
    expect(settings.hooks.PostToolUse[0].matcher).toBe("Bash");
  });
});
