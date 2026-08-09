#!/usr/bin/env node
/**
 * Audit ONLY the current working tree — exactly the state an orphan
 * commit would publish. Catches findings that the next public release
 * would actually carry, ignoring anything that lived in dev history but
 * has since been removed.
 *
 * Usage:
 *   node scripts/audit-current-tree.mjs            — public-release mode
 *   node scripts/audit-current-tree.mjs --dev-mode — dev-CI mode (allows
 *     dev-only docs like CLAUDE.md to pass; everything else still gates)
 *
 * Exit code:
 *   0 — clean, safe to build an orphan commit
 *   1 — at least one blocking finding in the current tree
 *
 * Companion to audit-history.mjs (which scans everything ever) and the
 * pre-push hook (which scans only the commits being pushed). Run the
 * default mode immediately before `git checkout --orphan release-tmp`;
 * run --dev-mode on every PR in CI to catch credentials / personal
 * identifiers / token shapes before they accumulate.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  checkForbiddenFilenames,
  scanLinesForTokens,
  runGitleaksDir,
} from "./lib/secret-scanner.mjs";
import {
  scanLinesForEmails,
  scanLinesForLocalPaths,
  scanLinesForSpeakerNames,
} from "./lib/personal-info-scanner.mjs";
import {
  resolvePrivateNames,
  scanLinesForPrivateNames,
} from "./lib/private-names.mjs";
import { loadRotationState } from "./lib/name-pool.mjs";

const DEV_MODE = process.argv.includes("--dev-mode");

// Filename-layer findings to ignore under --dev-mode: these flags
// exist specifically to block dev-only files from reaching the public
// orphan commit, but the dev repo SHOULD ship them. The substring
// "(dev-only" appears in every dev-only filename label; matching on
// that keeps the security-relevant filename hits (`.env`, `.pem`,
// `credentials.json` etc.) blocking even in dev-mode.
const DEV_MODE_FILENAME_FILTER = /\(dev-only/i;

const LAYER_LABELS = {
  filename: "Filename heuristic",
  regex: "Token-shape regex",
  gitleaks: "gitleaks (~150 rules)",
  email: "Personal email",
  path: "Local-filesystem path",
  speaker: "Player name in speaker tag",
  "private-name": "REAL PERSON'S NAME",
  rotation: "Fixture-name rotation",
  "working-tree": "gitleaks working-tree (gitignored files)",
};

let repoRoot;
try {
  repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf-8",
  }).trim();
} catch {
  console.error("Not in a git repo.");
  process.exit(2);
}

console.log(`Auditing current working tree at ${repoRoot}\n`);

// 1. Tracked files via `git ls-files -z` — NUL-delimited so newlines /
//    quotes / shell metacharacters in filenames are handled correctly.
//    execFileSync with argv-form avoids the command-injection class
//    (a hostile filename containing `;`, backticks, `$()` etc. won't
//    extend the command line).
//    UNTRACKED-but-not-ignored files are included too, via
//    `--others --exclude-standard`. This script's contract is "exactly what an
//    orphan commit would publish", and that commit is built with `git add -A`,
//    which stages new files as readily as modified ones. Scanning only tracked
//    files meant a brand-new file could carry anything at all and report clean
//    right up until the moment it shipped — found when this very audit passed a
//    tree in which two new scanner files contained real first names in their
//    own documentation examples. Ignored files stay out: they are genuinely
//    absent from the commit, and that is what `--exclude-standard` gives us.
let trackedFiles = [];
try {
  trackedFiles = execFileSync("git", ["ls-files", "-z", "--cached"], {
    encoding: "utf-8",
    maxBuffer: 50 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean);
} catch {
  /* fall through with empty list */
}

// Untracked-but-not-ignored files are reported, NOT blocked.
//
// The blocking scan reads the INDEX, because the index is precisely what
// `git commit` writes and therefore precisely what ships. That distinction is
// load-bearing during a release: the orphan workflow runs `git add -A` and then
// `git rm --cached` on the dev-only docs, which leaves those files on disk but
// out of the commit. A scan that blocked on anything present on disk would flag
// them forever and the exclusion step could never pass.
//
// But a brand-new file that has not been `git add`ed yet is invisible to the
// index, and on a dev branch that is a genuine blind spot. So it is surfaced
// here as information — loud enough to notice, not a gate. If it matters, stage
// it and re-run.
let untrackedFiles = [];
try {
  untrackedFiles = execFileSync("git", ["ls-files", "-z", "--others", "--exclude-standard"], {
    encoding: "utf-8",
    maxBuffer: 50 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean);
} catch {
  /* nothing to report */
}

// 2. Run the scanners directly per-file. Previously we built a
//    synthetic `+commit … +++ b/file` diff string and re-parsed it
//    through the same diff scanners gitleaks/git-log used — but a
//    tracked file containing the literal text `commit deadbeef` or
//    `+++ b/other-file` would desync the parser's state, silently
//    skipping subsequent files. Per-file iteration eliminates that
//    failure mode entirely.
let filenameFindings = checkForbiddenFilenames(trackedFiles);
if (DEV_MODE) {
  filenameFindings = filenameFindings.filter(
    (f) => !DEV_MODE_FILENAME_FILTER.test(f.detail),
  );
}
const tokenFindings = [];
const emailFindings = [];
const pathFindings = [];
const speakerFindings = [];
const privateNameFindings = [];
// Warns rather than throws when the list is missing: a contributor clone
// legitimately has none. The public-push gate is where its absence is fatal.
const { names: privateNames, warning: privateNameWarning } = resolvePrivateNames(repoRoot);
if (privateNameWarning) console.log(`⚠  ${privateNameWarning}`);
// Names the rotation legitimately placed in speaker slots — see
// scripts/lib/name-pool.mjs. Validated against .private-names at load.
const rotationNames = Object.values(loadRotationState(repoRoot)?.assignment ?? {});
// Content comes from DISK, not from `git show HEAD:<file>`.
//
// This script's entire contract — see the header, and the name — is "exactly
// the state an orphan commit would publish". The orphan commit is built by
// `git add -A` over the working tree, so the working tree is what must be
// scanned. Reading HEAD instead got it wrong in both directions: a secret
// added to a tracked file but not yet committed reported CLEAN (the dangerous
// direction, and the whole point of the gate), and a fix to a flagged line
// kept failing until it was committed.
//
// A tracked file missing from disk has been deleted; `git add -A` stages that
// deletion, so it is correctly absent from the commit and there is nothing to
// scan.
for (const f of trackedFiles) {
  let content;
  try {
    content = readFileSync(path.join(repoRoot, f), "utf-8");
  } catch {
    continue;
  }
  tokenFindings.push(...scanLinesForTokens(f, content));
  emailFindings.push(...scanLinesForEmails(f, content));
  pathFindings.push(...scanLinesForLocalPaths(f, content));
  speakerFindings.push(
    ...scanLinesForSpeakerNames(f, content, "", { allowNames: rotationNames }),
  );
  privateNameFindings.push(...scanLinesForPrivateNames(f, content, privateNames));
}

// 2b. Rotation freshness — RELEASE PATH ONLY.
//
//     Rotation only obscures anything if it happens every release. A policy
//     that says "remember to rotate" is one that gets skipped the one time it
//     matters, and a single un-rotated release restores the contrast that the
//     whole scheme exists to destroy. So it is a gate, checked here because
//     CLAUDE.md already requires this script immediately before the orphan
//     commit is built.
//
//     --dev-mode skips it: a dev CI run has no release to rotate for, and
//     failing every PR on it would train people to ignore this script.
const rotationFindings = [];
if (!DEV_MODE) {
  const r = spawnSync(process.execPath, ["scripts/rotate-names.mjs", "--verify"], {
    cwd: repoRoot,
    encoding: "utf-8",
  });
  if (r.status !== 0) {
    rotationFindings.push({
      layer: "rotation",
      file: ".name-rotation.json",
      detail: (r.stderr || r.stdout || "rotation check failed").trim().replace(/\s+/g, " "),
    });
  }
}

// 3. gitleaks against the actual working tree (catches gitignored
//    files like a real .env — informational, not blocking, since the
//    orphan workflow doesn't include gitignored content).
const workingTreeFindings = runGitleaksDir(repoRoot) ?? [];

// ----- Output -----

const blocking = [
  ...filenameFindings,
  ...tokenFindings,
  ...emailFindings,
  ...pathFindings,
  ...speakerFindings,
  ...privateNameFindings,
  ...rotationFindings,
];

if (workingTreeFindings.length > 0) {
  console.log(
    `ℹ  ${workingTreeFindings.length} working-tree finding(s) — gitignored files on disk:`,
  );
  for (const w of workingTreeFindings) {
    console.log(`     ${w.file}  (${w.detail})`);
  }
  console.log(
    "    (These won't reach public — gitignored content isn't in orphan commits — but rotate the credentials anyway.)\n",
  );
}

// Scanned the index, so anything not staged was not scanned. Say so, rather
// than letting a clean tick imply coverage it does not have.
if (untrackedFiles.length > 0) {
  const shown = untrackedFiles.slice(0, 10);
  console.log(
    `ℹ  ${untrackedFiles.length} untracked file(s) NOT scanned — they are not in the index, so ` +
      `they are not in the commit either:`,
  );
  for (const f of shown) console.log(`     ${f}`);
  if (untrackedFiles.length > shown.length) {
    console.log(`     …and ${untrackedFiles.length - shown.length} more`);
  }
  console.log("    (`git add` them and re-run if any are meant to ship.)\n");
}

if (blocking.length === 0) {
  console.log("✓ Current tree is clean. Safe to build an orphan commit and push to public.");
  process.exit(0);
}

console.log(`⚠  ${blocking.length} blocking finding(s) in the current tree:\n`);

const byLayer = new Map();
for (const f of blocking) {
  if (!byLayer.has(f.layer)) byLayer.set(f.layer, []);
  byLayer.get(f.layer).push(f);
}
for (const [layer, items] of byLayer) {
  const label = LAYER_LABELS[layer] ?? layer;
  console.log(`[${label}] ${items.length} hit(s):`);
  for (const f of items) {
    if (layer === "filename") {
      console.log(`  ${f.file}  (${f.detail})`);
    } else {
      console.log(`  ${f.file}  ${f.detail}`);
    }
  }
  console.log("");
}

console.log("These will land in your next orphan commit. Remove them from the");
console.log("working tree before building the release-tmp branch:");
console.log("  - Edit the offending files to remove the content.");
console.log("  - Run this audit again to confirm.");
console.log("  - Then proceed with the orphan-commit workflow.");
process.exit(1);
