// Defence-in-depth secret scanning for the public-remote push gate.
// Shared by scripts/audit-history.mjs (one-shot full-history scan) and
// scripts/audit-push-range.mjs (pre-push hook, scans only the commits
// being pushed). Both scripts call runAllChecks() and forward the
// findings to git's stdout/stderr.
//
// Layers (in order, slowest-first to maximise early-exit on a clean diff):
//   1. Filename heuristic   — fast, no diff scan; flags .env/.pem/.key/etc.
//   2. In-house regex       — fast, scans + lines for known token shapes
//                             (Anthropic / OpenAI / Google / Discord).
//   3. gitleaks             — ~150 known patterns. Optional: if the binary
//                             isn't on PATH, we log a one-line warning and
//                             skip this layer rather than block legit pushes.
//   4. Binary file inventory — non-blocking; lists binaries added so the
//                             reviewer can eyeball them for embedded secrets
//                             that regex won't catch.
//
// Each check is its own function so future contributors can audit them in
// isolation and add new ones without re-reading the orchestrator.

import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runPersonalInfoChecks } from "./personal-info-scanner.mjs";

// ----- Layer 1: filename heuristic -----

// Files whose names alone are red flags. The .env.example exception lets
// project documentation through (the template is meant to be committed).
const FORBIDDEN_FILE_PATTERNS = [
  // Any file whose name ends in .env catches: .env, secrets.env,
  // prod.env, anything. The allowlist below carves out template files.
  { re: /\.env$/i, label: "*.env (environment file)" },
  { re: /\.env\.[a-z0-9_-]+$/i, label: ".env.<environment> file" },
  { re: /\.pem$/i, label: "PEM private key" },
  { re: /\.key$/i, label: "private key file" },
  { re: /\.pfx$/i, label: "PFX/PKCS#12 keystore" },
  { re: /\.p12$/i, label: "PKCS#12 keystore" },
  { re: /(^|\/)id_rsa(\.pub)?$/i, label: "SSH RSA key" },
  { re: /(^|\/)id_ed25519(\.pub)?$/i, label: "SSH Ed25519 key" },
  { re: /(^|\/)id_ecdsa(\.pub)?$/i, label: "SSH ECDSA key" },
  { re: /(^|\/)credentials\.json$/i, label: "credentials.json" },
  { re: /(^|\/)secrets\.json$/i, label: "secrets.json" },
  { re: /(^|\/)service-account.*\.json$/i, label: "service-account JSON" },
  { re: /(^|\/)gcp-key.*\.json$/i, label: "GCP service-account key" },
  { re: /(^|\/)aws-credentials$/i, label: "AWS credentials file" },
  // Dev-only repository guidance — must never reach the public release.
  // These files are intentionally tracked in the dev repo so contributors
  // and Claude Code sessions load them, but the orphan release commit
  // must exclude each one. They leak internal threat-model details,
  // prompt-engineering notes, references to the user's tooling, the
  // release-gate architecture, and the OSINT inventory — a roadmap for
  // an attacker. The pre-push hook only runs this scan for the `public`
  // remote, so dev pushes are unaffected. To add another dev-only doc,
  // append it here AND document it in docs/security/public-release-workflow.md
  // under "Dev-only files".
  { re: /^CLAUDE\.md$/i, label: "CLAUDE.md (dev-only — exclude from orphan release commit; keep in dev tree)" },
  { re: /^docs\/security\/public-release-workflow\.md$/i, label: "docs/security/public-release-workflow.md (dev-only release-gate recipe — exclude from orphan release commit; keep in dev tree)" },
];

const FILENAME_ALLOWLIST = [
  /\.env\.example$/i, // documentation template
  /\.env\.sample$/i, // documentation template
];

export function checkForbiddenFilenames(addedFiles) {
  const findings = [];
  for (const f of addedFiles) {
    if (FILENAME_ALLOWLIST.some((re) => re.test(f))) continue;
    for (const { re, label } of FORBIDDEN_FILE_PATTERNS) {
      if (re.test(f)) {
        findings.push({ layer: "filename", file: f, detail: label });
        break;
      }
    }
  }
  return findings;
}

// ----- Layer 2: in-house regex -----

const TOKEN_PATTERNS = [
  { name: "Anthropic", re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "OpenAI", re: /sk-[A-Za-z0-9_-]{16,}/g },
  { name: "Google", re: /AIza[A-Za-z0-9_-]{35,}/g },
  { name: "Discord", re: /[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{27,}/g },
];

function maskMatch(s) {
  if (s.length <= 12) return s.slice(0, 4) + "…";
  return s.slice(0, 8) + "…" + s.slice(-4);
}

/** Scan a flat string of lines (one file's content, or raw addition
 *  lines) for token shapes. Used by audit-current-tree to avoid the
 *  synthetic-diff round-trip — the caller already knows the filename. */
/** Is this a generated HTML page rather than source? */
const isHtmlFile = (f) => /\.html?$/i.test(String(f || ""));

/**
 * Blank out heading-anchor slugs on a line of generated HTML.
 *
 * Static-site generators build `id` and same-page `href` values by slugifying
 * heading text: punctuation is dropped and the words run together. That
 * occasionally yields a token matching a credential shape — a heading naming
 * a symbol and a source path collapses into one long hyphen-and-letters run
 * whose tail satisfies the OpenAI `sk-<16+>` pattern. It fired on a real page
 * and blocked a publish, and no wording of the heading avoids it: any heading
 * with "task-" followed by enough characters produces the same thing.
 *
 * This costs no coverage. A slug is a derived duplicate of heading text that
 * stays in the document and is still scanned, so a credential genuinely
 * sitting in a heading is still caught — in its readable form rather than a
 * mangled copy of it. Deliberately narrow: `id` and `href="#…"` only, on HTML
 * files only. Every other attribute, all body text, and every non-HTML file
 * is scanned unchanged.
 *
 * Lives here rather than in each caller because there are three gates — the
 * site build's own verifier, the site audit, and the pre-push range scanner —
 * and the first two were fixed separately while the third went on blocking
 * the publish. One definition, every caller.
 */
export function stripGeneratedSlugs(line) {
  return line.replace(/\sid="[^"]*"/g, " ").replace(/\shref="#[^"]*"/g, " ");
}

export function scanLinesForTokens(file, content, commit = "") {
  const findings = [];
  const html = isHtmlFile(file);
  const lines = content.split("\n");
  for (const raw of lines) {
    const line = html ? stripGeneratedSlugs(raw) : raw;
    for (const { name, re } of TOKEN_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        // Avoid double-counting: an sk-ant-… token also matches the
        // looser OpenAI pattern. Take the more specific hit only.
        if (name === "OpenAI" && /sk-ant-/.test(line)) continue;
        findings.push({
          layer: "regex",
          commit,
          file,
          detail: `${name}: ${maskMatch(m[0])}`,
        });
      }
    }
  }
  return findings;
}

export function scanDiffForTokens(diffText) {
  const findings = [];
  let currentCommit = "";
  let currentFile = "";
  for (const raw of diffText.split("\n")) {
    if (raw.startsWith("commit ")) {
      currentCommit = raw.slice(7, 14);
    } else if (raw.startsWith("+++ b/")) {
      currentFile = raw.slice(6);
    } else if (raw.startsWith("+") && !raw.startsWith("+++")) {
      // Same suppression as scanLinesForTokens — see stripGeneratedSlugs.
      // This is the path the pre-push gate takes, so it is the one that
      // actually blocks a publish.
      const line = isHtmlFile(currentFile) ? stripGeneratedSlugs(raw) : raw;
      for (const { name, re } of TOKEN_PATTERNS) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(line)) !== null) {
          // Avoid double-counting: an sk-ant-… token also matches the
          // looser OpenAI pattern. Take the more specific hit only.
          if (name === "OpenAI" && /sk-ant-/.test(line)) continue;
          findings.push({
            layer: "regex",
            commit: currentCommit,
            file: currentFile,
            detail: `${name}: ${maskMatch(m[0])}`,
          });
        }
      }
    }
  }
  return findings;
}

// ----- Layer 3: gitleaks (optional) -----

function gitleaksAvailable() {
  try {
    execSync("gitleaks version", { stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

/** If the repo root carries a .gitleaks.toml, return its argv tokens so
 *  every gitleaks invocation applies the same path / regex exclusions.
 *  Returns [] when no config exists. argv-form deliberately — string
 *  interpolation into a shell-mode execSync is a command-injection
 *  hazard if a future contributor edits the repo path. */
function repoConfigArgv() {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf-8",
    }).trim();
    const cfg = path.join(root, ".gitleaks.toml");
    return existsSync(cfg) ? ["--config", cfg] : [];
  } catch {
    return [];
  }
}

/** Run gitleaks against the live working tree (not git diffs). Catches
 *  things sitting in gitignored files like a real .env so the user knows
 *  what's on disk even though it'll never reach the public repo. */
export function runGitleaksDir(rootDir) {
  if (!gitleaksAvailable()) return null;
  const tmpDir = mkdtempSync(path.join(tmpdir(), "gl-dir-"));
  const reportPath = path.join(tmpDir, "report.json");
  const configArgv = repoConfigArgv();
  try {
    try {
      execFileSync(
        "gitleaks",
        [
          "dir",
          rootDir,
          "--no-banner",
          ...configArgv,
          "--report-format=json",
          `--report-path=${reportPath}`,
        ],
        { stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" },
      );
    } catch {
      /* exit non-zero on findings, report is still written */
    }
    let raw;
    try {
      raw = readFileSync(reportPath, "utf-8");
    } catch {
      return [];
    }
    if (!raw.trim()) return [];
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.map((p) => ({
      layer: "working-tree",
      file: p.File ?? "",
      detail: `${p.RuleID ?? "rule?"}${p.StartLine ? `:${p.StartLine}` : ""}`,
    }));
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

/** Run gitleaks against a git log range. Returns structured findings via
 *  gitleaks' JSON report (much cleaner than scraping its text output —
 *  the human-readable mode is interleaved with INFO log lines that look
 *  like findings to a tokeniser). A `.gitleaksignore` file at the repo
 *  root is honoured automatically; mark known false positives there
 *  with `<commit>:<file>:<rule>:<line>` fingerprints.
 *
 *  Returns null when gitleaks isn't installed — caller warns but does
 *  not block. */
export function runGitleaks(range, { allRefs = false } = {}) {
  if (!gitleaksAvailable()) return null;

  const logOpts = allRefs ? "--all" : range;
  const tmpDir = mkdtempSync(path.join(tmpdir(), "gl-"));
  const reportPath = path.join(tmpDir, "report.json");
  const configArgv = repoConfigArgv();
  try {
    try {
      execFileSync(
        "gitleaks",
        [
          "detect",
          "--no-banner",
          ...configArgv,
          "--report-format=json",
          `--report-path=${reportPath}`,
          `--log-opts=${logOpts}`,
        ],
        { stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" },
      );
    } catch {
      // gitleaks exits non-zero when findings exist — the JSON report is
      // still written. Swallow and read the file below.
    }

    let raw;
    try {
      raw = readFileSync(reportPath, "utf-8");
    } catch {
      // No report file written → either a gitleaks crash or no findings.
      return [];
    }
    if (!raw.trim()) return [];

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Malformed report — fail open with a single advisory entry rather
      // than blocking real pushes over a tooling bug.
      return [
        {
          layer: "gitleaks",
          detail: `gitleaks produced an unparseable report at ${reportPath}; review manually`,
        },
      ];
    }
    if (!Array.isArray(parsed) || parsed.length === 0) return [];

    return parsed.map((p) => ({
      layer: "gitleaks",
      commit: typeof p.Commit === "string" ? p.Commit.slice(0, 7) : "",
      file: p.File ?? "",
      detail: `${p.RuleID ?? "rule?"}${p.StartLine ? `:${p.StartLine}` : ""}${
        p.Description ? ` — ${p.Description}` : ""
      }`,
    }));
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}

// ----- Layer 4: binary file inventory (warning only) -----

/** List binary files added or modified in the range. `git diff --numstat`
 *  marks binaries with `-\t-\t<filename>`. Treated as a heads-up, not a
 *  blocker — the user has legit binaries (logo.png, fonts) in the repo. */
export function listBinariesInRange(range) {
  let out;
  try {
    // range is "<base>..<head>" from the pre-push hook; pass as a
    // single argv token so a hostile remote-name token can't extend
    // the command line.
    out = execFileSync("git", ["diff", "--numstat", range], {
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch {
    return [];
  }
  const binaries = [];
  for (const line of out.split("\n").filter(Boolean)) {
    const [add, del, file] = line.split("\t");
    if (add === "-" && del === "-" && file) binaries.push(file);
  }
  return binaries;
}

// ----- Orchestrator -----

/** Run every check against a range. Returns `{ blocking, warnings,
 *  gitleaksAvailable }`. `blocking` is the list of findings that should
 *  abort the push; `warnings` is informational. */
export function runAllChecks(range, { allRefs = false } = {}) {
  // Resolve "what files were added or modified in this range" up-front so
  // the filename layer doesn't re-shell out.
  let addedFiles = [];
  try {
    const expr = allRefs ? "--all" : range;
    const out = execFileSync(
      "git",
      [
        "log",
        expr,
        "--name-only",
        "--pretty=format:",
        "--no-renames",
        "--diff-filter=AM",
      ],
      { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 },
    );
    addedFiles = [...new Set(out.split("\n").map((l) => l.trim()).filter(Boolean))];
  } catch {
    /* empty range or git error — let other layers complain */
  }

  const filenameFindings = checkForbiddenFilenames(addedFiles);

  let regexFindings = [];
  try {
    const logArg = allRefs ? "--all" : range;
    const diff = execFileSync(
      "git",
      ["log", logArg, "-p", "--no-color"],
      { encoding: "utf-8", maxBuffer: 500 * 1024 * 1024 },
    );
    regexFindings = scanDiffForTokens(diff);
  } catch {
    /* empty range — no diff to scan */
  }

  const gitleaksFindings = runGitleaks(range, { allRefs });
  const binaries = listBinariesInRange(allRefs ? "--all" : range);
  const personalFindings = runPersonalInfoChecks(range, { allRefs });

  return {
    blocking: [
      ...filenameFindings,
      ...regexFindings,
      ...(gitleaksFindings ?? []),
      ...personalFindings,
    ],
    warnings: binaries.map((f) => ({ layer: "binary", file: f })),
    gitleaksAvailable: gitleaksFindings !== null,
  };
}

/** De-duplicate findings by their natural key (layer + file + detail). */
export function dedupeFindings(findings) {
  const seen = new Set();
  const out = [];
  for (const f of findings) {
    const key = [f.layer, f.commit ?? "", f.file ?? "", f.detail ?? ""].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}
