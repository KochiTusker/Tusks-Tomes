#!/usr/bin/env node
/**
 * Pre-push gate for the `public` remote. Reads git's standard pre-push
 * stdin format and runs the full multi-layer secret scanner against the
 * commits being pushed. See scripts/lib/secret-scanner.mjs for the
 * individual checks.
 *
 * Stdin format (one line per ref being pushed):
 *   <local-ref> SP <local-sha> SP <remote-ref> SP <remote-sha>
 *
 * Exit code:
 *   0 — clean, push proceeds
 *   1 — at least one blocking finding, push is aborted
 *
 * Hooks should be quiet on the happy path; binary-file warnings are
 * printed regardless because they need human review even when no other
 * layer fired.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dedupeFindings, runAllChecks } from "./lib/secret-scanner.mjs";
import { checkFastForward } from "./lib/fast-forward-guard.mjs";

const LAYER_LABELS = {
  filename: "Filename heuristic",
  regex: "Token-shape regex",
  gitleaks: "gitleaks (~150 rules)",
  identity: "Commit identity",
  email: "Personal email",
  path: "Local-filesystem path",
  speaker: "Player name in speaker tag",
  "private-name": "REAL PERSON'S NAME",
  "fast-forward": "Breaks the in-app updater",
};

const ZERO_SHA = "0000000000000000000000000000000000000000";

const stdin = readFileSync(0, "utf-8");
const refLines = stdin.split("\n").filter((l) => l.trim());

if (refLines.length === 0) {
  // No refs being pushed (unusual — git always sends at least one). Allow.
  process.exit(0);
}

const blocking = [];
const warnings = [];
let gitleaksRan = false;
let gitleaksMissing = false;

for (const line of refLines) {
  const [, localSha, , remoteSha] = line.split(" ");

  // Deletion — nothing to scan.
  if (localSha === ZERO_SHA) continue;

  // New branch on remote: scan everything reachable from local-sha.
  // Force-push or update: scan only the new commits (remote-sha..local-sha).
  // For an orphan branch the range still works — Git lists every commit
  // reachable from local-sha but not from remote-sha (i.e. all of it).
  const range = remoteSha === ZERO_SHA ? localSha : `${remoteSha}..${localSha}`;

  let result;
  try {
    result = runAllChecks(range);
  } catch {
    // git log can fail if the remote-sha isn't in our object store (e.g.
    // first push to a brand-new remote we've never fetched from). Fall
    // back to scanning the full ancestry of local-sha.
    result = runAllChecks(localSha);
  }

  blocking.push(...result.blocking);
  warnings.push(...result.warnings);
  if (result.gitleaksAvailable) {
    gitleaksRan = true;
  } else {
    gitleaksMissing = true;
  }
}

// Fast-forward guard — pushes to `refs/heads/main` ONLY. The logic lives in
// scripts/lib/fast-forward-guard.mjs so it can be unit-tested against a fake
// git runner; see that file for why it exists and why gh-pages is exempt.
blocking.push(...checkFastForward(refLines, (args) => spawnSync("git", args).status ?? 1));

// Rotation freshness — pushes to `refs/heads/main` ONLY.
//
// The hook fires for every branch pushed to `public`, and `gh-pages` is pushed
// separately by scripts/site/publish-site.mjs. Scoping matters because of the
// order those two happen in: pushing the release advances `public/main`, which
// immediately makes the recorded rotation stale, so an unscoped check would
// then block the documentation-site push that follows — a deadlock reachable
// only during a real release, i.e. the worst possible time to discover it.
//
// gh-pages carries built HTML and no fixtures, so there is nothing there for a
// rotation to churn. Only `main` needs the check.
if (refLines.some((l) => l.split(" ")[2] === "refs/heads/main")) {
  const r = spawnSync(process.execPath, ["scripts/rotate-names.mjs", "--verify"], {
    encoding: "utf-8",
  });
  if (r.status !== 0) {
    blocking.push({
      layer: "rotation",
      file: ".name-rotation.json",
      detail: (r.stderr || r.stdout || "rotation check failed").trim().replace(/\s+/g, " "),
    });
  }
}

const blockingUnique = dedupeFindings(blocking);
const warningsUnique = dedupeFindings(warnings);

// ----- Output -----

if (gitleaksMissing && !gitleaksRan) {
  // Show this once at the top so users know they're on the regex-only
  // tier. Don't block — gitleaks is best-effort, not required.
  console.error("");
  console.error(
    "ℹ  gitleaks not installed — defence-in-depth layer skipped. Install for ~150 extra patterns:",
  );
  console.error("     Windows : scoop install gitleaks");
  console.error("     macOS   : brew install gitleaks");
  console.error("     Linux   : https://github.com/gitleaks/gitleaks/releases");
  console.error("");
}

if (warningsUnique.length > 0) {
  console.error("");
  console.error(
    `ℹ  ${warningsUnique.length} binary file(s) in this push — verify they don't embed secrets:`,
  );
  for (const w of warningsUnique) console.error(`     ${w.file}`);
  console.error("");
}

if (blockingUnique.length === 0) {
  process.exit(0);
}

console.error("");
console.error(
  `⚠  Push BLOCKED — ${blockingUnique.length} blocking finding(s) across ${refLines.length} ref(s):`,
);
console.error("");

// Group by layer for legibility.
const byLayer = new Map();
for (const f of blockingUnique) {
  if (!byLayer.has(f.layer)) byLayer.set(f.layer, []);
  byLayer.get(f.layer).push(f);
}

for (const [layer, items] of byLayer) {
  const layerLabel = LAYER_LABELS[layer] ?? layer;
  console.error(`  [${layerLabel}] ${items.length} hit(s):`);
  for (const f of items) {
    if (layer === "regex" || layer === "email" || layer === "path") {
      console.error(`    ${f.commit}  ${f.file}  ${f.detail}`);
    } else if (layer === "filename") {
      console.error(`    ${f.file}  (${f.detail})`);
    } else if (layer === "identity") {
      console.error(`    ${f.commit}  ${f.detail}`);
    } else {
      console.error(`    ${f.detail.split("\n")[0]}`);
    }
  }
  console.error("");
}

console.error("Aborting. To unblock:");
console.error("  1. Rotate any real credentials shown above (assume they're compromised).");
console.error("  2. Remove the offending files from the staged tree, or rewrite history.");
console.error("  3. Re-run the push.");
console.error("");
console.error("To bypass (DANGEROUS — only if you've verified the findings are false positives):");
console.error("  git push --no-verify");
console.error("");
process.exit(1);
