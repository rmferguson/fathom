/**
 * Fathom standalone installer — delegates to the shared install module.
 *
 * Usage:
 *   npx tsx scripts/install.ts              # installs to global ~/.claude/settings.json
 *   npx tsx scripts/install.ts --local      # installs to .claude/settings.local.json in cwd
 *
 * After `npm install -g @aquarium-tools/fathom`, prefer `fathom install` instead.
 */

// Note: when run via `npx tsx scripts/install.ts`, TypeScript paths resolve
// from the project root. The compiled CLI path is used by the shared module
// after a build.
import { runInstall } from "../src/install";

const local = process.argv.includes("--local");
runInstall(local);
