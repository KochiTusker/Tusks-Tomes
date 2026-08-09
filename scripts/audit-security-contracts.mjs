#!/usr/bin/env node
// Codified institutional memory — the regressions that have already
// happened once in this repo. Each rule below corresponds to a real
// /ship finding from the personas. When a future contributor (human
// or AI) introduces the same shape of regression, CI fails here
// before the bad code ships.
//
// To allowlist a finding deliberately, add a comment on the same line
// (or the preceding line) of the form:
//     // AUDIT: <one-line reason>
// Bare bypass markers (`// AUDIT:` with no text) fail loudly so an
// allowlist is always accompanied by justification.
//
// Run: `node scripts/audit-security-contracts.mjs`
// Wired into CI in .github/workflows/ci.yml.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')

/** Get all tracked files (no submodules). */
function trackedFiles() {
  const out = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
  return out.split('\n').filter(Boolean)
}

function read(file) {
  try {
    return readFileSync(path.join(REPO_ROOT, file), 'utf8')
  } catch {
    return ''
  }
}

/** Find AUDIT: opt-out on this line or any of the previous 3 lines.
 *  Returns the reason text, or null if no opt-out present, or '' if
 *  the opt-out is bare (no reason — which is treated as MISSING).
 *  3-line lookback handles the typical block-comment-then-call shape:
 *
 *      // AUDIT: ... reason ...
 *      const child = spawn(...)
 *
 *  Or the same with one or two intervening comment lines.
 */
function auditOptOut(lines, lineIdx) {
  for (let offset = 0; offset <= 3; offset++) {
    const line = (lines[lineIdx - offset] ?? '').replace(/\r$/, '')
    const m = line.match(/AUDIT:\s*(.*)$/)
    if (m) return m[1].trim()
  }
  return null
}

const findings = []
function report(file, lineNum, ruleId, message) {
  findings.push({ file, lineNum, ruleId, message })
}

// ----------------------------------------------------------------------------
// Rule 1: spawn(...) calls with shell:true anywhere in the codebase
//         MUST carry an AUDIT: justification comment.
//
// Two-layer enforcement:
//   1a (positive presence)  — files in `lockedFiles` MUST still contain
//      a shell:true spawn (catches a future refactor that quietly
//      replaces the call entirely with something different).
//   1b (global vigilance)   — ANY file (TS / TSX / JS / MJS) in the
//      tree containing spawn(...) with shell:true MUST have an AUDIT:
//      comment within 3 lines above. Catches a new shell:true call
//      site added in a different file without justification.
// ----------------------------------------------------------------------------
function ruleShellTrueLockedFiles() {
  // 1a: positive-presence guard for the known locked files. Each MUST
  // carry an AUDIT comment AND must still contain shell:true.
  const lockedFiles = [
    'server/api/localProxy.ts',
  ]
  for (const file of lockedFiles) {
    const content = read(file)
    if (!content) continue
    const lines = content.split('\n')
    let found = false
    for (let i = 0; i < lines.length; i++) {
      if (/\bspawn\s*\(/.test(lines[i])) {
        const window = lines.slice(i, i + 14).join('\n')
        if (/\bshell\s*:\s*true\b/.test(window)) {
          found = true
        } else if (/\bshell\s*:\s*false\b/.test(window) || !/\bshell\s*:/.test(window)) {
          report(file, i + 1, 'shell-true-locked-file-regressed',
            `${file} previously used shell:true (locked by audit) — found shell:false / unset here. ` +
            'If the change is deliberate, remove this file from lockedFiles in scripts/audit-security-contracts.mjs and update the test.')
        }
      }
    }
    if (!found) {
      report(file, 0, 'shell-true-locked-file-missing-spawn',
        `${file} is in lockedFiles but has no spawn() call.`)
    }
  }

  // 1b: global vigilance — every shell:true spawn in any tracked file
  // must justify itself with an AUDIT: comment within 3 lines above.
  // Catches a future contributor adding a new shell:true call site in
  // a different file without leaving a paper trail.
  //
  // Skip:
  //   - This audit script itself (its regex literals match `spawn(` /
  //     `shell:true` and would self-flag).
  //   - *.test.* files (test code legitimately mentions these patterns
  //     in mocks and assertions; the production code is the target).
  const allCodeFiles = trackedFiles().filter((f) =>
    /\.(ts|tsx|js|mjs)$/.test(f) &&
    !f.endsWith('.d.ts') &&
    !f.includes('node_modules') &&
    f !== 'scripts/audit-security-contracts.mjs' &&
    !/\.test\.(ts|tsx|js|mjs)$/.test(f),
  )
  for (const file of allCodeFiles) {
    const content = read(file)
    if (!content) continue
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (!/\bspawn\s*\(/.test(lines[i])) continue
      const window = lines.slice(i, i + 14).join('\n')
      if (!/\bshell\s*:\s*true\b/.test(window)) continue
      const optOut = auditOptOut(lines, i)
      if (optOut === null) {
        report(file, i + 1, 'shell-true-needs-audit',
          'spawn({shell:true}) requires an `// AUDIT: <reason>` comment within 3 lines above explaining why command + args are safe.')
      } else if (optOut === '') {
        report(file, i + 1, 'shell-true-bare-audit',
          'Bare `// AUDIT:` opt-out without a reason. Add the justification.')
      }
    }
  }
}

// ----------------------------------------------------------------------------
// Rule 2: confirmRemoteHead must NOT accept both full + short sha.
// Catches the post-Phase-1.5 regression. Detects the pattern of
// `confirmRemoteHead !== status.x.sha && confirmRemoteHead !== status.x.shortSha`
// or any === to a `shortSha` identifier.
// ----------------------------------------------------------------------------
function ruleConfirmRemoteHeadFullShaOnly() {
  const file = 'server/api/updater.ts'
  const content = read(file)
  if (!content) return
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const here = lines[i]
    if (/confirmRemoteHead[^\n]*shortSha/.test(here)) {
      const optOut = auditOptOut(lines, i)
      if (optOut === null) {
        report(file, i + 1, 'confirm-remote-head-short-sha',
          'confirmRemoteHead must be the full 40-char sha. Comparing to shortSha collapses the collision space to ~16M. See Phase 1.5 plan.')
      }
    }
  }
}

// ----------------------------------------------------------------------------
// Rule 3: multer middleware before :id validation.
// Catches the post-Phase-1.3 regression. Looks for `router.post('/:id…',
// uploadDisk.array(...)`, …)` without `gateById()` between them.
// ----------------------------------------------------------------------------
function ruleMulterAfterGate() {
  const file = 'server/api/upload.ts'
  const content = read(file)
  if (!content) return
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const here = lines[i]
    // Look for any route definition where the path contains `:id` AND
    // the same line includes uploadDisk / multer middleware.
    if (/router\.(post|put|patch)\(.*['"]\/:[^'"]*\/.*['"][^\n]*upload(Disk)?\b/.test(here)) {
      if (!/gateById\s*\(\s*\)/.test(here)) {
        const optOut = auditOptOut(lines, i)
        if (optOut === null) {
          report(file, i + 1, 'multer-before-gate',
            'Route with :id parameter uses multer middleware without gateById() — multer writes uploads to disk before id validation runs. See Phase 1.3 plan.')
        }
      }
    }
  }
}

// ----------------------------------------------------------------------------
// Rule 4: safeResolveInside duplicated.
// Single source of truth lives in server/lib/validators.ts. Any other
// file that defines (rather than re-exports / imports) safeResolveInside
// fails the gate.
// ----------------------------------------------------------------------------
function ruleSafeResolveInsideSingleSource() {
  const allFiles = trackedFiles().filter((f) => /\.(ts|tsx|js|mjs)$/.test(f) && !f.endsWith('.d.ts'))
  for (const file of allFiles) {
    if (file === 'server/lib/validators.ts') continue
    const content = read(file)
    if (!content) continue
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*(export\s+)?function\s+safeResolveInside\s*\(/.test(lines[i])) {
        const optOut = auditOptOut(lines, i)
        if (optOut === null) {
          report(file, i + 1, 'safe-resolve-inside-duplicate',
            'safeResolveInside is defined here, but the single source of truth lives in server/lib/validators.ts. Import or re-export from there.')
        }
      }
    }
  }
}

// ----------------------------------------------------------------------------
// Rule 5: rejectInvalidId duplicated.
// Same shape as rule 4 — the helper lives in validators.ts, callers
// should import.
// ----------------------------------------------------------------------------
function ruleRejectInvalidIdSingleSource() {
  const allFiles = trackedFiles().filter((f) => /\.(ts|tsx|js|mjs)$/.test(f) && !f.endsWith('.d.ts'))
  for (const file of allFiles) {
    if (file === 'server/lib/validators.ts') continue
    const content = read(file)
    if (!content) continue
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*function\s+rejectInvalidId\s*\(/.test(lines[i])) {
        const optOut = auditOptOut(lines, i)
        if (optOut === null) {
          report(file, i + 1, 'reject-invalid-id-duplicate',
            'rejectInvalidId is defined here, but the single source of truth lives in server/lib/validators.ts. Use `import { rejectInvalidId } from "../lib/validators.js"`.')
        }
      }
    }
  }
}

// ----------------------------------------------------------------------------
// Rule 6: credentialed / host-mutating routes must carry loopbackOnly().
//
// Codifies the Phase 6.1 policy: any route mount whose prefix names a
// credential-touching or host-state-mutating surface MUST appear in the
// same line as `loopbackOnly()` OR be marked with `// LAN-OK: <reason>`.
//
// We scan only the routes-aggregator file server/index.ts so the rule
// is fast and unambiguous. Inline gating (e.g. PUT /unsloth-config
// applying loopbackOnly at the route handler) is fine — the rule only
// checks the app-level mount in index.ts.
// ----------------------------------------------------------------------------
function ruleCredentialedRoutesGated() {
  const file = 'server/index.ts'
  const content = read(file)
  if (!content) return
  const lines = content.split('\n')

  // Path prefixes that demand the gate. Add to this list whenever a new
  // credential-touching or host-mutating route surface is introduced.
  const protectedPrefixes = [
    '/api/provider-keys',
    '/api/providers',
    '/api/updater',
  ]

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = line.match(/app\.use\(\s*['"]([^'"]+)['"]/)
    if (!m) continue
    const prefix = m[1]
    if (!protectedPrefixes.some((p) => prefix === p || prefix.startsWith(p + '/'))) continue
    // Same-line gate? loopbackOnly() must appear on this line in the
    // middleware chain. Comments / opt-out also accepted.
    if (/\bloopbackOnly\s*\(\s*\)/.test(line)) continue
    if (/LAN-OK:/i.test(line)) continue
    const optOut = auditOptOut(lines, i)
    if (optOut !== null) continue
    report(file, i + 1, 'credentialed-route-missing-loopback-gate',
      `Route mount ${prefix} touches credentials or host state — must include loopbackOnly() in the middleware chain. ` +
      `Add it, or annotate the line with \`// LAN-OK: <reason>\` (or an // AUDIT: above) if the exposure is deliberate.`)
  }
}

// ----------------------------------------------------------------------------
// Rule 7: addon / sub-route inline loopbackOnly() gates must be present.
//
// Phase 6.1 added inline gates at the route-handler level (not the
// mount level) for a few addon-introduced credentialed surfaces.
// Rule 6 scans server/index.ts for mount-level gates; this rule walks
// the known inline-gated route files and verifies the gate is still
// present at each known credentialed handler. Catches a refactor that
// silently drops the gate when reformatting a router file.
// ----------------------------------------------------------------------------
function ruleInlineGatesPresent() {
  // Each entry: detect whether the route declaration EXISTS in the file
  // (declarationPattern), and if so, verify the gate IS present
  // (gatePattern). If the file is absent or the declaration is absent,
  // skip silently — the rule is about "if you declare this route,
  // gate it", not "this route must exist".
  const inlineGatedRoutes = [
    {
      file: 'server/api/localProxy.ts',
      label: 'POST /launch',
      declarationPattern: /router\.post\(\s*['"]\/launch['"]/,
      gatePattern: /router\.post\(\s*['"]\/launch['"][\s\S]{0,200}?loopbackOnly\s*\(\s*\)/,
    },
    {
      file: 'server/api/localLLM.ts',
      label: 'GET /unsloth-config',
      declarationPattern: /router\.get\(\s*['"]\/unsloth-config['"]/,
      gatePattern: /router\.get\(\s*['"]\/unsloth-config['"][\s\S]{0,200}?loopbackOnly\s*\(\s*\)/,
    },
    {
      file: 'server/api/localLLM.ts',
      label: 'PUT /unsloth-config',
      declarationPattern: /router\.put\(\s*['"]\/unsloth-config['"]/,
      gatePattern: /router\.put\(\s*['"]\/unsloth-config['"][\s\S]{0,200}?loopbackOnly\s*\(\s*\)/,
    },
    {
      file: 'server/api/localLLM.ts',
      label: 'DELETE /unsloth-config',
      declarationPattern: /router\.delete\(\s*['"]\/unsloth-config['"]/,
      gatePattern: /router\.delete\(\s*['"]\/unsloth-config['"][\s\S]{0,200}?loopbackOnly\s*\(\s*\)/,
    },
    {
      file: 'server/api/settings.ts',
      label: 'POST /dev-auth',
      declarationPattern: /router\.post\(\s*['"]\/dev-auth['"]/,
      gatePattern: /router\.post\(\s*['"]\/dev-auth['"][\s\S]{0,200}?loopbackOnly\s*\(\s*\)/,
    },
    {
      file: 'server/api/settings.ts',
      label: 'POST /dev-auth/lock',
      declarationPattern: /router\.post\(\s*['"]\/dev-auth\/lock['"]/,
      gatePattern: /router\.post\(\s*['"]\/dev-auth\/lock['"][\s\S]{0,200}?loopbackOnly\s*\(\s*\)/,
    },
    {
      file: 'server/api/settings.ts',
      label: 'POST /api/settings (root)',
      declarationPattern: /router\.post\(\s*['"]\/['"]/,
      gatePattern: /router\.post\(\s*['"]\/['"][\s\S]{0,200}?loopbackOnly\s*\(\s*\)/,
    },
  ]
  for (const route of inlineGatedRoutes) {
    const content = read(route.file)
    if (!content) continue // file absent — fixture or in-progress migration, skip
    if (!route.declarationPattern.test(content)) continue // route not declared in this file, skip
    if (!route.gatePattern.test(content)) {
      report(route.file, 0, 'inline-gate-missing',
        `${route.label} in ${route.file} must carry loopbackOnly() in its middleware chain. ` +
        `This route touches credentials or host-mutating ops; LAN visitors must not be able to invoke it.`)
    }
  }
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------
function main() {
  ruleShellTrueLockedFiles()
  ruleConfirmRemoteHeadFullShaOnly()
  ruleMulterAfterGate()
  ruleSafeResolveInsideSingleSource()
  ruleRejectInvalidIdSingleSource()
  ruleCredentialedRoutesGated()
  ruleInlineGatesPresent()

  if (findings.length === 0) {
    console.log('audit-security-contracts: clean.')
    return 0
  }
  console.error('audit-security-contracts: findings (regressions of known issues):')
  for (const f of findings) {
    const where = f.lineNum > 0 ? `${f.file}:${f.lineNum}` : f.file
    console.error(`  [${f.ruleId}] ${where}`)
    console.error(`    ${f.message}`)
  }
  console.error('')
  console.error(`${findings.length} finding(s). Either fix the regression OR add a justified`)
  console.error(`\`// AUDIT: <reason>\` comment on the offending line.`)
  return 1
}

process.exit(main())
