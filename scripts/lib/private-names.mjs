// Private-name denylist — the layer that scans for REAL PEOPLE by name.
//
// WHY THIS FILE CONTAINS NO NAMES
// ================================
// Every other scanner layer can hold its patterns in tracked source, because
// a regex for an API key is not itself an API key. That breaks down here: a
// denylist of the names you are trying to keep off the internet, committed to
// a public repo, publishes them. The check would leak exactly what it exists
// to prevent, and it would leak them in a file whose whole purpose announces
// that these are the names that matter.
//
// So the names live in `.private-names`, which is gitignored and never
// committed, and this file holds only the machinery. `.private-names.example`
// documents the format for anyone else who clones the repo.
//
// WHY THIS EXISTS AT ALL
// ======================
// The `speaker` layer in personal-info-scanner.mjs catches the SHAPE — a
// transcript speaker tag whose player slot holds something name-shaped. That
// covers the format the importer emits, which is where the v1.3.0 leak lived.
// It does not cover a real name written anywhere else: in a comment, in prose,
// in a variable, in a commit message. This layer does, for the specific names
// the maintainer has declared, and it is deliberately blunt about it.
//
// FAILURE MODE, AND THE ASYMMETRY THAT HANDLES IT
// ================================================
// A denylist that silently no-ops when its data file goes missing is worse
// than no denylist, because it reads as protection. But the file genuinely is
// absent for contributors, who must still be able to build and test. So:
//
//   - Tree audit / site build: absent list → loud warning, not a failure.
//   - Push to the public remote: absent list → HARD FAILURE. Only the
//     maintainer pushes there, and for the maintainer "the file vanished" is
//     never the intended state.
//
// That asymmetry is the whole design. Read `requireList` at each call site as
// "is this the last gate before bytes leave the machine?".

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const PRIVATE_NAMES_FILE = ".private-names";

/** Files that are allowed to mention a denylisted name: the list itself, and
 *  anything that exists to document the list's own format. */
const SELF_REFERENTIAL = [/(^|\/)\.private-names$/, /(^|\/)\.private-names\.example$/];

/**
 * Read the denylist. Returns `{ names, present }`.
 *
 * Format is one entry per line, `#` for comments, blank lines ignored — the
 * same shape as `.personalignore`, so there is one convention to learn rather
 * than two. Entries are matched case-insensitively on word boundaries.
 */
export function loadPrivateNames(repoRoot) {
  const file = path.join(repoRoot, PRIVATE_NAMES_FILE);
  if (!existsSync(file)) return { names: [], present: false };
  const names = readFileSync(file, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  return { names, present: true };
}

/** Escape a name for use in a regex. Names contain apostrophes and hyphens
 *  (Ta'ir, Anne-Marie), which are regex-inert but must not be assumed so. */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Build the matcher for one name.
 *
 * Anchored on word characters only — NOT on apostrophes.
 *
 * This was got wrong once and the bug was invisible: excluding `'` from the
 * lookbehind meant a name inside single quotes never matched, so
 * `speakers: ['Bram', 'Coledge']` — an array of first names in a fixture —
 * sailed past the layer built to catch exactly that. Quoted string literals are
 * where names in source code overwhelmingly live, so the exclusion blinded the
 * scanner to its own primary target while still passing every test written for
 * it. If you are tempted to add `'` back, write the quoted-array case first.
 *
 * `\w` alone is sufficient for every shape a given name takes:
 *   - `Ta'ir` matches in `Ta'ir said hi` (preceded by space).
 *   - `Ta'ir` does NOT match in `Ta'irs` (followed by `s`, a word char).
 *   - `Bram` does NOT match in `Bramble`.
 *   - `Bram` DOES match in `'Bram'` — the surrounding quotes are not word
 *     characters, which is the whole point.
 *   - `Grendal` matches in `Grendal's`, so possessives get substituted too.
 */
export function nameMatcher(name) {
  return new RegExp(`(?<!\\w)${escapeRe(name)}(?!\\w)`, "gi");
}

/** Scan one file's content for denylisted names. */
export function scanLinesForPrivateNames(file, content, names, commit = "") {
  if (!names.length) return [];
  const normalised = String(file).replace(/\\/g, "/");
  if (SELF_REFERENTIAL.some((re) => re.test(normalised))) return [];

  const findings = [];
  const lines = content.split("\n");
  for (const name of names) {
    const re = nameMatcher(name);
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      if (!re.test(lines[i])) continue;
      findings.push({
        layer: "private-name",
        commit,
        file,
        line: i + 1,
        // The finding names the person, because the operator reading it needs
        // to know who. It is printed to a terminal, never written to a file.
        detail: `line ${i + 1}: real person's name "${name}" — must not ship`,
      });
    }
  }
  return findings;
}

/** Diff-walking form, for the push-range gate. Added lines only: a name being
 *  REMOVED is the remediation, not a new finding. */
export function scanContentForPrivateNames(diffText, names) {
  if (!names.length) return [];
  const findings = [];
  let currentCommit = "";
  let currentFile = "";
  for (const line of diffText.split("\n")) {
    if (line.startsWith("commit ")) {
      currentCommit = line.slice(7, 14);
    } else if (line.startsWith("+++ b/")) {
      currentFile = line.slice(6);
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      findings.push(
        ...scanLinesForPrivateNames(currentFile, line.slice(1), names, currentCommit),
      );
    }
  }
  return findings;
}

/**
 * Resolve the list for a caller, applying the asymmetry described in the
 * header. Throws when the list is required and missing; otherwise returns the
 * names plus a warning string the caller should surface.
 */
export function resolvePrivateNames(repoRoot, { requireList = false } = {}) {
  const { names, present } = loadPrivateNames(repoRoot);
  if (!present) {
    if (requireList) {
      throw new Error(
        `${PRIVATE_NAMES_FILE} not found. This is the gate that keeps real people's names ` +
          `out of the public repo, and it cannot pass without its list.\n` +
          `  Copy ${PRIVATE_NAMES_FILE}.example to ${PRIVATE_NAMES_FILE} and fill it in. ` +
          `It is gitignored and must never be committed.`,
      );
    }
    return {
      names: [],
      warning:
        `${PRIVATE_NAMES_FILE} not found — the private-name layer is INACTIVE. ` +
        `Expected for a contributor clone; if you are the maintainer, restore it before publishing.`,
    };
  }
  if (!names.length) {
    return {
      names: [],
      warning: `${PRIVATE_NAMES_FILE} exists but lists no names — the private-name layer is inactive.`,
    };
  }
  return { names, warning: null };
}
