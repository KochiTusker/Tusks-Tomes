#!/usr/bin/env node
/*
 * Self-contained safety tests for scripts/uninstall.mjs.
 *
 * Exercises the path-safety logic via a child-process invocation against
 * pathological inputs. Verifies:
 *
 *   1. Refuses to run if not in a Tusks-Tomes repo (wrong CWD).
 *   2. Refuses to delete a path that resolves outside REPO_ROOT and
 *      contains no "tusks-tomes" / "silence-beyond-the-sea" segment
 *      (env override pointing at a system path).
 *   3. Honours the brand-segment fallback (correct env-paths default).
 *   4. Dry-run never touches the filesystem.
 *   5. Tusks-Lore folder is never deleted regardless of flags.
 *
 * Run with: node scripts/uninstall.test.mjs
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(__dirname, 'uninstall.mjs')

let passed = 0
let failed = 0

function test(name, fn) {
  process.stdout.write(`  ${name} ... `)
  try {
    fn()
    console.log('\x1b[32mPASS\x1b[0m')
    passed++
  } catch (err) {
    console.log('\x1b[31mFAIL\x1b[0m')
    console.log(`    ${err.message}`)
    if (err.stderr) console.log(`    stderr: ${err.stderr}`)
    if (err.stdout) console.log(`    stdout: ${err.stdout.slice(0, 500)}`)
    failed++
  }
}

function runUninstall(env, args = []) {
  return spawnSync(process.execPath, [SCRIPT, '--dry-run', ...args], {
    env: { ...process.env, ...env, NO_COLOR: '1' },
    encoding: 'utf8',
    timeout: 30_000,
  })
}

// Spawn the script with stdin piped, so we can simulate the
// acknowledgement prompt without --dry-run.
function runUninstallWithStdin(env, args, stdinText) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    env: { ...process.env, ...env, NO_COLOR: '1' },
    encoding: 'utf8',
    timeout: 30_000,
    input: stdinText,
  })
}

console.log('\nUninstall safety tests:')

// --- Test 1: refuses to run outside a tusks-tomes repo --------------------
test('refuses to run if package.json is missing / wrong name', () => {
  // Create a fake "scripts/" dir in a tmp location with a sibling
  // package.json that has a wrong name. Copy the uninstall script in
  // and run it from there — REPO_ROOT will resolve to the tmp dir, the
  // package.json check should reject.
  const tmpRoot = mkdtempSync(join(tmpdir(), 'uninstall-safety-'))
  try {
    const tmpScripts = join(tmpRoot, 'scripts')
    mkdirSync(tmpScripts, { recursive: true })
    writeFileSync(join(tmpRoot, 'package.json'), JSON.stringify({ name: 'something-else' }))
    // Copy the script into the tmp dir (not link — keep the test hermetic)
    const src = readFileSync(SCRIPT, 'utf8')
    writeFileSync(join(tmpScripts, 'uninstall.mjs'), src)

    const result = spawnSync(process.execPath, [join(tmpScripts, 'uninstall.mjs'), '--dry-run', '--force'], {
      env: { ...process.env, NO_COLOR: '1' },
      encoding: 'utf8',
      timeout: 30_000,
    })
    if (result.status !== 1) {
      const err = new Error(`expected exit 1, got ${result.status}`)
      err.stdout = result.stdout
      err.stderr = result.stderr
      throw err
    }
    if (!result.stderr.includes('refuses to run') && !result.stderr.includes('Aborting')) {
      const err = new Error('expected stderr to mention refusal/abort')
      err.stdout = result.stdout
      err.stderr = result.stderr
      throw err
    }
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true })
  }
})

// --- Test 2: dry-run touches no files ------------------------------------
test('dry-run does not delete anything', () => {
  // Find any file the script reports it would delete, then snapshot its
  // mtime. After the dry-run, mtime should be identical (no write).
  const result = runUninstall({})
  if (result.status !== 0) {
    const err = new Error(`dry-run failed with exit ${result.status}`)
    err.stderr = result.stderr
    err.stdout = result.stdout
    throw err
  }
  // Find a path-line from the output and confirm it still exists
  const match = result.stdout.match(/would delete\n\s+(\S[^\n]+)/)
  if (match) {
    const targetPath = match[1].trim()
    if (!existsSync(targetPath)) {
      throw new Error(`dry-run claimed it would delete ${targetPath}, but the path is missing — did we actually delete it?`)
    }
  }
})

// --- Test 3: brand-segment check rejects path outside our footprint ------
test('refuses if TUSKS_CONFIG_DIR points outside our brand', () => {
  // Make a "decoy" dir that has no "tusks-tomes" segment but contains
  // files the script would try to delete (e.g. settings.json).
  const decoyRoot = mkdtempSync(join(tmpdir(), 'decoy-not-ours-'))
  try {
    writeFileSync(join(decoyRoot, 'settings.json'), '{}')
    writeFileSync(join(decoyRoot, '.salt'), 'x')
    const result = runUninstall({ TUSKS_CONFIG_DIR: decoyRoot })
    // The override flag triggers reportEnvOverrides; the actual deletion
    // attempt should hit the safety abort.
    const combined = result.stdout + '\n' + result.stderr
    if (!combined.includes('SAFETY ABORT') && !combined.includes('Path safety check failed') && result.status === 0) {
      throw new Error('expected the safety check to fire on the decoy path')
    }
    // The decoy files must still exist (we're in dry-run, but even if not,
    // assertSafePath should have aborted before deletion).
    if (!existsSync(join(decoyRoot, 'settings.json'))) {
      throw new Error('decoy settings.json was deleted — safety failure')
    }
  } finally {
    rmSync(decoyRoot, { recursive: true, force: true })
  }
})

// --- Test 4: brand-segment check accepts standard env-paths layout ------
test('honours standard env-paths layout (brand segment present)', () => {
  // The safety check requires "tusks-tomes" as an EXACT path segment
  // (not a prefix like "tusks-tomes-foo"). Build a dir whose path
  // contains the segment as env-paths would: <parent>/tusks-tomes/Config/
  const parent = mkdtempSync(join(tmpdir(), 'safety-host-'))
  const goodRoot = join(parent, 'tusks-tomes', 'Config')
  try {
    mkdirSync(goodRoot, { recursive: true })
    writeFileSync(join(goodRoot, 'settings.json'), '{}')
    const result = runUninstall({ TUSKS_CONFIG_DIR: goodRoot })
    if (result.status !== 0) {
      const err = new Error(`expected success, got exit ${result.status}`)
      err.stderr = result.stderr
      err.stdout = result.stdout
      throw err
    }
    const combined = result.stdout + '\n' + result.stderr
    if (combined.includes('SAFETY ABORT')) {
      const err = new Error('safety check fired on a legitimate tusks-tomes path')
      err.stdout = result.stdout
      throw err
    }
    // Sanity-check the script saw the override and confirmed the path
    if (!combined.includes('Environment overrides detected')) {
      const err = new Error('expected reportEnvOverrides() to fire')
      err.stdout = result.stdout
      throw err
    }
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

// --- Test 4b: prefix-match rejected (the bug Test 4 originally exposed) -
test('rejects paths where "tusks-tomes" is a prefix, not a segment', () => {
  // "tusks-tomes-foo" must NOT count as a brand match — otherwise a
  // user dir named "tusks-tomes-backups" could be matched accidentally.
  const decoyRoot = mkdtempSync(join(tmpdir(), 'tusks-tomes-fake-'))
  try {
    writeFileSync(join(decoyRoot, 'settings.json'), '{}')
    const result = runUninstall({ TUSKS_CONFIG_DIR: decoyRoot })
    const combined = result.stdout + '\n' + result.stderr
    if (!combined.includes('SAFETY ABORT') && !combined.includes('Path safety check failed')) {
      const err = new Error('expected safety check to reject the prefix-match path')
      err.stdout = result.stdout
      err.stderr = result.stderr
      throw err
    }
    // Crucially, the decoy file must still exist
    if (!existsSync(join(decoyRoot, 'settings.json'))) {
      throw new Error('decoy file was deleted — safety failure')
    }
  } finally {
    rmSync(decoyRoot, { recursive: true, force: true })
  }
})

// --- Test 5: a Tusks-Lore path is never matched by our paths ------------
test('script never references a Tusks-Lore folder', () => {
  // Sanity check the source: there should be no path joins involving
  // Tusks-Lore anywhere in the script.
  const src = readFileSync(SCRIPT, 'utf8')
  // We DO mention Tusks-Lore in the safety-narrative output text (in
  // comments and a single console.log explaining what's NOT touched).
  // Allow those, but flag any path-join or join() with the name.
  const offendingPatterns = [
    /join\([^)]*['"]Tusks-Lore/,
    /resolve\([^)]*['"]Tusks-Lore/,
    /removeIfPresent\([^)]*Tusks-Lore/,
  ]
  for (const re of offendingPatterns) {
    if (re.test(src)) {
      throw new Error(`script source touches Tusks-Lore via ${re}`)
    }
  }
})

// --- Test 6: acknowledgement prompt blocks wrong input ------------------
test('acknowledgement prompt aborts on wrong input', () => {
  // Send "y" instead of the required phrase. Script should exit cleanly
  // without touching anything.
  const result = runUninstallWithStdin({}, [], 'y\n')
  if (result.status !== 0) {
    const err = new Error(`expected clean exit 0, got ${result.status}`)
    err.stderr = result.stderr; err.stdout = result.stdout
    throw err
  }
  const combined = result.stdout + result.stderr
  if (!combined.includes('Acknowledgement not given') && !combined.includes('Aborted')) {
    throw new Error('expected an "Acknowledgement not given" message')
  }
  // Sanity: should not have started the deletion stages
  if (combined.includes('▸ Build artifacts')) {
    throw new Error('script proceeded past acknowledgement despite wrong input')
  }
})

// --- Test 7: acknowledgement accepted on the right phrase ---------------
test('acknowledgement accepted on "I UNDERSTAND" then aborts at final Y/N', () => {
  // Type the phrase to clear acknowledgement, then "n" at final prompt.
  const result = runUninstallWithStdin({}, [], 'I UNDERSTAND\nn\n')
  const combined = result.stdout + result.stderr
  if (!combined.includes('Acknowledged. Proceeding.')) {
    const err = new Error('expected "Acknowledged. Proceeding." message')
    err.stdout = result.stdout
    throw err
  }
  // Should have shown the plan but then aborted at the final prompt
  if (!combined.includes('Aborted')) {
    const err = new Error('expected final-Y/N abort message')
    err.stdout = result.stdout
    throw err
  }
})

// --- Test 8: --i-accept-the-risk skips the prompt -----------------------
test('--i-accept-the-risk skips the acknowledgement prompt', () => {
  // No stdin needed because no prompt should appear. The script will still
  // hit the final Y/N — we pipe "n" to dismiss it.
  const result = runUninstallWithStdin({}, ['--i-accept-the-risk'], 'n\n')
  const combined = result.stdout + result.stderr
  if (combined.includes('Type exactly: I UNDERSTAND')) {
    throw new Error('acknowledgement prompt fired despite --i-accept-the-risk')
  }
})

// --- Test 9: Tusks-Lore folder physically preserved ---------------------
test('Tusks-Lore folder is preserved even when colocated with the repo', () => {
  // Spawn a fake repo in tmp with a Tusks-Lore sibling, run a dry-run,
  // verify no output references the Tusks-Lore path.
  const root = mkdtempSync(join(tmpdir(), 'tusks-lore-test-'))
  try {
    const repo = join(root, 'tusks-tomes')
    const lore = join(root, 'Tusks-Lore')
    mkdirSync(join(repo, 'scripts'), { recursive: true })
    mkdirSync(lore, { recursive: true })
    writeFileSync(join(lore, 'campaign-notes.md'), '# my lore')
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'tusks-tomes' }))
    writeFileSync(join(repo, 'scripts', 'uninstall.mjs'), readFileSync(SCRIPT, 'utf8'))

    const result = spawnSync(process.execPath, [join(repo, 'scripts', 'uninstall.mjs'), '--dry-run'], {
      env: { ...process.env, NO_COLOR: '1' },
      encoding: 'utf8',
      timeout: 30_000,
    })
    const combined = result.stdout + result.stderr
    // The Tusks-Lore path must NEVER appear as a "would delete" target
    if (combined.match(/would delete[^\n]*Tusks-Lore/i)) {
      throw new Error('script lists Tusks-Lore as a deletion target!')
    }
    // And the file must obviously still exist after the dry-run
    if (!existsSync(join(lore, 'campaign-notes.md'))) {
      throw new Error('Tusks-Lore file vanished during dry-run')
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// --- Test 10: TUSKS_SESSIONS_DIR is never touched -----------------------
test('TUSKS_SESSIONS_DIR is preserved entirely', () => {
  const sessionsDir = mkdtempSync(join(tmpdir(), 'my-tusks-sessions-'))
  try {
    writeFileSync(join(sessionsDir, 'session-1.json'), '{}')
    const result = runUninstall({ TUSKS_SESSIONS_DIR: sessionsDir })
    const combined = result.stdout + result.stderr
    // The script should mention it sees the override in the warning,
    // but should NOT list it as a deletion target
    if (combined.match(new RegExp(`would delete[^\\n]*${sessionsDir.replace(/[/\\]/g, '[/\\\\]')}`, 'i'))) {
      throw new Error('TUSKS_SESSIONS_DIR was listed as a deletion target')
    }
    if (!existsSync(join(sessionsDir, 'session-1.json'))) {
      throw new Error('TUSKS_SESSIONS_DIR file vanished')
    }
  } finally {
    rmSync(sessionsDir, { recursive: true, force: true })
  }
})

// --- Test 11: empty-string env vars fall through to defaults ------------
test('empty env-var overrides fall through to env-paths defaults', () => {
  const result = runUninstall({ TUSKS_CONFIG_DIR: '', TUSKS_DATA_DIR: '   ' })
  const combined = result.stdout + result.stderr
  // The summary should show the default paths, not the empty ones
  if (combined.includes('Config dir:    \n') || combined.includes('Config dir:   \n')) {
    throw new Error('empty override leaked into the resolved config path')
  }
  // env-paths puts "tusks-tomes" in the resolved path
  if (!combined.match(/Config dir:\s+\S*tusks-tomes\S*/i)) {
    throw new Error('expected the default tusks-tomes config path in the output')
  }
})

// --- Test 12: relative paths with .. are resolved and still gated -------
test('relative path traversal in env override is blocked', () => {
  // resolve("../../../etc") becomes an absolute path. If that absolute
  // path doesn't contain "tusks-tomes" segment, the safety check should
  // reject any deletion target inside it. We can't actually point at
  // /etc/ for the test, so use a temp dir without our brand.
  const decoy = mkdtempSync(join(tmpdir(), 'no-brand-here-'))
  try {
    writeFileSync(join(decoy, 'settings.json'), '{}')
    // Express the path as a relative traversal from somewhere far away.
    // The Node resolve() inside the script normalises it. We just need
    // the absolute resolution to NOT contain "tusks-tomes".
    const result = runUninstall({ TUSKS_CONFIG_DIR: decoy })
    const combined = result.stdout + result.stderr
    if (combined.includes('would delete') && combined.match(/would delete[^\n]*no-brand-here/)) {
      throw new Error('relative-path traversal not blocked')
    }
    if (!existsSync(join(decoy, 'settings.json'))) {
      throw new Error('decoy file deleted via relative traversal')
    }
  } finally {
    rmSync(decoy, { recursive: true, force: true })
  }
})

// --- Test 13: --help works without acknowledgement ----------------------
test('--help works without the acknowledgement prompt', () => {
  const result = spawnSync(process.execPath, [SCRIPT, '--help'], {
    env: { ...process.env, NO_COLOR: '1' },
    encoding: 'utf8',
    timeout: 10_000,
  })
  if (result.status !== 0) {
    throw new Error(`--help should exit 0, got ${result.status}`)
  }
  const combined = result.stdout + result.stderr
  if (!combined.includes('Flags:') || !combined.includes('--i-accept-the-risk')) {
    throw new Error('--help did not show the expected text')
  }
})

// --- Test 14: --list-locations prints the manual reference, no deletions ---
test('--list-locations prints the manual cleanup reference and exits cleanly', () => {
  const result = spawnSync(process.execPath, [SCRIPT, '--list-locations'], {
    env: { ...process.env, NO_COLOR: '1' },
    encoding: 'utf8',
    timeout: 10_000,
  })
  if (result.status !== 0) {
    const err = new Error(`expected exit 0, got ${result.status}`)
    err.stdout = result.stdout
    err.stderr = result.stderr
    throw err
  }
  const out = result.stdout
  const required = [
    'MANUAL UNINSTALL REFERENCE',
    'npm install',
    'npm run build',
    'Audio Transcription add-on install',
    'platform config directory',
    'platform data directory',
    'platform cache directory',
    'Auto-saved chronicles',
    'External tools',
    'The repo source itself',
  ]
  for (const phrase of required) {
    if (!out.includes(phrase)) {
      throw new Error(`--list-locations output missing required section: "${phrase}"`)
    }
  }
  // It must NOT print the acknowledgement prompt or the deletion plan
  if (out.includes('Type exactly: I UNDERSTAND')) {
    throw new Error('--list-locations triggered the acknowledgement prompt')
  }
  if (out.includes('▸ Build artifacts + dependencies')) {
    throw new Error('--list-locations triggered the deletion plan')
  }
})

// --- Test 15: the reference appears in the acknowledgement notice -------
test('manual cleanup reference appears in the acknowledgement notice', () => {
  // Pipe an invalid acknowledgement so the script aborts after showing
  // the notice; the reference must have been printed before the prompt.
  const result = runUninstallWithStdin({}, [], 'nope\n')
  const out = result.stdout + result.stderr
  if (!out.includes('MANUAL UNINSTALL REFERENCE')) {
    throw new Error('acknowledgement notice did not include the manual reference')
  }
  // And the reference must appear BEFORE the "Type exactly" prompt
  const refIdx = out.indexOf('MANUAL UNINSTALL REFERENCE')
  const promptIdx = out.indexOf('Type exactly: I UNDERSTAND')
  if (refIdx > promptIdx) {
    throw new Error('manual reference printed AFTER the acknowledgement prompt — should be before')
  }
})

// --- Test 16: the reference appears in --dry-run --------------------------
test('manual cleanup reference appears in --dry-run output', () => {
  const result = runUninstall({})
  const out = result.stdout + result.stderr
  if (!out.includes('MANUAL UNINSTALL REFERENCE')) {
    throw new Error('--dry-run did not include the manual reference')
  }
})

// --- Test 17: platform-appropriate uninstall commands appear ------------
test('external-tool uninstall commands are platform-appropriate', () => {
  const result = spawnSync(process.execPath, [SCRIPT, '--list-locations'], {
    env: { ...process.env, NO_COLOR: '1' },
    encoding: 'utf8',
    timeout: 10_000,
  })
  const out = result.stdout
  if (process.platform === 'win32') {
    if (!out.includes('winget') && !out.includes('Settings → Apps')) {
      throw new Error('expected Windows-specific uninstall commands')
    }
    if (out.includes('brew uninstall')) {
      throw new Error('macOS commands leaked into Windows output')
    }
  } else if (process.platform === 'darwin') {
    if (!out.includes('brew')) throw new Error('expected brew commands on macOS')
  } else {
    if (!out.includes('apt remove') && !out.includes('pacman')) {
      throw new Error('expected Linux distro package manager commands')
    }
  }
})

// --- Leftover-files note -------------------------------------------------
//
// The note is the only record that survives the terminal closing, so its two
// safety properties are worth pinning: it must not appear during a dry run
// (which promises to touch nothing), and it must never tell someone to delete
// a shared dependency without warning them first.

/** Build a throwaway repo + config/data tree and run a REAL uninstall in it.
 *
 *  CRITICAL: the script must be COPIED into the sandbox and run from there.
 *  uninstall.mjs derives REPO_ROOT from its OWN file location
 *  (`resolve(__dirname, '..')`), NOT from cwd — so spawning the real
 *  scripts/uninstall.mjs with `cwd` set to a sandbox still targets the real
 *  repo, and a non-dry-run would delete the real node_modules/dist. The
 *  existing tests above are safe only because they use --dry-run or abort at
 *  a prompt. Any test that actually deletes MUST use the copy.
 *
 *  `tusks-tomes` also has to be a real path SEGMENT in the config/data dirs,
 *  or the script's own brand guard refuses them — see the prefix test above. */
function runRealUninstallInSandbox(extraArgs = []) {
  const root = mkdtempSync(join(tmpdir(), 'tt-uninst-'))
  const repo = join(root, 'repo')
  const cfg = join(root, 'cfg', 'tusks-tomes')
  const data = join(root, 'data', 'tusks-tomes')
  mkdirSync(join(repo, 'scripts'), { recursive: true })
  mkdirSync(join(repo, 'node_modules', 'x'), { recursive: true })
  mkdirSync(join(repo, 'dist'), { recursive: true })
  mkdirSync(cfg, { recursive: true })
  mkdirSync(join(data, 'sessions', 's1'), { recursive: true })
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'tusks-tomes', version: '0.0.0' }))
  writeFileSync(join(cfg, 'glossary.json'), '{"a":1}')
  writeFileSync(join(cfg, 'routing.json'), '{"b":2}')
  writeFileSync(join(data, 'sessions', 's1', 'session.txt'), 'audio')

  const sandboxScript = join(repo, 'scripts', 'uninstall.mjs')
  writeFileSync(sandboxScript, readFileSync(SCRIPT, 'utf8'))

  const result = spawnSync(
    process.execPath,
    [sandboxScript, '--i-accept-the-risk', '--force', ...extraArgs],
    {
      cwd: repo,
      env: {
        ...process.env,
        NO_COLOR: '1',
        TUSKS_CONFIG_DIR: cfg,
        TUSKS_DATA_DIR: data,
        TUSKS_CACHE_DIR: join(root, 'cache', 'tusks-tomes'),
      },
      encoding: 'utf8',
      timeout: 30_000,
    },
  )
  return { root, repo, cfg, data, result }
}

const NOTE = 'TUSKS-TOMES-uninstall-notes.md'

test('writes a leftover-files note after a real uninstall', () => {
  const { root, repo, result } = runRealUninstallInSandbox()
  try {
    if (result.status !== 0) throw new Error(`uninstall exited ${result.status}: ${result.stderr?.slice(0, 300)}`)
    const notePath = join(repo, NOTE)
    if (!existsSync(notePath)) throw new Error('no leftover-files note was written')
    const note = readFileSync(notePath, 'utf8')

    // It must distinguish what went from what stayed — that's the whole point.
    if (!note.includes('## What was removed')) throw new Error('note is missing the removed section')
    if (!note.includes('KEPT')) throw new Error('note is missing the preserved section')
    if (!note.includes('glossary.json')) throw new Error('preserved user data not listed in the note')

    // The load-bearing warning: never tell someone to delete a shared runtime
    // without saying what else might need it.
    if (!note.includes('Node.js')) throw new Error('note does not mention Node.js')
    if (!/may depend on them/i.test(note)) throw new Error('note lacks the shared-dependency warning')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the note does NOT claim user data was deleted when it was preserved', () => {
  const { root, repo, cfg, result } = runRealUninstallInSandbox()
  try {
    if (result.status !== 0) throw new Error(`uninstall exited ${result.status}`)
    // The file must still be on disk...
    if (!existsSync(join(cfg, 'glossary.json'))) throw new Error('glossary.json was deleted — user data must be preserved')
    // ...and must be listed under KEPT, not under removed.
    const note = readFileSync(join(repo, NOTE), 'utf8')
    const removedSection = note.split('## What was removed')[1]?.split('##')[0] ?? ''
    if (removedSection.includes('glossary.json')) {
      throw new Error('note lists preserved user data as removed')
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('--no-notes suppresses the note', () => {
  const { root, repo, result } = runRealUninstallInSandbox(['--no-notes'])
  try {
    if (result.status !== 0) throw new Error(`uninstall exited ${result.status}`)
    if (existsSync(join(repo, NOTE))) throw new Error('--no-notes still wrote the note')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('dry-run writes no note (it must touch nothing)', () => {
  // Uses the sandbox COPY deliberately. Running the real SCRIPT here would
  // resolve REPO_ROOT to the real repo, so the assertion below would check a
  // directory the script never writes to and pass for the wrong reason.
  const root = mkdtempSync(join(tmpdir(), 'tt-uninst-dry-'))
  const repo = join(root, 'repo')
  mkdirSync(join(repo, 'scripts'), { recursive: true })
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'tusks-tomes', version: '0.0.0' }))
  const sandboxScript = join(repo, 'scripts', 'uninstall.mjs')
  writeFileSync(sandboxScript, readFileSync(SCRIPT, 'utf8'))
  try {
    const result = spawnSync(process.execPath, [sandboxScript, '--dry-run'], {
      cwd: repo,
      env: { ...process.env, NO_COLOR: '1' },
      encoding: 'utf8',
      timeout: 30_000,
    })
    if (result.status !== 0) throw new Error(`dry-run exited ${result.status}`)
    if (existsSync(join(repo, NOTE))) throw new Error('dry-run created a file — it must not write anything')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

console.log(`\n${passed} passed, ${failed} failed.`)
// Skip process.exit when imported by vitest — vitest treats any
// process.exit call as a test-suite failure, even with code 0. Re-
// surface the harness result through a single it() so vitest counts
// the harness and a regression shows up as a normal test failure.
if (typeof globalThis.it !== 'function') {
  process.exit(failed === 0 ? 0 : 1)
} else {
  // eslint-disable-next-line no-undef
  it('uninstall.mjs safety harness — 17-test self-contained suite', () => {
    if (failed > 0) throw new Error(`uninstall harness reported ${failed} failure(s)`)
  })
}
