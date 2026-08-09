// Personal-info scanner — fifth blocking layer for the public-remote
// push gate. Catches things the secret-shape regex and gitleaks don't:
//
//   - Email addresses outside the public-alias allowlist (real personal
//     emails accidentally committed to docs, commit messages, etc.).
//   - Local filesystem paths that include a real Windows / POSIX
//     username (a stray `/Users/<actualname>/` in a script or log).
//   - Commit authors / committers other than the public alias.
//
// Placeholder forms (`<you>`, `<your-name>`, `${USER}`, etc.) are
// allowlisted explicitly because they're documentation patterns.

import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  resolvePrivateNames,
  scanContentForPrivateNames,
} from "./private-names.mjs";
import { loadRotationState } from "./name-pool.mjs";

// ----- Configuration -----
//
// The single public identity Tomes is allowed to ship. Anything else is
// a finding. If contributors are added later, append their public-alias
// noreply addresses here.
export const ALLOWED_AUTHORS = ["KochiTusker"];
const ALLOWED_EMAIL_PATTERNS = [
  /^[0-9]+\+KochiTusker@users\.noreply\.github\.com$/i,
  /@users\.noreply\.github\.com$/i,
  /^noreply@github\.com$/i,
  /^noreply@anthropic\.com$/i, // Claude Co-Authored-By line
  /^[^@]+@example\.(com|org|net)$/i,
  /^test@test(\.|$)/i,
];

// Local-path patterns that leak username info. The PLACEHOLDER_RE list
// allowlists documentation forms like `/Users/<you>/` or `${HOME}`.
//
// Backslashes use `\\+` (one or more) so we match BOTH the raw-bytes
// form `C:\Users\<name>\` AND the JS-source-escaped form
// `C:\\Users\\<name>\\` that appears in tracked .mjs / .ts string
// literals. A single-backslash regex misses doubled-backslash JS
// string literals — a previous regression at
// scripts/safety-probe/test-fusion-and-layerC.mjs.
const PATH_PATTERNS = [
  // POSIX: /Users/<name>/  or  /home/<name>/  (require a trailing
  // separator or end-of-string so we don't false-positive on prose).
  { re: /\/Users\/[^/<>"'$\s{]+(?:\/|$|"|')/g, kind: "POSIX /Users path" },
  { re: /\/home\/[^/<>"'$\s{]+(?:\/|$|"|')/g, kind: "POSIX /home path" },
  // Windows: C:\Users\<name>\  or  C:/Users/<name>/
  { re: /[A-Z]:\\+Users\\+[^\\<>"'$\s{]+(?:\\+|$|"|')/g, kind: "Windows Users path" },
  { re: /[A-Z]:\/Users\/[^/<>"'$\s{]+(?:\/|$|"|')/g, kind: "Windows Users path (forward-slash)" },
];

const PLACEHOLDER_RE =
  /<[a-z]+>|&lt;[a-z]+&gt;|\$\{[A-Z_]+\}|\$[A-Z_]+|your-?name|yourname|placeholder/i;

/**
 * Transcript speaker tags — the bracketed `Character (speaker-label)` form.
 *
 * THE GAP THIS CLOSES: every other layer in this scanner protects the
 * MAINTAINER. Emails, filesystem paths, commit identity — all of them ask "is
 * this me?". None of them asks "is this somebody else?". So 110 occurrences of
 * seven real first names sat in probe fixtures across nine files and shipped in
 * a public release, because a first name in a parenthetical is not a
 * credential, not a path, and not an author field. Nothing was bypassed; the
 * check did not exist.
 *
 * It is matched by SHAPE and not by a list of names, and that is deliberate
 * rather than lazy. A denylist of the actual names would mean committing those
 * names to a public repo in order to detect them — the check would publish the
 * thing it exists to prevent. So this flags the format the Craig/Whisper
 * importer emits, character followed by a parenthesised speaker label, whenever that label
 * looks like a person rather than an obvious stand-in.
 *
 * Anything a reviewer intends as a placeholder passes: `Player`, `Player 2`,
 * `DM`, `PlayerName`, `Name`, `Speaker`, `<name>`, `$USER`. A bare capitalised
 * word does not. False positives are cheap — rename to `Player N` — and the
 * false negative is a friend's name on the public internet.
 */
// The trailing `(?!\()` excludes markdown links, which share this shape
// exactly: `[Claude Code (your subscription)](https://…)` is indistinguishable
// from a speaker tag until you look at the character after the closing bracket.
// A link is followed by `(`; a speaker tag is followed by the dialogue. Without
// this, the generated llms.txt blocked its own publish on three doc links —
// a false positive in the one place a reviewer is most likely to reach for
// --no-verify, since the finding names a product feature rather than a person.
const SPEAKER_TAG_RE = /\[[A-Za-z' .-]{2,40} \(([^)\n]{1,40})\)\](?!\()/g;

/** Speaker labels that are unmistakably stand-ins rather than people. */
const SPEAKER_LABEL_ALLOW_RE =
  /^(?:player|speaker|dm|gm|narrator|dungeon master|name|playername|charactername|unknown|anon(?:ymous)?|character|npc|host|guest)(?:[\s_-]*\d+)?$/i;

// Files where email-pattern matches are too noisy to be useful:
// dependency lockfiles carry author metadata for every dependency. The
// secret-shape regex and gitleaks still scan these; only the
// personal-email layer is muted.
const EMAIL_SCAN_FILE_DENYLIST = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
];

// Email regex. The TLD pattern accepts any 2–24-character alphabetic
// suffix so `.ch`, `.de`, `.tech`, `.cloud`, future gTLDs etc. don't
// quietly slip through. False positives (e.g. `@vitejs/plugin-react`,
// `@/components`) are suppressed by requiring a literal `.<tld>` after
// `@<host-chars>` — package import specifiers don't match because
// there's no `.<letters>` after the `/`.
const EMAIL_RE = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,24}\b/g;

/** True when `name`/`email` are a public identity this project is allowed
 *  to ship. The single source of truth for both the push-range gate
 *  (below) and the site publisher's pre-flight check — so a stamped
 *  identity can never drift from what the gate will accept. */
export function isAllowedIdentity(name, email) {
  if (!name || !email) return false;
  return (
    ALLOWED_AUTHORS.includes(name) &&
    ALLOWED_EMAIL_PATTERNS.some((re) => re.test(email))
  );
}

// ----- Check 1: commit authors -----

/** Walk `git log` and flag any commit whose author or committer doesn't
 *  match the project's allowlist of public identities. The push-range
 *  scan is the *only* gate that runs before bytes hit the public
 *  remote, so this MUST be invoked on every push (not just full-history
 *  audits) — a stray dev `git config user.email` is otherwise
 *  exfiltrated forever.
 *
 *  Pass `{ allRefs: true }` for a whole-repo audit, or `{ range }` for
 *  a push-range scan ("base..head"). Empty arguments → empty findings. */
export function checkCommitIdentities({ range, allRefs = false } = {}) {
  const findings = [];
  if (!allRefs && !range) return findings;
  let log;
  try {
    // Format separator: unicode bullet — must NOT contain `<` or `>`
    // because some shells (Windows cmd) parse those as redirection.
    // execFileSync with argv form sidesteps any quoting / shell-parse
    // weirdness regardless of remote name or range contents.
    const argv = ["log"];
    if (allRefs) argv.push("--all");
    else argv.push(range);
    argv.push("--format=%an•%ae•%cn•%ce•%H");
    log = execFileSync("git", argv, {
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch {
    return findings;
  }
  for (const line of log.split("\n").filter(Boolean)) {
    const parts = line.split("•");
    if (parts.length < 5) continue;
    const [an, ae, cn, ce, sha] = parts;
    const ident = (
      name,
      email,
      role,
    ) => {
      if (!name || !email) return;
      // Granular flags drive the message; isAllowedIdentity is the verdict
      // so this gate and the publisher's pre-flight can't disagree.
      const nameOk = ALLOWED_AUTHORS.includes(name);
      const emailOk = ALLOWED_EMAIL_PATTERNS.some((re) => re.test(email));
      if (!isAllowedIdentity(name, email)) {
        findings.push({
          layer: "identity",
          commit: sha.slice(0, 7),
          file: "<commit-metadata>",
          detail: `${role}: ${name} <${email}>${nameOk ? "" : " [unexpected name]"}${
            emailOk ? "" : " [unexpected email]"
          }`,
        });
      }
    };
    ident(an, ae, "author");
    ident(cn, ce, "committer");
  }
  return findings;
}

// ----- Check 2: emails in tracked file content -----

/** Scan a single file's content for personal emails. Audit-current-tree
 *  uses this directly (skip the synthetic-diff middle layer that could
 *  be desynced by file content). */
export function scanLinesForEmails(file, content, commit = "") {
  const findings = [];
  if (EMAIL_SCAN_FILE_DENYLIST.some((re) => re.test(file))) return findings;
  for (const line of content.split("\n")) {
    EMAIL_RE.lastIndex = 0;
    let m;
    while ((m = EMAIL_RE.exec(line)) !== null) {
      const email = m[0];
      if (ALLOWED_EMAIL_PATTERNS.some((re) => re.test(email))) continue;
      findings.push({
        layer: "email",
        commit,
        file,
        detail: email,
      });
    }
  }
  return findings;
}

export function scanContentForEmails(diffText) {
  const findings = [];
  let currentCommit = "";
  let currentFile = "";
  let skipFile = false;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("commit ")) {
      currentCommit = line.slice(7, 14);
    } else if (line.startsWith("+++ b/")) {
      currentFile = line.slice(6);
      skipFile = EMAIL_SCAN_FILE_DENYLIST.some((re) => re.test(currentFile));
    } else if (!skipFile && line.startsWith("+") && !line.startsWith("+++")) {
      EMAIL_RE.lastIndex = 0;
      let m;
      while ((m = EMAIL_RE.exec(line)) !== null) {
        const email = m[0];
        if (ALLOWED_EMAIL_PATTERNS.some((re) => re.test(email))) continue;
        findings.push({
          layer: "email",
          commit: currentCommit,
          file: currentFile,
          detail: email,
        });
      }
    }
  }
  return findings;
}

// ----- Check 3: local paths -----

/** Per-file local-path scan. Companion to scanLinesForEmails. */
export function scanLinesForLocalPaths(file, content, commit = "") {
  const findings = [];
  for (const line of content.split("\n")) {
    for (const { re, kind } of PATH_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        const hit = m[0];
        if (PLACEHOLDER_RE.test(hit)) continue;
        findings.push({
          layer: "path",
          commit,
          file,
          detail: `${kind}: ${hit}`,
        });
      }
    }
  }
  return findings;
}

/**
 * Flag transcript speaker tags whose PLAYER slot holds something name-shaped.
 *
 * The rule is absolute and deliberately has no exceptions for "it's only a
 * first name" or "it's just a fixture": a character name is invented and may
 * ship, a player name belongs to a real person and never may. Only the
 * parenthetical is judged — a stand-in label passes, a real first name
 * does not, and the character name itself is never inspected.
 *
 * Two shapes are covered, both of which have carried real names in this repo:
 *   bracketed  — what the Craig/Whisper importer emits.
 *   `'Character (Speaker)'`  — how a quote's speaker field is stored.
 */
export function scanLinesForSpeakerNames(file, content, commit = "", { allowNames = [] } = {}) {
  const findings = [];
  // The scanner suite's own tests must contain the shapes they assert on — the
  // same exemption private-names.mjs grants the denylist and its template.
  if (
    /(^|\/)(private-names|personal-info-scanner|name-pool)\.test\.mjs$/.test(
      String(file).replace(/\\/g, "/"),
    )
  ) {
    return findings;
  }
  // Names currently assigned by the rotation (scripts/rotate-names.mjs) are
  // sanctioned placeholders and must pass, or every rotation would fail its own
  // gate. This does NOT weaken the layer: the pool those names come from is
  // validated at load against .private-names, so a real person's name can never
  // reach this allowlist. The two checks compose — rotation says "this name is
  // deliberate", the denylist says "this name is a person", and only a name
  // that is deliberate AND not a person gets through.
  const sanctioned = new Set(allowNames.map((n) => String(n).toLowerCase()));
  // The second pattern is anchored to a literal `speaker:` key rather than
  // matching any quoted "Something (Something)" string. Without the anchor it
  // flags every `it('does a thing (with a caveat)')` in the suite — 40-odd
  // false positives that would train a reviewer to skim past this layer, which
  // is exactly how a real hit gets waved through.
  const patterns = [
    { re: SPEAKER_TAG_RE, kind: "speaker tag" },
    {
      re: /\bspeakers?\s*:\s*['"`][A-Za-z' .-]{2,40} \(([^)\n'"`]{1,40})\)['"`]/g,
      kind: "quote speaker field",
    },
  ];
  for (const line of content.split("\n")) {
    for (const { re, kind } of patterns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        const label = m[1].trim();
        if (!label) continue;
        if (SPEAKER_LABEL_ALLOW_RE.test(label)) continue;
        if (sanctioned.has(label.toLowerCase())) continue;
        if (PLACEHOLDER_RE.test(label)) continue;
        // A label that is not name-shaped at all (a number, an id, punctuation)
        // is not a person and not worth a finding.
        if (!/[A-Za-z]{2}/.test(label)) continue;
        findings.push({
          layer: "speaker",
          commit,
          file,
          detail: `${kind} names a person: ${m[0]} — use a stand-in such as (Player N) or (DM)`,
        });
      }
    }
  }
  return findings;
}

/** Diff-walking form of scanLinesForSpeakerNames, for the push-range gate.
 *  Added lines only — a speaker tag being REMOVED is the fix, not the fault. */
export function scanContentForSpeakerNames(diffText, { allowNames = [] } = {}) {
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
        ...scanLinesForSpeakerNames(currentFile, line.slice(1), currentCommit, { allowNames }),
      );
    }
  }
  return findings;
}

export function scanContentForLocalPaths(diffText) {
  const findings = [];
  let currentCommit = "";
  let currentFile = "";
  for (const line of diffText.split("\n")) {
    if (line.startsWith("commit ")) {
      currentCommit = line.slice(7, 14);
    } else if (line.startsWith("+++ b/")) {
      currentFile = line.slice(6);
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      for (const { re, kind } of PATH_PATTERNS) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(line)) !== null) {
          const hit = m[0];
          if (PLACEHOLDER_RE.test(hit)) continue;
          findings.push({
            layer: "path",
            commit: currentCommit,
            file: currentFile,
            detail: `${kind}: ${hit}`,
          });
        }
      }
    }
  }
  return findings;
}

// ----- Orchestrator -----

export function runPersonalInfoChecks(range, { allRefs = false } = {}) {
  const findings = [];

  // Identity check runs on BOTH the full-history audit and the push-
  // range scan. The push path is the only gate before bytes reach
  // public, so a missed identity at that layer is unrecoverable.
  findings.push(...checkCommitIdentities({ range, allRefs }));

  // Content scans need a diff. Empty range = nothing to scan.
  if (!range && !allRefs) return findings;

  let diff;
  try {
    const argv = ["log"];
    if (allRefs) argv.push("--all");
    else argv.push(range);
    argv.push("-p", "--no-color");
    diff = execFileSync("git", argv, {
      encoding: "utf-8",
      maxBuffer: 500 * 1024 * 1024,
    });
  } catch {
    return findings;
  }

  let repoRoot;
  try {
    repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf-8",
    }).trim();
  } catch {
    repoRoot = process.cwd();
  }

  findings.push(...scanContentForEmails(diff));
  findings.push(...scanContentForLocalPaths(diff));

  // Names the rotation has legitimately placed in speaker slots. Without this
  // every rotation would trip the very gate that is meant to be checking it.
  // Safe because the pool those names come from is validated against
  // .private-names at load: a real person's name cannot be in it.
  const assignment = loadRotationState(repoRoot)?.assignment ?? {};
  findings.push(
    ...scanContentForSpeakerNames(diff, { allowNames: Object.values(assignment) }),
  );

  // The private-name layer. `requireList` is true here and only here: this
  // function backs the pre-push gate, the last thing that runs before bytes
  // reach the public remote. A denylist that quietly no-ops when its file is
  // missing is worse than no denylist, because the green tick still appears.
  // Contributors never hit this path — they do not push to `public`.
  const { names } = resolvePrivateNames(repoRoot, { requireList: true });
  findings.push(...scanContentForPrivateNames(diff, names));

  return findings;
}

/** Load any per-finding allowlist from .gitleaksignore-style file. */
export function loadPersonalIgnore(repoRoot) {
  const ignoreFile = path.join(repoRoot, ".personalignore");
  if (!existsSync(ignoreFile)) return new Set();
  const lines = readFileSync(ignoreFile, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  return new Set(lines);
}
