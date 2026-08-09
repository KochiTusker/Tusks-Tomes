#!/usr/bin/env node
/**
 * Rotate the placeholder names in test fixtures. Run as a release-gate step.
 *
 * Usage:
 *   node scripts/rotate-names.mjs --check    verify the pool is still safe
 *   node scripts/rotate-names.mjs --dry-run  show what would change
 *   node scripts/rotate-names.mjs --apply    rewrite the tree
 *   node scripts/rotate-names.mjs --seed N   deterministic selection
 *
 * WHAT IT CHANGES: names, and nothing else. Every edit is a word-boundary
 * substitution of one given name for another. It does not touch structure,
 * logic, comments-about-logic, or any string that is not a slot name. A
 * rotation diff that shows anything other than names is a bug in this script.
 *
 * WHY IT EXISTS: see the header of scripts/lib/name-pool.mjs. Short version —
 * v1.3.0 leaked real players' first names into public history where they
 * cannot be deleted, so instead the fixtures churn their names every release
 * until it is impossible to tell which release (if any) held real people.
 *
 * WHAT IT IS NOT: prevention. `scripts/lib/private-names.mjs` is prevention,
 * and it fails the push gate closed. This is camouflage for what already got
 * out. If you ever have to choose, keep the denylist.
 *
 * ALWAYS RUN `npm run typecheck && npm test` AFTER A ROTATION. Two shapes are
 * known to slip past the substitution, both found the hard way on the first
 * run, and both surface as a failing assertion rather than as anything visible
 * in the diff:
 *
 *   1. `_Name_` — markdown emphasis. Underscore is a word character, so the
 *      `(?<!\w)` boundary correctly refuses to match, and a test expectation
 *      written with markdown italics keeps the old name while the fixture it
 *      mirrors gets the new one.
 *   2. `'name'` in lower case — alias-index keys are lowercased at build time.
 *      Substitution is case-sensitive, so those keys are never touched.
 *
 * Neither is worth making the regex cleverer for: widening the boundary to
 * allow `_` would let it rewrite identifiers like `some_Name_thing`, and a
 * case-insensitive pass would need case-preserving replacement to avoid
 * mangling `NAME` into `Name`. The test suite catches both in seconds, which
 * is the cheaper guarantee.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  NAME_POOL_FILE,
  ROTATION_STATE_FILE,
  loadNamePool,
  loadRotationState,
  nextAssignment,
  saveRotationState,
} from "./lib/name-pool.mjs";
import { loadPrivateNames } from "./lib/private-names.mjs";

const args = process.argv.slice(2);
const mode = args.includes("--apply")
  ? "apply"
  : args.includes("--check")
    ? "check"
    : args.includes("--verify")
      ? "verify"
      : "dry-run";
const seedArg = args.indexOf("--seed");
const seed = seedArg >= 0 ? Number(args[seedArg + 1]) : 1;

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf-8",
}).trim();

function fail(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

/**
 * The commit `public/main` currently points at, or null if it cannot be
 * resolved.
 *
 * This is the clock the rotation runs on. Not the version number: `public/main`
 * carries doc and SEO pushes as well as releases — nine commits for three
 * releases at the time of writing — so keying on a version bump would let
 * several public commits share one set of names and leave gaps in the churn.
 * A gap is the whole problem: a set that persists across commits while others
 * change looks deliberate, which is exactly the inference this defeats.
 *
 * Prefers the local remote-tracking ref so the check stays offline-capable and
 * cannot hang a pre-push hook on a dead network. `git fetch public main` is the
 * fix when it is stale, and the caller fails closed when it is missing
 * entirely.
 */
function publicHead() {
  for (const args of [
    ["rev-parse", "--verify", "--quiet", "refs/remotes/public/main"],
    ["rev-parse", "--verify", "--quiet", "public/main"],
  ]) {
    try {
      const sha = execFileSync("git", args, { encoding: "utf-8", stdio: "pipe" }).trim();
      if (sha) return sha;
    } catch {
      /* try the next form */
    }
  }
  return null;
}

/**
 * The slots that rotate.
 *
 * Characters AND the player-slot labels. Rotating only characters would leave
 * every release's player slots reading `(Player 1)`, which makes the one
 * release that held real first names the standout rather than the camouflaged
 * one — the exact opposite of the intent.
 *
 * Seeded from the names currently in the tree on first run; thereafter read
 * from .name-rotation.json.
 */
const SLOTS = [
  "pc1", "pc2", "pc3", "pc4", "pc5", "pc6", "pc7",
  "npc1", "npc2", "npc3",
  "player1", "player2", "player3", "player4", "player5",
  "player6", "player7", "player8",
];

/** Names in the tree right now, if this is the first rotation. */
const SEED_ASSIGNMENT = {
  pc1: "Grendal", pc2: "Halvard", pc3: "Merrec", pc4: "Sivo",
  pc5: "Kurogane", pc6: "Ostyn", pc7: "Malachar",
  npc1: "Lyra", npc2: "Aelar", npc3: "Wren",
  player1: "Player 1", player2: "Player 2", player3: "Player 3",
  player4: "Player 4", player5: "Player 5", player6: "Player 6",
  player7: "Player 7", player8: "Player 8",
};

const { names: pool, present } = loadNamePool(root);
if (!present) {
  fail(
    `${NAME_POOL_FILE} not found. Copy .name-pool.example to ${NAME_POOL_FILE} and fill it in. ` +
      `It is gitignored and must never be committed.`,
  );
}

const tracked = execFileSync("git", ["ls-files", "-z"], {
  encoding: "utf-8",
  maxBuffer: 256 * 1024 * 1024,
})
  .split("\0")
  .filter(Boolean);

/**
 * Is this file text? Decided from the BYTES, not the extension.
 *
 * This function exists because its absence destroyed nine PNGs and shipped
 * them. `readFileSync(f, "utf-8")` does NOT throw on binary input — Node
 * silently replaces every undecodable byte with U+FFFD. A `try/catch` around
 * it therefore catches nothing, which is exactly the mistake that was made
 * here. The file then looked like text, a rotated name happened to match
 * somewhere inside 500 KB of mangled bytes, and the "changed" file was written
 * back with `89 50 4E 47` (the PNG magic) rewritten as `EF BF BD 50 4E 47`.
 *
 * The tell is cheap and reliable: a NUL byte in the first 8 KB. No text file
 * this repo tracks contains one; essentially every binary format does within
 * its header. Extension allowlists were rejected because the failure mode of
 * a missed extension is silent corruption, whereas the failure mode of this
 * check is a text file being skipped — visible immediately as a name that did
 * not rotate.
 */
function isProbablyText(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return false;
  return true;
}

const readable = [];
const skippedBinary = [];
for (const f of tracked) {
  let buf;
  try {
    buf = readFileSync(path.join(root, f));
  } catch {
    continue; // unreadable — nothing to rotate
  }
  if (!isProbablyText(buf)) {
    skippedBinary.push(f);
    continue;
  }
  readable.push([f, buf.toString("utf-8")]);
}

/** Word-character boundaries only — NOT apostrophes. Excluding `'` would stop
 *  a name inside single quotes from matching, and `speakers: ['Grendal']` is
 *  exactly the shape these names live in. See nameMatcher() in
 *  scripts/lib/private-names.mjs, where that mistake was made and fixed. */
const boundary = (n) =>
  new RegExp(`(?<!\\w)${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\w)`, "g");

/**
 * Files the rotation must never rewrite.
 *
 * The rotation machinery and the scanner suite carry slot names as DATA and as
 * worked examples in documentation — `SEED_ASSIGNMENT` here, the speaker-tag
 * examples in the scanner comments, the fixtures in their own tests. Rewriting
 * those would silently change what the tools believe the previous assignment
 * was, and the next rotation would then fail to find the names it needs to
 * replace. Exclude them and let them keep their own vocabulary.
 */
const NEVER_ROTATE = [
  /^scripts\/rotate-names\.mjs$/,
  /^scripts\/lib\/name-pool\.mjs$/,
  /^scripts\/lib\/private-names(\.test)?\.mjs$/,
  /^scripts\/lib\/personal-info-scanner(\.test)?\.mjs$/,
  /^\.name-pool\.example$/,
  /^\.private-names\.example$/,
];
const rotatable = (f) => !NEVER_ROTATE.some((re) => re.test(f.replace(/\\/g, "/")));

// ---------------------------------------------------------------------------
// --verify — has THIS version been rotated yet?
// ---------------------------------------------------------------------------
// The release gate. Rotation only obscures anything if it actually happens
// every release; a policy that says "remember to rotate" is a policy that gets
// skipped the one time it matters. So the state file records the version it
// was made for, and this refuses any release whose version has not been
// rotated. Wired into audit-current-tree.mjs, which CLAUDE.md already requires
// immediately before building the orphan release commit.
if (mode === "verify") {
  const st = loadRotationState(root);
  if (!st) {
    fail(
      `${ROTATION_STATE_FILE} not found — the fixtures have never been rotated.\n` +
        `  Run: node scripts/rotate-names.mjs --apply`,
    );
  }
  const head = publicHead();
  if (head === null) {
    // Fail closed. "I could not check" must never read the same as "it is
    // fine" for the last gate before bytes leave the machine.
    fail(
      `cannot resolve the public remote's main branch, so rotation freshness cannot be checked.\n` +
        `  Run: git fetch public main`,
    );
  }
  if (st.sincePublic !== head) {
    fail(
      `public/main has moved since the fixtures were last rotated.\n` +
        `    rotated when public was: ${st.sincePublic ?? "(never recorded)"}\n` +
        `    public is now:           ${head}\n` +
        `  Every commit that reaches public must carry a different set of fixture names. If a\n` +
        `  push shares its names with the commit before it, the churn has a gap — and a gap is\n` +
        `  what makes one set look deliberate.\n` +
        `  Run: npm run names:rotate`,
    );
  }
  console.log(
    `✓ fixtures rotated since public/main@${head.slice(0, 7)} ` +
      `(${Object.keys(st.assignment).length} slots).`,
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// --check — the invariants, verified against reality rather than assumed
// ---------------------------------------------------------------------------
if (mode === "check") {
  let bad = 0;

  const { names: privateNames } = loadPrivateNames(root);
  const denied = new Set(privateNames.map((n) => n.toLowerCase()));
  const onDenylist = pool.filter((n) => denied.has(n.toLowerCase()));
  if (onDenylist.length) {
    console.error(`✖ ${onDenylist.length} pool name(s) are real people: ${onDenylist.join(", ")}`);
    bad += onDenylist.length;
  }

  // A pool name that already occurs in the tree would be rewritten by the next
  // rotation, corrupting real code. Names currently ASSIGNED to a slot are
  // expected to occur and are excluded from this check.
  const state = loadRotationState(root) ?? { assignment: SEED_ASSIGNMENT };
  const assigned = new Set(Object.values(state.assignment).map((n) => n.toLowerCase()));
  const collisions = [];
  for (const name of pool) {
    if (assigned.has(name.toLowerCase())) continue;
    // Both cases: the substitution rewrites `Name` and `name`, so a collision
    // in either form would corrupt code on the next rotation.
    const forms = [...new Set([name, name.toLowerCase()])];
    let count = 0;
    const where = [];
    for (const form of forms) {
      const re = boundary(form);
      for (const [f, content] of readable) {
        const hits = content.match(re);
        if (hits) {
          count += hits.length;
          if (where.length < 3) where.push(f);
        }
      }
    }
    if (count) collisions.push([name, count, where]);
  }
  for (const [n, c, where] of collisions) {
    console.error(`✖ pool name "${n}" already occurs ${c}x in the tree (${where.join(", ")})`);
  }
  bad += collisions.length;

  if (pool.length < SLOTS.length * 2) {
    console.error(
      `✖ pool has ${pool.length} names but needs at least ${SLOTS.length * 2} ` +
        `(${SLOTS.length} slots x 2) so no name repeats between consecutive releases.`,
    );
    bad++;
  }

  if (bad) fail(`${bad} problem(s) with ${NAME_POOL_FILE}. Fix before rotating.`);
  console.log(`✓ pool OK — ${pool.length} names, ${SLOTS.length} slots, no collisions.`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// rotate
// ---------------------------------------------------------------------------
const state = loadRotationState(root);
const current = state?.assignment ?? SEED_ASSIGNMENT;
const next = nextAssignment(SLOTS, pool, current, seed);

// Two-phase substitution via sentinels. A direct A->B pass can collide: if the
// new assignment maps pc1 to a name that pc4 currently holds, a naive
// sequential replace would rewrite pc4's occurrences twice and merge two
// characters. Mapping everything to unique sentinels first makes the
// substitution simultaneous, which is what it is supposed to be.
const sentinel = (slot) => `__TT_ROT_${slot}__`;

let changedFiles = 0;
let changedNames = 0;
const perFile = [];

for (const [file, original] of readable) {
  if (!rotatable(file)) continue;
  let text = original;
  for (const slot of SLOTS) {
    const from = current[slot];
    if (!from) continue;
    text = text.replace(boundary(from), sentinel(slot));
    // Also the all-lowercase form. Alias-index keys are lowercased at build
    // time (`aliases['merrec corvel']`), so a case-sensitive pass alone leaves
    // them holding the previous release's name while the fixture they mirror
    // moves on — which surfaces as a failing assertion rather than anything
    // visible in the diff. `--check` verifies the lowercase form is collision-
    // free too, so this cannot start rewriting ordinary prose.
    const lower = from.toLowerCase();
    if (lower !== from) text = text.replace(boundary(lower), sentinel(`${slot}__lc`));
  }
  // Lowercase sentinels FIRST. `sentinel("pc3")` is a strict prefix of
  // `sentinel("pc3__lc")`, so replacing the short one first rewrites the middle
  // of the long one and leaves a mangled tail behind (`Ursulalc__`). Longest
  // match wins, always — the ordering here is load-bearing, not stylistic.
  for (const slot of SLOTS) {
    text = text.split(sentinel(`${slot}__lc`)).join(next[slot].toLowerCase());
  }
  for (const slot of SLOTS) {
    text = text.split(sentinel(slot)).join(next[slot]);
  }
  if (text === original) continue;
  changedFiles++;
  // Count only lines that differ, as a cheap assertion that the diff really is
  // name-shaped: a rotation that changed line COUNT would mean the sentinel
  // pass mangled something.
  const a = original.split("\n");
  const b = text.split("\n");
  if (a.length !== b.length) {
    fail(`rotation changed the line count of ${file} — substitution corrupted the file`);
  }
  // Belt and braces: a rotation must never introduce a replacement character.
  // If one appears, the file was binary and the text round-trip destroyed it.
  if (!original.includes("�") && text.includes("�")) {
    fail(`rotation introduced U+FFFD into ${file} — it is binary and must not be rotated`);
  }
  const diffLines = a.reduce((n, line, i) => n + (line === b[i] ? 0 : 1), 0);
  changedNames += diffLines;
  perFile.push([file, diffLines]);
  if (mode === "apply") writeFileSync(path.join(root, file), text, "utf-8");
}

for (const [f, n] of perFile.sort((x, y) => y[1] - x[1]).slice(0, 15)) {
  console.log(`  ${String(n).padStart(4)} line(s)  ${f}`);
}
if (perFile.length > 15) console.log(`  … and ${perFile.length - 15} more file(s)`);

console.log(`\n${mode === "apply" ? "Rotated" : "Would rotate"} ${changedFiles} file(s), ${changedNames} line(s).`);
console.log(`Skipped ${skippedBinary.length} binary file(s) — never opened as text.`);
for (const slot of SLOTS) {
  if (current[slot] !== next[slot]) console.log(`  ${slot}: ${current[slot]} → ${next[slot]}`);
}

if (mode === "apply") {
  const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf-8")).version;
  // `sincePublic` is what --verify gates on: the public commit this rotation
  // sits after. `forRelease` is informational only — useful when reading the
  // file by hand, but the version is not the clock. See publicHead().
  saveRotationState(root, {
    seed,
    forRelease: version,
    sincePublic: publicHead(),
    assignment: next,
  });
  console.log(
    `\nWrote ${ROTATION_STATE_FILE} (gitignored).\n` +
      `NOW RUN: npm run typecheck && npm test\n` +
      `A rotation only ever changes names, so a failing test means a name collided with ` +
      `something real — check the pool with --check.`,
  );
} else {
  console.log(`\nDry run. Re-run with --apply to write.`);
}
