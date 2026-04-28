/**
 * Fathom installer — shared logic for registering hook handlers in Claude Code settings.
 *
 * Used by:
 *   - fathom install (CLI command in src/cli/index.ts)
 *   - scripts/install.ts (standalone script for npx tsx usage)
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Resolve the capture script path relative to the project root.
// __dirname is either src/ (tsx) or dist/ (compiled) — one level up is always the project root.
const PROJECT_ROOT = path.resolve(__dirname, "..");
export const CAPTURE_SCRIPT = path.resolve(PROJECT_ROOT, "dist/hooks/capture.js");

export const HOOK_COMMAND = `node ${CAPTURE_SCRIPT}`;

// Hook registrations: event → matcher (empty string = all tools)
export const HOOKS = [
  { event: "PostToolUse", matcher: "" },
  { event: "PreToolUse", matcher: "" },
  { event: "PostToolUseFailure", matcher: "" },
  { event: "SessionStart", matcher: "" },
  { event: "SessionEnd", matcher: "" },
  { event: "Stop", matcher: "" },
  { event: "Notification", matcher: "" },
  { event: "SubagentStart", matcher: "" },
  { event: "SubagentStop", matcher: "" },
  { event: "PreCompact", matcher: "" },
];

export function getSettingsPath(local: boolean): string {
  if (local) {
    return path.join(process.cwd(), ".claude", "settings.local.json");
  }
  return path.join(os.homedir(), ".claude", "settings.json");
}

export function loadSettings(settingsPath: string): Record<string, unknown> {
  if (!fs.existsSync(settingsPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    return {};
  }
}

const CAPTURE_PATTERN = /node .+\/fathom\/(src|dist)\/hooks\/capture\.js/;

function isFathomEntry(entry: { hooks: unknown[] }): boolean {
  return (
    Array.isArray(entry.hooks) &&
    entry.hooks.some(
      (h: unknown) =>
        typeof h === "object" &&
        h !== null &&
        "command" in h &&
        CAPTURE_PATTERN.test((h as { command: string }).command)
    )
  );
}

export function installHooks(settings: Record<string, unknown>): Record<string, unknown> {
  const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;

  for (const { event, matcher } of HOOKS) {
    if (!Array.isArray(hooks[event])) hooks[event] = [];

    const existing = hooks[event] as Array<{
      matcher: string;
      hooks: unknown[];
    }>;

    // Remove any stale fathom entries (wrong path from prior installs)
    hooks[event] = existing.filter((entry) => !isFathomEntry(entry));

    (hooks[event] as typeof existing).push({
      matcher,
      hooks: [{ type: "command", command: HOOK_COMMAND }],
    });
  }

  return { ...settings, hooks };
}

export function removeHooks(settings: Record<string, unknown>): {
  settings: Record<string, unknown>;
  removed: number;
} {
  const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
  let removed = 0;

  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue;
    const before = hooks[event].length;
    hooks[event] = (hooks[event] as Array<{ matcher: string; hooks: unknown[] }>).filter(
      (entry) => !isFathomEntry(entry)
    );
    removed += before - hooks[event].length;
    if (hooks[event].length === 0) delete hooks[event];
  }

  const updated = { ...settings };
  if (Object.keys(hooks).length > 0) {
    updated.hooks = hooks;
  } else {
    delete updated.hooks;
  }

  return { settings: updated, removed };
}

export function runUninstall(local: boolean): void {
  const settingsPath = getSettingsPath(local);

  if (!fs.existsSync(settingsPath)) {
    console.log(`No settings file found at ${settingsPath}`);
    return;
  }

  const settings = loadSettings(settingsPath);
  const { settings: updated, removed } = removeHooks(settings);

  if (removed === 0) {
    console.log(`No fathom hooks found in ${settingsPath}`);
  } else {
    fs.writeFileSync(settingsPath, JSON.stringify(updated, null, 2) + "\n");
    console.log(
      `Removed ${removed} fathom hook ${removed === 1 ? "entry" : "entries"} from ${settingsPath}`
    );
  }
}

/**
 * Run the installer. Writes hook entries to the appropriate settings file and
 * prints a confirmation summary.
 *
 * @param local When true, installs to .claude/settings.local.json in cwd.
 *              When false (default), installs to ~/.claude/settings.json.
 */
export function runInstall(local: boolean): void {
  const settingsPath = getSettingsPath(local);

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });

  const settings = loadSettings(settingsPath);
  const updated = installHooks(settings);

  fs.writeFileSync(settingsPath, JSON.stringify(updated, null, 2) + "\n");

  console.log(`Fathom hooks installed → ${settingsPath}`);
  console.log(`Capture script: ${CAPTURE_SCRIPT}`);
  console.log(`Events sink: ~/.fathom/events.jsonl`);
  console.log(`\nRun 'fathom summary' after your next Claude Code session.`);
}
