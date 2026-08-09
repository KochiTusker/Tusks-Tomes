#!/usr/bin/env node
/**
 * One-shot full-history audit across every branch + tag. Same multi-layer
 * checks the pre-push hook runs (see scripts/lib/secret-scanner.mjs).
 *
 * Usage:
 *   node scripts/audit-history.mjs
 *
 * Exit code:
 *   0 — clean
 *   1 — at least one blocking finding
 */
import { execSync } from "node:child_process";
import { dedupeFindings, runAllChecks, runGitleaksDir } from "./lib/secret-scanner.mjs";

const LAYER_LABELS = {
  filename: "Filename heuristic",
  regex: "Token-shape regex",
  gitleaks: "gitleaks (~150 rules)",
  identity: "Commit identity",
  email: "Personal email",
  path: "Local-filesystem path",
};

console.log("Scanning git history for secret patterns across all branches...\n");

const result = runAllChecks("", { allRefs: true });

const blocking = dedupeFindings(result.blocking);
const warnings = dedupeFindings(result.warnings);

// Working-tree scan: catches credentials in gitignored files (e.g. a real
// .env on disk). These can't reach the public repo via the orphan workflow
// but the user should know what's living on their filesystem. Scans BOTH
// the directory we were invoked from (where the orphan commit would be
// built from) AND the main checkout (where the user's .env etc. live) so
// running the audit from a worktree still surfaces the canonical repo's
// risk surface.
const dirsToScan = new Set();
try {
  dirsToScan.add(execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim());
} catch {
  /* outside a repo */
}
try {
  // git-common-dir is the shared .git for all worktrees. Its parent is
  // the main checkout's working tree.
  const commonDir = execSync("git rev-parse --git-common-dir", { encoding: "utf-8" }).trim();
  const abs = commonDir.endsWith(".git")
    ? commonDir.slice(0, -4).replace(/[\\/]+$/, "")
    : commonDir;
  if (abs) dirsToScan.add(abs);
} catch {
  /* worktree resolution failed */
}

let workingTreeFindings = [];
for (const dir of dirsToScan) {
  console.log(`Scanning working tree at ${dir} (gitignored files included)...`);
  workingTreeFindings.push(...(runGitleaksDir(dir) ?? []));
}
console.log("");

if (!result.gitleaksAvailable) {
  console.log("ℹ  gitleaks not installed — defence-in-depth layer skipped.");
  console.log("    Install for ~150 extra patterns:");
  console.log("      Windows : scoop install gitleaks");
  console.log("      macOS   : brew install gitleaks");
  console.log("      Linux   : https://github.com/gitleaks/gitleaks/releases\n");
}

if (warnings.length > 0) {
  console.log(`ℹ  ${warnings.length} binary file(s) in history — manual review recommended:`);
  for (const w of warnings) console.log(`     ${w.file}`);
  console.log("");
}

if (workingTreeFindings.length > 0) {
  console.log(
    `ℹ  ${workingTreeFindings.length} working-tree finding(s) — sitting on disk but NOT in git history:`,
  );
  for (const w of workingTreeFindings) {
    console.log(`     ${w.file}  (${w.detail})`);
  }
  console.log(
    "    (These can't reach the public repo via orphan-commits, but you may still want to rotate the credentials.)\n",
  );
}

if (blocking.length === 0 && workingTreeFindings.length === 0) {
  console.log("✓ No findings. History + working tree are clean of known secret shapes + risky filenames.");
  process.exit(0);
}
if (blocking.length === 0) {
  console.log("✓ No blocking findings in history. (Working-tree findings above are local-disk only.)");
  process.exit(0);
}

console.log(`⚠  ${blocking.length} blocking finding(s):\n`);

const byLayer = new Map();
for (const f of blocking) {
  if (!byLayer.has(f.layer)) byLayer.set(f.layer, []);
  byLayer.get(f.layer).push(f);
}
for (const [layer, items] of byLayer) {
  const layerLabel = LAYER_LABELS[layer] ?? layer;
  console.log(`[${layerLabel}] ${items.length} hit(s):`);
  for (const f of items) {
    if (layer === "regex" || layer === "email" || layer === "path") {
      console.log(`  ${f.commit}  ${f.file}  ${f.detail}`);
    } else if (layer === "filename") {
      console.log(`  ${f.file}  (${f.detail})`);
    } else if (layer === "identity") {
      console.log(`  ${f.commit}  ${f.detail}`);
    } else {
      console.log(`  ${f.detail.split("\n")[0]}`);
    }
  }
  console.log("");
}

console.log("Next steps:");
console.log("  1. Rotate any real credentials shown above (the dev repo is private,");
console.log("     but collaborators and your own future-self can see them).");
console.log("  2. The orphan-branch publish workflow stops these from reaching public.");
process.exit(1);
