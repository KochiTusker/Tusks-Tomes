#!/usr/bin/env node
/**
 * Copy the tracked git hooks from scripts/hooks/ into the repo's actual
 * .git/hooks/ directory. Hooks live outside the working tree, so the
 * canonical source lives at scripts/hooks/<name> and this script
 * installs them on demand.
 *
 * Usage:
 *   node scripts/install-hooks.mjs
 *
 * Idempotent — re-running just overwrites the destination. Worktree-aware:
 * resolves the parent .git via `git rev-parse --git-common-dir` so an
 * install from a linked worktree still puts the hook in the main hooks/.
 */
import { execSync } from "node:child_process";
import { copyFileSync, chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(__dirname, "hooks");

const gitCommonDir = execSync("git rev-parse --git-common-dir", {
  cwd: path.resolve(__dirname, ".."),
  encoding: "utf-8",
}).trim();

// rev-parse returns a path relative to CWD; resolve against the repo root.
const REPO_ROOT = path.resolve(__dirname, "..");
const HOOKS_DIR = path.isAbsolute(gitCommonDir)
  ? path.join(gitCommonDir, "hooks")
  : path.join(REPO_ROOT, gitCommonDir, "hooks");

if (!existsSync(SRC_DIR)) {
  console.error(`No hook sources at ${SRC_DIR}.`);
  process.exit(1);
}

const installed = [];
for (const name of readdirSync(SRC_DIR)) {
  const src = path.join(SRC_DIR, name);
  if (!statSync(src).isFile()) continue;
  const dest = path.join(HOOKS_DIR, name);
  copyFileSync(src, dest);
  // chmod is a no-op on Windows but Git for Windows still respects the
  // shebang via its bundled sh.exe, so non-executable bits don't matter
  // there. On POSIX this is what actually enables execution.
  try {
    chmodSync(dest, 0o755);
  } catch {
    /* Windows: ignore */
  }
  installed.push(name);
}

if (installed.length === 0) {
  console.log("No hooks to install.");
} else {
  console.log(`Installed ${installed.length} hook(s) into ${HOOKS_DIR}:`);
  for (const n of installed) console.log(`  ${n}`);
  console.log(`\nTest with:  node scripts/audit-history.mjs`);
}
