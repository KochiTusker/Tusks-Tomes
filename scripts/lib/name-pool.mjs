// Rotation pool — the placeholder names fixtures draw from, and the state
// recording which ones are currently in the tree.
//
// WHY ROTATE AT ALL
// =================
// Version 1.3.0 shipped with real players' first names in probe fixtures.
// Those bytes are in `public/main`'s history permanently: removing them means
// rewriting public history, which breaks `git pull --ff-only` for every
// existing install at once.
//
// Rotation does not remove them. It makes them UNFALSIFIABLE. If the names in
// the fixtures change wholesale every release, then a reader walking the
// history sees a churn of given names in every version — and the v1.3.0 set
// stops standing out as "the real ones" and reads as one more turn of the
// wheel. You cannot tell, from the outside, which release (if any) held real
// people. That is the entire point, and it is why the pool must be ordinary
// human given names from a spread of origins rather than fantasy names: the
// leaked set has to blend into the pool, not contrast with it.
//
// It is also why the PLAYER SLOT rotates, not just character names. A player
// slot holding `(Player 1)` in every release would make the one leaked release
// the anomaly rather than camouflage it.
//
// WHAT THIS IS NOT
// ================
// This is not the control that keeps real names out. That is
// `scripts/lib/private-names.mjs` — a gitignored denylist that fails the push
// gate closed. Rotation is camouflage for what already leaked; the denylist is
// prevention. Neither substitutes for the other, and if you ever have to drop
// one, drop this one.
//
// TWO INVARIANTS, BOTH ENFORCED AT LOAD
// =====================================
//   1. No pool name may appear in `.private-names`. A rotation that assigned a
//      real person's name to a fixture would be the original bug, automated.
//   2. No pool name may already occur in the tracked tree. Substitution is a
//      word-boundary find-and-replace over source; a pool name that collides
//      with an identifier or an English word would corrupt real code on the
//      next rotation. `--check` re-verifies this.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadPrivateNames } from "./private-names.mjs";

export const NAME_POOL_FILE = ".name-pool";
export const ROTATION_STATE_FILE = ".name-rotation.json";

/** Parse a `#`-commented, one-per-line list. Same shape as `.private-names`
 *  and `.personalignore`, so there is one convention rather than three. */
function readList(file) {
  return readFileSync(file, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

/**
 * Load the pool and enforce invariant 1.
 *
 * Throws rather than filtering on overlap. A silent filter would let the pool
 * quietly shrink toward empty while every gate still reported success, and the
 * operator would never learn that a name they added was rejected.
 */
export function loadNamePool(repoRoot) {
  const file = path.join(repoRoot, NAME_POOL_FILE);
  if (!existsSync(file)) return { names: [], present: false };
  const names = readList(file);

  const { names: privateNames } = loadPrivateNames(repoRoot);
  const denied = new Set(privateNames.map((n) => n.toLowerCase()));
  const overlap = names.filter((n) => denied.has(n.toLowerCase()));
  if (overlap.length) {
    throw new Error(
      `${NAME_POOL_FILE} contains ${overlap.length} name(s) that are also in .private-names: ` +
        `${overlap.join(", ")}.\n` +
        `  The pool is placeholders; the denylist is real people. A name cannot be both, and ` +
        `rotating a real person's name into a fixture is the exact bug this suite exists to stop.`,
    );
  }

  const seen = new Set();
  const dupes = names.filter((n) => {
    const k = n.toLowerCase();
    if (seen.has(k)) return true;
    seen.add(k);
    return false;
  });
  if (dupes.length) {
    throw new Error(
      `${NAME_POOL_FILE} has duplicate entries: ${[...new Set(dupes)].join(", ")}. ` +
        `Duplicates skew the rotation and can assign one name to two slots.`,
    );
  }

  return { names, present: true };
}

/** The names currently placed in the tree, by slot. Absent before the first
 *  rotation, in which case the caller seeds it from the current fixtures. */
export function loadRotationState(repoRoot) {
  const file = path.join(repoRoot, ROTATION_STATE_FILE);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf-8"));
}

export function saveRotationState(repoRoot, state) {
  writeFileSync(
    path.join(repoRoot, ROTATION_STATE_FILE),
    `${JSON.stringify(state, null, 2)}\n`,
    "utf-8",
  );
}

/**
 * Choose the next assignment.
 *
 * Two properties matter and neither is aesthetic:
 *
 *   - No name may repeat within one release. Two slots sharing a name would
 *     merge two characters in the fixtures and change behaviour, not just
 *     labels.
 *   - No name may carry over from the previous release. A name that survived a
 *     rotation would look deliberate — the one fixed point in a churning set is
 *     exactly the thing an observer would flag as real.
 *
 * Selection is deterministic given `seed`, so a rotation can be reproduced and
 * reviewed rather than being a one-way surprise in a diff.
 */
export function nextAssignment(slots, pool, previous = {}, seed = 0) {
  const prior = new Set(Object.values(previous).map((n) => String(n).toLowerCase()));
  const available = pool.filter((n) => !prior.has(n.toLowerCase()));
  if (available.length < slots.length) {
    throw new Error(
      `rotation needs ${slots.length} names that were not used last release, but only ` +
        `${available.length} of the pool's ${pool.length} qualify. Add more names to ` +
        `${NAME_POOL_FILE}.`,
    );
  }
  // Deterministic shuffle — a small LCG, seeded. Not cryptographic and does
  // not need to be: the requirement is "different every release and
  // reproducible from the seed", not unpredictability.
  let s = (seed >>> 0) || 1;
  const rand = () => ((s = (s * 1103515245 + 12345) >>> 0) / 0x100000000);
  const shuffled = available.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return Object.fromEntries(slots.map((slot, i) => [slot, shuffled[i]]));
}
