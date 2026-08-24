#!/usr/bin/env node
/*
 * Tusk's Tomes uninstaller.
 *
 * Cross-platform clean-out script. The model:
 *
 *   1. Build artifacts + the Whisper Python venv — ALWAYS removed (auto-
 *      generated, recreatable by re-running setup).
 *   2. Caches + machine-bound state (probe cache, encryption salt, run
 *      checkpoints, addon markers, profiles, routing) — ALWAYS removed.
 *   3. User-authored content (glossary, speakers, personas, encrypted API
 *      keys, session recordings, auto-saved chronicles) — PRESERVED by
 *      default. Pass `--purge-user-data` to remove these too.
 *
 * Things the script NEVER touches, regardless of flags:
 *
 *   • Anything outside the repo, the Tusks-Tomes app-data dir, and the
 *     legacy "silence-beyond-the-sea" app-data dir.
 *   • A `Tusks-Lore` folder anywhere on disk — your lore documents are
 *     yours.
 *   • `TUSKS_SESSIONS_DIR` if set — you explicitly chose a custom
 *     location, the script assumes you want it kept.
 *   • The repo directory itself (`node_modules`, `dist`, `vendor` etc.
 *     inside it are deleted, but the repo source stays). `rm -rf` /
 *     `Remove-Item` the repo manually after this script finishes if you
 *     want the source gone too.
 *
 * Run:
 *   npm run uninstall                          # interactive
 *   npm run uninstall -- --dry-run             # show what would happen, delete nothing
 *   npm run uninstall -- --force               # skip every prompt (still preserves user data)
 *   npm run uninstall -- --purge-user-data     # also remove glossary/speakers/personas/sessions/chronicles
 *
 * Or directly (works after node_modules has been removed too):
 *   node scripts/uninstall.mjs [flags]
 *
 * Zero npm dependencies — uses only Node.js stdlib so it runs even
 * after node_modules is wiped.
 */

import { rm, readdir, stat, readFile, realpath, writeFile } from 'node:fs/promises'
import { join, resolve, dirname, sep } from 'node:path'
import { homedir, platform } from 'node:os'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')
const PLATFORM = platform()

const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const FORCE = args.includes('--force') || args.includes('-y')
const PURGE_USER_DATA = args.includes('--purge-user-data')
const ACKNOWLEDGED = args.includes('--i-accept-the-risk')
const LIST_LOCATIONS = args.includes('--list-locations')
const HELP = args.includes('--help') || args.includes('-h')
const NO_NOTES = args.includes('--no-notes')

/** Where to leave the leftover-files note. Defaults to the repo root, which
 *  survives this script (the repo source is never deleted here). A user who
 *  then deletes the folder is told, in the note and on screen, to move it
 *  somewhere else first. `--notes-path <dir>` is the only way this script
 *  writes outside the repo, and it requires the user to have asked for it. */
const NOTES_PATH_ARG = (() => {
  const i = args.indexOf('--notes-path')
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null
})()

const NOTES_FILENAME = 'TUSKS-TOMES-uninstall-notes.md'

if (HELP) {
  console.log(`
Tusk's Tomes uninstaller — see comment at top of scripts/uninstall.mjs for full docs.

Flags:
  --dry-run             list what would be deleted, delete nothing. SAFE.
  --list-locations      print a machine-specific list of every path Tusk's
                        Tomes installs or writes to (for manual cleanup),
                        then exit without taking any action
  --i-accept-the-risk   skip the acknowledgement prompt (still asks for final
                        Y/N unless --force is also given)
  --force, -y           skip the final Y/N confirmation. Does NOT skip the
                        acknowledgement prompt — combine with
                        --i-accept-the-risk for fully non-interactive runs.
  --purge-user-data     also remove glossary, speakers, personas, API keys,
                        session recordings, and auto-saved chronicles
  --notes-path <dir>    where to save the leftover-files note. Defaults to the
                        repo root. This is the ONLY way this script writes
                        outside the repo, and only when you ask it to.
  --no-notes            don't save the leftover-files note at all
  --help, -h            this message

Leftover-files note: unless --no-notes is passed, the uninstaller writes
"${NOTES_FILENAME}" recording what was removed, what was kept and why,
and which leftovers (Node, Python, Ollama…) are shared with other software
and should NOT be blindly deleted. The on-screen output disappears when the
window closes; that file doesn't.

Acknowledgement: by default this script will refuse to start until you
type "I UNDERSTAND" in response to the safety warning. That ensures you
have read the risk list before any deletion happens. Pass
--i-accept-the-risk to skip the prompt (e.g. in CI), but read the
warning text in the script header at least once before doing so.
`)
  process.exit(0)
}

// ---- colour helpers ----------------------------------------------------
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR
const c = (code, s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s)
const bold = (s) => c('1', s)
const dim = (s) => c('2', s)
const green = (s) => c('32', s)
const yellow = (s) => c('33', s)
const red = (s) => c('31', s)
const cyan = (s) => c('36', s)

// ---- platform paths ----------------------------------------------------
// Replicates env-paths('<name>', {suffix:''}) without the dep so the
// script works after node_modules is gone.
function envPathsFor(name) {
  if (PLATFORM === 'win32') {
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    return {
      config: join(appData, name, 'Config'),
      data: join(localAppData, name, 'Data'),
      cache: join(localAppData, name, 'Cache'),
    }
  }
  if (PLATFORM === 'darwin') {
    return {
      config: join(homedir(), 'Library', 'Preferences', name),
      data: join(homedir(), 'Library', 'Application Support', name),
      cache: join(homedir(), 'Library', 'Caches', name),
    }
  }
  // Linux / BSD: XDG base dir spec
  return {
    config: join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), name),
    data: join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), name),
    cache: join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), name),
  }
}

// server/appData.ts honours env-var overrides for parallel-run isolation.
// Mirror that here so an uninstaller run inside a custom env still hits
// the right tree.
function resolveOverride(envVar, fallback) {
  const raw = process.env[envVar]?.trim()
  return raw ? resolve(raw) : fallback
}

const tusks = envPathsFor('tusks-tomes')
const legacy = envPathsFor('silence-beyond-the-sea')

const PATHS = {
  config: resolveOverride('TUSKS_CONFIG_DIR', tusks.config),
  data: resolveOverride('TUSKS_DATA_DIR', tusks.data),
  cache: resolveOverride('TUSKS_CACHE_DIR', tusks.cache),
  legacyConfig: legacy.config,
  legacyData: legacy.data,
  legacyCache: legacy.cache,
  sessionsOverride: process.env.TUSKS_SESSIONS_DIR?.trim()
    ? resolve(process.env.TUSKS_SESSIONS_DIR)
    : null,
}

// ---- safety guards -----------------------------------------------------
// Three layers of defence so a misconfigured env / a script copied to the
// wrong dir / a symlink pointing at /etc/ can't escape and damage anything
// outside the program's own footprint.

// Layer 1: refuse to run if REPO_ROOT isn't actually a Tusks-Tomes repo.
async function verifyTusksRepo() {
  const pkgPath = join(REPO_ROOT, 'package.json')
  let pkg
  try {
    pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
  } catch (err) {
    console.error(red(`\n✗ Aborting: cannot read ${pkgPath}.`))
    console.error(red(`  Reason: ${err.message}`))
    console.error(red(`  REPO_ROOT was computed as: ${REPO_ROOT}`))
    console.error(red(`  This script must be run from inside the Tusks-Tomes repo (scripts/uninstall.mjs).`))
    console.error(red(`  No files were touched.`))
    process.exit(1)
  }
  if (pkg.name !== 'tusks-tomes') {
    console.error(red(`\n✗ Aborting: package.json at ${pkgPath} has name "${pkg.name}", expected "tusks-tomes".`))
    console.error(red(`  This script refuses to run outside the Tusks-Tomes repo for safety.`))
    console.error(red(`  No files were touched.`))
    process.exit(1)
  }
}

/** REPO_ROOT with symlinks, junctions and Windows 8.3 short names resolved.
 *
 *  The containment check below compares a realpath'd target against the repo
 *  root, so the root has to be realpath'd too or the two are in different
 *  forms and every comparison fails. This is not theoretical: Windows hands
 *  out 8.3 short names, so a temp directory under `C:\Users\<name>` is
 *  routinely reported with the account name truncated and suffixed `~1`,
 *  which realpath then expands back to the full name. Comparing one form
 *  against the other refused every deletion and aborted the uninstall — safe,
 *  but completely broken for any user whose repo sits under an 8.3 short name
 *  or a junction.
 *
 *  Cached, and falls back to the unresolved root if realpath fails (the repo
 *  must exist by this point — layer 1 already read its package.json — but a
 *  permissions oddity should degrade to the old behaviour, not crash). */
let repoRootRealCache = null
async function repoRootReal() {
  if (repoRootRealCache === null) {
    try {
      repoRootRealCache = await realpath(REPO_ROOT)
    } catch {
      repoRootRealCache = REPO_ROOT
    }
  }
  return repoRootRealCache
}

// Layer 2: every path we touch must, after resolving symlinks/junctions,
// either live under REPO_ROOT (which we verified above) or contain a
// "tusks-tomes" / "silence-beyond-the-sea" segment. That branding
// marker is the invariant — every app-data path env-paths produces has it.
//
// `root` is the REAL repo root — see repoRootReal() for why it must be.
function isPathSafe(absPath, root) {
  // Windows path comparison is case-insensitive, and 8.3 expansion can change
  // case on the way through realpath. On POSIX, case is significant.
  const fold = (p) => (platform() === 'win32' ? p.toLowerCase() : p)
  const target = fold(absPath)
  const base = fold(root)
  if (target === base || target.startsWith(base + sep)) return true
  const segments = absPath.split(/[\\/]/).filter(Boolean).map((s) => s.toLowerCase())
  return segments.includes('tusks-tomes') || segments.includes('silence-beyond-the-sea')
}

async function assertSafePath(path) {
  // Resolve symlinks so a junction inside our config dir pointing at /etc/
  // can't sneak the deletion outside our managed paths.
  let real
  try {
    real = await realpath(path)
  } catch {
    // Path doesn't exist — nothing to validate; nothing to delete either.
    return null
  }
  const root = await repoRootReal()
  if (!isPathSafe(real, root)) {
    throw new Error(
      `Path safety check failed for ${path}\n` +
      `  resolves to: ${real}\n` +
      `  not under REPO_ROOT (${root}) and contains no "tusks-tomes"/"silence-beyond-the-sea" segment.\n` +
      `  Refusing to delete.`
    )
  }
  return real
}

// Layer 3: warn loudly if env-var overrides are in play, since those bypass
// the env-paths defaults. The path-safety check still gates every actual
// deletion, but the user should know they're not on the standard path.
function reportEnvOverrides() {
  const overrides = []
  for (const v of ['TUSKS_CONFIG_DIR', 'TUSKS_DATA_DIR', 'TUSKS_CACHE_DIR', 'TUSKS_SESSIONS_DIR']) {
    const raw = process.env[v]?.trim()
    if (raw) overrides.push([v, raw])
  }
  if (overrides.length === 0) return
  console.log(yellow('\n⚠ Environment overrides detected — running against non-default paths:'))
  for (const [k, v] of overrides) console.log(yellow(`    ${k} = ${v}`))
  console.log(yellow('  Path-safety check applies regardless; any path failing it will abort the run.'))
}

// ---- helpers -----------------------------------------------------------
async function exists(p) {
  try { await stat(p); return true } catch { return false }
}

async function isEmptyDir(p) {
  try {
    const entries = await readdir(p)
    return entries.length === 0
  } catch { return false }
}

async function dirSize(p) {
  try {
    const s = await stat(p)
    if (!s.isDirectory()) return s.size
    let total = 0
    const entries = await readdir(p, { withFileTypes: true })
    for (const e of entries) total += await dirSize(join(p, e.name))
    return total
  } catch { return 0 }
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

// Stdin handling. Two modes:
//
//   Interactive (TTY): use readline.question() per prompt. A single
//     readline interface is shared across the whole run.
//
//   Piped (non-TTY, e.g. test harness or shell-script wrapper): readline
//     has a known issue where the second question() call hangs after
//     stdin reaches EOF. So when stdin is not a TTY we preload every line
//     upfront and have askLine() dequeue from that buffer.
//
// closeRl() flushes the readline interface at end-of-run; safe to call
// when nothing was opened.
let _rl = null
let _preloadedLines = null

async function preloadStdinIfPiped() {
  if (stdin.isTTY) return
  _preloadedLines = []
  let buffer = ''
  for await (const chunk of stdin) {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
  }
  for (const line of buffer.split(/\r?\n/)) _preloadedLines.push(line)
  // Trailing newline produces a final empty entry — strip it.
  if (_preloadedLines.length > 0 && _preloadedLines[_preloadedLines.length - 1] === '') {
    _preloadedLines.pop()
  }
}

function rl() {
  if (!_rl) _rl = createInterface({ input: stdin, output: stdout })
  return _rl
}

function closeRl() {
  if (_rl) { _rl.close(); _rl = null }
}

async function askLine(question) {
  if (_preloadedLines !== null) {
    // Non-interactive: echo the prompt + the (already-known) answer so
    // captured stdout still reflects the conversation.
    stdout.write(question)
    const next = _preloadedLines.shift() ?? ''
    stdout.write(next + '\n')
    return next
  }
  try {
    return await rl().question(question)
  } catch {
    // readline rejects on closed stdin; treat as "no answer"
    return ''
  }
}

async function prompt(question, defaultYes = false) {
  if (FORCE || DRY_RUN) return DRY_RUN ? true : true
  const suffix = defaultYes ? '[Y/n]' : '[y/N]'
  const answer = (await askLine(`${question} ${suffix} `)).trim().toLowerCase()
  if (!answer) return defaultYes
  return answer === 'y' || answer === 'yes'
}

// Prints a machine-specific reference listing every path Tusk's Tomes
// installs or writes to, plus the external tools the user installed
// alongside it. Single source of truth — invoked from:
//   - --list-locations (prints and exits)
//   - the acknowledgement notice (so the interactive user sees it)
//   - the top of a --dry-run (where acknowledgement is skipped)
function printManualCleanupReference() {
  const sep = '─'.repeat(70)
  console.log(bold(cyan('\n' + sep)))
  console.log(bold(cyan('  MANUAL UNINSTALL REFERENCE — what Tusk\'s Tomes installs on disk')))
  console.log(bold(cyan(sep + '\n')))

  console.log('If you would rather clean up by hand instead of running this script,')
  console.log('here is every path the install scripts and the running program touch')
  console.log('on this machine.\n')

  console.log(bold('▸ Created by `npm install` (this repo\'s JS dependencies):'))
  console.log(`    ${REPO_ROOT}${sepChar()}node_modules${sepChar()}`)
  console.log('')

  console.log(bold('▸ Created by `npm run build`:'))
  console.log(`    ${REPO_ROOT}${sepChar()}dist${sepChar()}             (client build)`)
  console.log(`    ${REPO_ROOT}${sepChar()}dist-server${sepChar()}      (server build)`)
  console.log('')

  console.log(bold('▸ Created by the Audio Transcription add-on install'))
  console.log(dim('  (Settings → Add-ons → Install, which runs scripts/whisper/setup.{ps1,sh}):'))
  console.log(`    ${REPO_ROOT}${sepChar()}vendor${sepChar()}python-venv${sepChar()}`)
  console.log(dim('      contains Python 3.10–3.12 venv + faster-whisper + torch (+ CUDA wheel)'))
  console.log('')

  console.log(bold('▸ Created at runtime in the platform config directory:'))
  console.log(`    ${PATHS.config}${sepChar()}`)
  console.log(dim('      ├── glossary.json              (your lore-term corrections)'))
  console.log(dim('      ├── speakers.json              (Discord-ID → player/character map)'))
  console.log(dim('      ├── personas.json              (user-authored chronicle narrators)'))
  console.log(dim('      ├── providers.enc              (encrypted API keystore, machine-bound)'))
  console.log(dim('      ├── profiles.json              (per-provider model choices)'))
  console.log(dim('      ├── routing.json               (per-phase provider routing)'))
  console.log(dim('      ├── addons.json                (add-on enable/disable toggle state)'))
  console.log(dim('      ├── settings.json              (updater + misc preferences)'))
  console.log(dim('      ├── .salt                      (scrypt salt for the keystore)'))
  console.log(dim('      ├── local-llm.enabled          (marker for Local LLMs add-on)'))
  console.log(dim('      ├── personas-addon.enabled     (marker for Personas add-on)'))
  console.log(dim('      └── runs/                      (paused-pipeline checkpoints)'))
  console.log('')

  console.log(bold('▸ Created at runtime in the platform data directory:'))
  console.log(`    ${PATHS.data}${sepChar()}`)
  console.log(dim('      └── sessions/                  (per-session audio + transcripts + manifests)'))
  if (PATHS.sessionsOverride) {
    console.log(yellow(`    Plus your TUSKS_SESSIONS_DIR override:`))
    console.log(yellow(`      ${PATHS.sessionsOverride}${sepChar()}`))
  }
  console.log('')

  console.log(bold('▸ Created at runtime in the platform cache directory:'))
  console.log(`    ${PATHS.cache}${sepChar()}`)
  console.log(dim('      └── capability.json            (local-LLM mini-probe results)'))
  console.log('')

  console.log(bold('▸ Auto-saved chronicles (Markdown):'))
  console.log(`    ${REPO_ROOT}${sepChar()}Sessions${sepChar()}<campaign>${sepChar()}*.md`)
  console.log('')

  console.log(bold('▸ Legacy locations (pre-rename — only present if you installed before the'))
  console.log(bold('  Silence Beyond the Sea → Tusk\'s Tomes rename):'))
  console.log(`    ${PATHS.legacyConfig}${sepChar()}`)
  console.log(`    ${PATHS.legacyData}${sepChar()}`)
  console.log(`    ${PATHS.legacyCache}${sepChar()}`)
  console.log('')

  console.log(bold('▸ External tools you installed separately to use the add-ons:'))
  console.log(dim('   (NOT installed by Tusk\'s Tomes — these may be used by other apps;'))
  console.log(dim('   remove only if you\'re sure nothing else depends on them.)'))
  if (PLATFORM === 'win32') {
    console.log('    • Node.js                 — uninstall via Settings → Apps, or use `winget uninstall OpenJS.NodeJS`')
    console.log('    • Python 3.10–3.12        — uninstall via Settings → Apps, or `winget uninstall Python.Python.3.X`')
    console.log('    • Ollama                  — uninstall via Settings → Apps, or `winget uninstall Ollama.Ollama`')
    console.log('    • LM Studio               — uninstall via Settings → Apps')
    console.log('    • Unsloth Studio          — see the Unsloth docs for its own uninstaller')
    console.log('    • Tusk\'s Vault            — if you paired one, uninstall it from its own repo')
  } else if (PLATFORM === 'darwin') {
    console.log('    • Node.js                 — `brew uninstall node`, or remove the Node installer\'s pkg')
    console.log('    • Python 3.10–3.12        — `brew uninstall python@3.X`, or remove from /Library/Frameworks/Python.framework')
    console.log('    • Ollama                  — drag Ollama.app to Trash, or `brew uninstall ollama`')
    console.log('    • LM Studio               — drag LM Studio.app to Trash')
    console.log('    • Unsloth Studio          — see the Unsloth docs for its own uninstaller')
    console.log('    • Tusk\'s Vault            — if you paired one, uninstall it from its own repo')
  } else {
    console.log('    • Node.js                 — `apt remove nodejs` / `dnf remove nodejs` / `pacman -R nodejs`,')
    console.log('                                  or remove the nvm/asdf install')
    console.log('    • Python 3.10–3.12        — your distro\'s package manager (usually pre-installed; do not remove')
    console.log('                                  the system Python unless you\'re sure nothing else needs it)')
    console.log('    • Ollama                  — `curl -fsSL https://ollama.com/install.sh | sh -s -- --uninstall` or the')
    console.log('                                  manual systemd/service teardown from the Ollama docs')
    console.log('    • LM Studio / Unsloth     — see each project\'s own uninstall docs')
    console.log('    • Tusk\'s Vault            — if you paired one, uninstall it from its own repo')
  }
  console.log('')

  console.log(bold('▸ The repo source itself:'))
  if (PLATFORM === 'win32') {
    console.log(cyan(`    Remove-Item -Recurse -Force "${REPO_ROOT}"`))
  } else {
    console.log(cyan(`    rm -rf "${REPO_ROOT}"`))
  }
  console.log(dim('    Run this AFTER you have removed node_modules + vendor (or run this script')
           + dim(' first; both work).\n'))

  console.log(bold(cyan(sep + '\n')))
}

function sepChar() {
  return PLATFORM === 'win32' ? '\\' : '/'
}

// ---- leftover-files note -----------------------------------------------
//
// The on-screen reference above is thorough, and completely useless ten
// seconds after the window closes. This writes the same information to a file
// that outlives the run, reporting what ACTUALLY happened on this machine
// rather than a generic list.
//
// Deliberately plain-spoken: the audience is someone who has just uninstalled
// a program and wants to know what is still on their computer and whether it
// is safe to delete. The single most important thing it does is tell them
// which leftovers are SHARED with other software — deleting Python or Node
// because a note told them to would be a genuinely damaging outcome.

/** External tools we did not install and must not tell anyone to blindly
 *  remove. Each entry says what else might depend on it. */
function sharedToolNotes() {
  const rows = [
    {
      name: 'Node.js',
      why: 'Required to run Tusk’s Tomes.',
      shared:
        'Very commonly used by other software and by developer tooling. If anything else on this computer is a developer tool, it probably needs Node.',
      how:
        PLATFORM === 'win32'
          ? 'Settings → Apps → Installed apps → Node.js → Uninstall'
          : PLATFORM === 'darwin'
            ? '`brew uninstall node`, or remove the Node installer package'
            : 'your package manager (`apt remove nodejs`, `dnf remove nodejs`, …), or your nvm/asdf install',
    },
    {
      name: 'Python 3.10–3.12',
      why: 'Only needed if you installed the Audio Transcription (Whisper) add-on.',
      shared:
        'Frequently used by other applications. On macOS and Linux the system itself depends on Python — removing it can break your operating system. Leave it unless you are certain.',
      how:
        PLATFORM === 'win32'
          ? 'Settings → Apps → Installed apps → Python → Uninstall'
          : 'Strongly recommended: leave it installed.',
    },
    {
      name: 'Ollama / LM Studio / Unsloth',
      why: 'Only if you installed the Local LLMs add-on.',
      shared: 'Standalone apps with their own uninstallers. They also store downloaded AI models, which can be many gigabytes.',
      how:
        PLATFORM === 'win32'
          ? 'Settings → Apps → Installed apps, then remove each one'
          : PLATFORM === 'darwin'
            ? 'Drag the app to the Trash, or use `brew uninstall`'
            : 'See each project’s own uninstall instructions',
    },
    {
      name: 'Discord / Craig',
      why: 'Craig is a Discord bot used for recording sessions.',
      shared:
        'Nothing was installed on your computer for Craig — it runs on Discord’s servers. If you want to stop it, remove the bot from your Discord server. Discord itself is unrelated to Tusk’s Tomes.',
      how: 'Remove the Craig bot from your Discord server, if you added it.',
    },
    {
      name: 'Obsidian',
      why: 'Optional, for keeping campaign lore.',
      shared:
        'Your vault is your own notes and has nothing to do with Tusk’s Tomes. **Do not delete your vault.** We only ever read from it.',
      how: 'Uninstall Obsidian normally if you no longer want it. Keep your notes folder.',
    },
  ]
  return rows
}

function buildUninstallNotes() {
  const L = []
  const p = (s = '') => L.push(s)
  const removed = ledger.filter((e) => e.outcome === 'removed')
  const preserved = ledger.filter((e) => e.outcome === 'preserved')
  const failed = ledger.filter((e) => e.outcome === 'failed')

  p('# Tusk’s Tomes — what’s left on your computer')
  p()
  p('Tusk’s Tomes has been uninstalled. This file was written by the uninstaller')
  p('so you have a record after the window closed.')
  p()
  p('**Nothing below needs to be deleted.** It is listed so you know it exists, and')
  p('so you can remove it if you want to. Some of it is yours, and some of it is')
  p('shared with other programs — read the warnings before deleting anything.')
  p()
  p('---')
  p()

  p('## What was removed')
  p()
  if (removed.length === 0) {
    p('_Nothing was removed._')
  } else {
    p('| What | Where |')
    p('|---|---|')
    for (const e of removed) p(`| ${e.label} | \`${e.path}\` |`)
  }
  p()

  if (failed.length > 0) {
    p('## What could NOT be removed')
    p()
    p('These failed to delete — usually because a file was open, or Windows had it')
    p('locked. Close any editors or terminals using the folder and try again, or')
    p('delete these by hand.')
    p()
    for (const e of failed) p(`- ${e.label} — \`${e.path}\``)
    p()
  }

  p('## What was deliberately KEPT (your own content)')
  p()
  if (preserved.length === 0) {
    p('_Nothing of yours was found, or you chose to remove it too._')
  } else {
    p('The uninstaller does not delete things you made. These are still on disk:')
    p()
    p('| What | Where |')
    p('|---|---|')
    for (const e of preserved) p(`| ${e.label} | \`${e.path}\` |`)
    p()
    p('To remove these as well, re-run the uninstaller with `--purge-user-data`,')
    p('or just delete the folders listed above.')
  }
  p()

  p('## Everywhere Tusk’s Tomes ever writes')
  p()
  p('For completeness — this is the app’s full footprint on a machine, whether or')
  p('not those files exist on yours.')
  p()
  p('| Location | What lives there |')
  p('|---|---|')
  p(`| \`${REPO_ROOT}\` | The program itself. Also \`node_modules\` (downloaded code), \`dist\` (built files), and \`vendor${sepChar()}python-venv\` (speech-to-text). |`)
  p(`| \`${PATHS.config}\` | Settings: your glossary, speaker names, encrypted API key, model choices, add-on state. |`)
  p(`| \`${PATHS.data}\` | Session recordings and transcripts. |`)
  p(`| \`${PATHS.cache}\` | Disposable cached results. Safe to delete at any time. |`)
  p(`| \`${REPO_ROOT}${sepChar()}Sessions\` | Your finished chronicles, saved as Markdown. |`)
  if (PATHS.sessionsOverride) {
    p(`| \`${PATHS.sessionsOverride}\` | Your custom session folder (\`TUSKS_SESSIONS_DIR\`). **Never touched by the uninstaller.** |`)
  }
  p()
  p('The app never writes to the Windows registry, never installs a service, never')
  p('adds a startup entry, and never writes outside the folders above.')
  p()

  p('## Things we did NOT install — check before removing')
  p()
  p('These are separate programs you installed yourself. **Other software on your')
  p('computer may depend on them.** Removing them to "finish cleaning up" is the')
  p('most likely way to break something else.')
  p()
  for (const t of sharedToolNotes()) {
    p(`### ${t.name}`)
    p()
    p(`- **Why it was here:** ${t.why}`)
    p(`- **Careful:** ${t.shared}`)
    p(`- **To remove:** ${t.how}`)
    p()
  }

  p('## Removing the program folder itself')
  p()
  p('The uninstaller does not delete its own folder, because this file is in it.')
  p('When you have finished reading, move this file somewhere safe, then delete:')
  p()
  p('```')
  p(REPO_ROOT)
  p('```')
  p()
  p('You can do that in File Explorer / Finder — there is no need for a command.')
  p()
  p('---')
  p()
  p('If something here does not match what you see, the project is open source and')
  p('the uninstaller is readable at `scripts/uninstall.mjs`.')
  p()
  return L.join('\n')
}

async function writeUninstallNotes() {
  if (NO_NOTES) return null
  // A dry run must leave the disk exactly as it found it, including not
  // creating new files. Report the intent instead.
  if (DRY_RUN) {
    console.log(dim(`\n  · Leftover-files note: would be written (skipped in --dry-run)`))
    return null
  }
  const dir = NOTES_PATH_ARG ? resolve(NOTES_PATH_ARG) : REPO_ROOT
  const dest = join(dir, NOTES_FILENAME)
  try {
    await writeFile(dest, buildUninstallNotes(), 'utf8')
    return dest
  } catch (err) {
    console.log(yellow(`\n  ! Couldn't write the leftover-files note to ${dest}: ${err.message}`))
    return null
  }
}

// Mandatory pre-flight acknowledgement. Shown before any destructive
// action. The user must type the literal phrase "I UNDERSTAND" (case
// insensitive) to proceed. Anything else — empty line, "y", Ctrl-C —
// aborts the run cleanly.
//
// --dry-run skips this because no deletions happen.
// --i-accept-the-risk skips this for non-interactive callers (CI etc.).
async function requireAcknowledgement() {
  if (DRY_RUN || ACKNOWLEDGED) return

  const line = '═'.repeat(70)
  console.log(red('\n╔' + line + '╗'))
  console.log(red('║') + bold('                  ⚠  PLEASE READ BEFORE CONTINUING  ⚠                ') + red('║'))
  console.log(red('╚' + line + '╝\n'))

  console.log(bold('This script will permanently delete files Tusk\'s Tomes installed.'))
  console.log('That is its purpose. The default mode preserves your authored content')
  console.log('(glossary, speakers, personas, API keystore, session recordings,')
  console.log('chronicles); --purge-user-data removes those too.\n')

  console.log(bold(green('Safety guarantees built into this script:')))
  console.log('  • Refuses to start unless this is a real Tusks-Tomes repo')
  console.log('    (package.json with name="tusks-tomes")')
  console.log('  • Every path is realpath-resolved, so symlinks/junctions cannot')
  console.log('    escape the safety check')
  console.log('  • Every resolved path must live under the repo OR contain a')
  console.log('    "tusks-tomes"/"silence-beyond-the-sea" exact segment;')
  console.log('    anything else aborts the run')
  console.log('  • A Tusks-Lore folder is never touched, anywhere on disk')
  console.log('  • TUSKS_SESSIONS_DIR is never touched if you set it')
  console.log('  • The repo source itself is left alone (final-step command')
  console.log('    is printed for you to run manually if you want)\n')

  console.log(bold(yellow('Risks you can introduce by running it incorrectly:')))
  console.log('  • Running with ' + bold('sudo') + ' or ' + bold('as Administrator') + ' widens what the script COULD')
  console.log('    touch if a bug existed. ' + bold('Do not do this') + ' — the script never needs')
  console.log('    elevation.')
  console.log('  • Setting TUSKS_CONFIG_DIR / TUSKS_DATA_DIR / TUSKS_CACHE_DIR /')
  console.log('    TUSKS_SESSIONS_DIR to a non-Tusks path will be blocked by the')
  console.log('    safety check, but indicates a non-standard setup — review the')
  console.log('    warning above.')
  console.log('  • The final-step "Remove the repo" command the script prints at')
  console.log('    the end must be pasted ' + bold('exactly as printed') + '. Editing the path or')
  console.log('    omitting the quotes can affect other directories.')
  console.log('  • --purge-user-data removes glossary, speakers, personas, API keys,')
  console.log('    session recordings, and chronicles. ' + bold('Back them up first') + ' if you')
  console.log('    want any of these back later.\n')

  console.log(bold('By typing "I UNDERSTAND" below you confirm that:'))
  console.log('  (1) You have read the risk list above.')
  console.log('  (2) You will run this script exactly as documented — no sudo, no')
  console.log('      hand-edited paths, no piping into another command.')
  console.log('  (3) You accept that if you deviate from those instructions you')
  console.log('      may affect files outside what Tusks-Tomes installed, and')
  console.log('      that responsibility is yours.')
  console.log('  (4) Following the instructions exactly will only remove paths')
  console.log('      this script verified via the safety check.\n')

  // Manual-cleanup reference: shown here so the user has the full
  // path inventory in front of them before deciding whether to use the
  // script or do it by hand.
  printManualCleanupReference()

  console.log(dim('To abort without changes: press Ctrl-C, or just press Enter.\n'))

  const answer = (await askLine('Type exactly: I UNDERSTAND  →  ')).trim()

  if (answer.toUpperCase() !== 'I UNDERSTAND') {
    console.log(yellow('\nAcknowledgement not given. Aborted — no files were touched.'))
    closeRl()
    process.exit(0)
  }
  console.log(green('\nAcknowledged. Proceeding.\n'))
}

const summary = { deleted: 0, skipped: 0, preserved: 0, failed: 0, bytesFreed: 0 }

/** Per-path record of what actually happened, so the leftover note can report
 *  the real outcome rather than a generic list. The on-screen summary scrolls
 *  away with the terminal; this is what survives. */
const ledger = []
const record = (outcome, label, path, sizeBytes = 0) =>
  ledger.push({ outcome, label, path, sizeBytes })

async function removeIfPresent(label, path, opts = {}) {
  const { userContent = false } = opts
  if (!(await exists(path))) {
    console.log(dim(`  · ${label}: not present`))
    summary.skipped++
    return
  }
  // Safety gate: never delete a path that resolves outside our managed
  // footprint. Throws if the check fails so the run aborts loudly.
  try {
    await assertSafePath(path)
  } catch (err) {
    console.log(red(`  ✗ ${label} — SAFETY ABORT`))
    console.log(red(`      ${err.message.split('\n').join('\n      ')}`))
    summary.failed++
    throw err
  }
  const size = await dirSize(path)
  const sizeStr = formatSize(size)
  if (userContent && !PURGE_USER_DATA) {
    console.log(yellow(`  ⊘ ${label} (${sizeStr}) — preserved [user data]`))
    console.log(dim(`      ${path}`))
    summary.preserved++
    record('preserved', label, path, size)
    return
  }
  if (DRY_RUN) {
    console.log(red(`  • ${label} (${sizeStr}) — would delete`))
    console.log(dim(`      ${path}`))
    summary.deleted++
    summary.bytesFreed += size
    record('would-delete', label, path, size)
    return
  }
  try {
    await rm(path, { recursive: true, force: true })
    console.log(green(`  ✓ ${label} (${sizeStr}) — removed`))
    console.log(dim(`      ${path}`))
    summary.deleted++
    summary.bytesFreed += size
    record('removed', label, path, size)
  } catch (err) {
    console.log(red(`  ✗ ${label} — failed: ${err.message}`))
    console.log(dim(`      ${path}`))
    summary.failed++
    record('failed', label, path, size)
  }
}

async function removeIfEmpty(label, path) {
  if (!(await exists(path))) return
  try {
    await assertSafePath(path)
  } catch (err) {
    console.log(red(`  ✗ ${label} — SAFETY ABORT`))
    console.log(red(`      ${err.message.split('\n').join('\n      ')}`))
    summary.failed++
    throw err
  }
  if (await isEmptyDir(path)) {
    if (DRY_RUN) {
      console.log(red(`  • ${label} (empty dir) — would remove`))
    } else {
      try {
        await rm(path, { recursive: true, force: true })
        console.log(green(`  ✓ ${label} (empty dir) — removed`))
      } catch { /* harmless */ }
    }
  } else {
    console.log(dim(`  · ${label} preserved (contains other files): ${path}`))
  }
}

// ---- main --------------------------------------------------------------
async function main() {
  // Safety: bail out before touching anything if we're not actually
  // sitting in a Tusks-Tomes repo.
  await verifyTusksRepo()

  // --list-locations: print the manual-cleanup reference and exit. No
  // prompts, no deletions, no plan output.
  if (LIST_LOCATIONS) {
    printManualCleanupReference()
    return
  }

  // Preload piped stdin so multiple prompts can each consume a line
  // (readline can't handle this reliably across questions on its own).
  await preloadStdinIfPiped()

  // In --dry-run the acknowledgement is skipped, but the user still
  // wants to know what's where on disk in case they prefer manual
  // cleanup. Show the reference at the top.
  if (DRY_RUN) printManualCleanupReference()

  // Mandatory acknowledgement — explicit "I UNDERSTAND" required unless
  // --dry-run (no deletions) or --i-accept-the-risk (explicit opt-out).
  await requireAcknowledgement()

  console.log(bold('\n┌─ Tusk\'s Tomes uninstaller ' + '─'.repeat(40)))
  console.log(`│  Repo:          ${REPO_ROOT}`)
  console.log(`│  Config dir:    ${PATHS.config}`)
  console.log(`│  Data dir:      ${PATHS.data}`)
  console.log(`│  Cache dir:     ${PATHS.cache}`)
  console.log(`│  Legacy config: ${PATHS.legacyConfig}`)
  if (PATHS.sessionsOverride) {
    console.log(yellow(`│  TUSKS_SESSIONS_DIR is set → ${PATHS.sessionsOverride}`))
    console.log(yellow(`│    Session audio at that path will NOT be touched.`))
  }
  console.log(`│  Platform:      ${PLATFORM}`)
  console.log(`│  Mode:          ${DRY_RUN ? cyan('DRY RUN') : (FORCE ? yellow('forced (no prompts)') : 'interactive')}`)
  console.log(`│  User content:  ${PURGE_USER_DATA ? red('PURGE') : green('preserve')}`)
  console.log(bold('└' + '─'.repeat(68) + '\n'))

  console.log(bold('Safety guarantees:'))
  console.log('  • Will not run unless this is a real Tusks-Tomes repo (package.json name="tusks-tomes")')
  console.log('  • Every path is realpath-resolved before deletion; symlinks/junctions cannot escape')
  console.log('  • Every resolved path must live under the repo OR contain a "tusks-tomes"/"silence-')
  console.log('    beyond-the-sea" segment; anything else aborts the run')
  console.log('  • A `Tusks-Lore` folder is never touched, anywhere on disk')
  console.log('  • TUSKS_SESSIONS_DIR is never touched if set (your chosen custom session location)')
  console.log('  • The repo directory itself stays — exact removal command is printed at the end\n')

  reportEnvOverrides()

  // Final confirmation gate. The user has already typed I UNDERSTAND
  // (unless --dry-run / --i-accept-the-risk); this is the last
  // chance to back out after seeing the resolved paths above.
  if (!FORCE && !DRY_RUN) {
    const proceed = await prompt(bold('Proceed with uninstall? (last chance to back out)'), false)
    if (!proceed) {
      console.log(yellow('Aborted — no files were touched.'))
      return
    }
  }

  // ----- Stage 1: build artifacts + dependencies (auto-generated) -----
  console.log(bold('\n▸ Build artifacts + dependencies (auto-generated):'))
  await removeIfPresent('node_modules/', join(REPO_ROOT, 'node_modules'))
  await removeIfPresent('dist/ (client build)', join(REPO_ROOT, 'dist'))
  await removeIfPresent('dist-server/ (server build)', join(REPO_ROOT, 'dist-server'))
  // Remove vendor/ WHOLESALE rather than naming python-venv and then deleting
  // the parent only if it happens to be empty.
  //
  // The whole directory is gitignored (.gitignore: `vendor/`), so everything
  // inside it is downloaded or generated by an add-on install — there is no
  // user-authored content to protect. The previous per-subdirectory approach
  // silently orphaned anything else an add-on vendored: a second
  // transcription engine under vendor/whisper-cpp/, for instance, would have
  // left the binary and its model weights (well over a gigabyte) on disk
  // while reporting a clean uninstall.
  await removeIfPresent('vendor/ (add-on dependencies: Whisper venv, engine binaries, models)', join(REPO_ROOT, 'vendor'))

  // ----- Stage 2: caches + machine-bound state (auto-generated) -----
  console.log(bold('\n▸ Caches + machine-bound state:'))
  await removeIfPresent('Tusks cache dir', PATHS.cache)
  await removeIfPresent('Run checkpoints', join(PATHS.config, 'runs'))
  await removeIfPresent('Capability probe cache', join(PATHS.config, 'capability.json'))
  await removeIfPresent('Routing prefs', join(PATHS.config, 'routing.json'))
  await removeIfPresent('Model profiles', join(PATHS.config, 'profiles.json'))
  await removeIfPresent('Add-on toggle state', join(PATHS.config, 'addons.json'))
  await removeIfPresent('Settings', join(PATHS.config, 'settings.json'))
  await removeIfPresent('Crypto salt', join(PATHS.config, '.salt'))
  await removeIfPresent('Local-LLM add-on marker', join(PATHS.config, 'local-llm.enabled'))
  await removeIfPresent('Personas add-on marker', join(PATHS.config, 'personas-addon.enabled'))

  // ----- Stage 3: user-authored content (preserved unless --purge-user-data) -----
  console.log(bold('\n▸ User-authored content:'))
  if (!PURGE_USER_DATA) {
    console.log(dim('  (pass --purge-user-data to remove these too)'))
  }
  await removeIfPresent('Glossary (user lore terms)', join(PATHS.config, 'glossary.json'), { userContent: true })
  await removeIfPresent('Speakers (user-curated mapping)', join(PATHS.config, 'speakers.json'), { userContent: true })
  await removeIfPresent('Personas (user-authored)', join(PATHS.config, 'personas.json'), { userContent: true })
  await removeIfPresent('Encrypted API keystore', join(PATHS.config, 'providers.enc'), { userContent: true })
  await removeIfPresent('Session recordings + transcripts', join(PATHS.data, 'sessions'), { userContent: true })
  await removeIfPresent('Auto-saved chronicles', join(REPO_ROOT, 'Sessions'), { userContent: true })

  // ----- Stage 4: empty-dir cleanup -----
  console.log(bold('\n▸ Empty-directory cleanup:'))
  await removeIfEmpty('Config dir', PATHS.config)
  await removeIfEmpty('Data dir', PATHS.data)
  // For Windows env-paths layout, the parent %LOCALAPPDATA%\tusks-tomes\
  // wraps Data + Cache + Log + Temp under one folder — remove the wrapper
  // if every child went.
  if (PLATFORM === 'win32') {
    const localRoot = dirname(PATHS.data)
    if (localRoot.endsWith('tusks-tomes')) await removeIfEmpty('Tusks LocalAppData root', localRoot)
    const roamingRoot = dirname(PATHS.config)
    if (roamingRoot.endsWith('tusks-tomes')) await removeIfEmpty('Tusks Roaming AppData root', roamingRoot)
  }

  // ----- Stage 5: legacy "silence-beyond-the-sea" tree -----
  console.log(bold('\n▸ Legacy "silence-beyond-the-sea" tree:'))
  // After migrateLegacyAppData() runs, these should already be empty.
  // We only touch them if they're empty (so a user who never upgraded
  // doesn't lose data we don't recognise). With --purge-user-data we
  // delete them outright.
  if (PURGE_USER_DATA) {
    await removeIfPresent('Legacy config', PATHS.legacyConfig)
    await removeIfPresent('Legacy data', PATHS.legacyData)
    await removeIfPresent('Legacy cache', PATHS.legacyCache)
  } else {
    await removeIfEmpty('Legacy config (only if empty)', PATHS.legacyConfig)
    await removeIfEmpty('Legacy data (only if empty)', PATHS.legacyData)
    await removeIfEmpty('Legacy cache (only if empty)', PATHS.legacyCache)
  }

  // ----- summary -----
  console.log(bold('\n┌─ Summary ' + '─'.repeat(58)))
  console.log(`│  Removed:    ${green(String(summary.deleted))}`)
  console.log(`│  Preserved:  ${yellow(String(summary.preserved))} (user content; --purge-user-data to remove)`)
  console.log(`│  Skipped:    ${dim(String(summary.skipped))} (not present)`)
  console.log(`│  Failed:     ${summary.failed === 0 ? green('0') : red(String(summary.failed))}`)
  console.log(`│  Disk freed: ${cyan(formatSize(summary.bytesFreed))}${DRY_RUN ? dim(' (would be — dry run)') : ''}`)
  console.log(bold('└' + '─'.repeat(68)))

  if (DRY_RUN) {
    console.log(yellow('\nDry run — nothing was actually deleted. Re-run without --dry-run to apply.'))
  } else if (summary.failed > 0) {
    console.log(red('\nSome deletions failed — see lines marked ✗ above. Re-run, or remove the listed paths by hand.'))
  } else {
    console.log(green('\nEverything Tusk\'s Tomes installed has been removed.'))
  }

  // Final hand-off: the repo source + external tools the user installed
  // for Tusk's Tomes but that we can't safely auto-remove (they might
  // use them for other things too).
  console.log(bold('\n▸ To finish a complete revert (do these only if you want):'))
  console.log(`  1. Remove the repo source itself:`)
  if (PLATFORM === 'win32') {
    console.log(cyan(`        cd ..`))
    console.log(cyan(`        Remove-Item -Recurse -Force "${REPO_ROOT}"`))
  } else {
    console.log(cyan(`        cd ..`))
    console.log(cyan(`        rm -rf "${REPO_ROOT}"`))
  }
  console.log(`  2. Uninstall external tools you may have installed for Tusk's Tomes`)
  console.log(`     (this script does NOT touch them — they may be used by other apps):`)
  console.log(dim(`        • Node.js                — only if you don't use it for anything else`))
  console.log(dim(`        • Python 3.10–3.12       — installed for the Audio Transcription add-on`))
  console.log(dim(`        • Ollama / LM Studio / Unsloth Studio  — installed for the Local LLMs add-on`))
  console.log(dim(`        • Tusk's Vault           — sibling app installed separately, if you paired one`))

  // Persist the same information to disk. Everything above scrolls away the
  // moment the window closes, and "what is still on my computer?" is exactly
  // the question people ask afterwards.
  const notesPath = await writeUninstallNotes()
  if (notesPath) {
    console.log(bold(green('\n▸ A summary has been saved for you:')))
    console.log(cyan(`     ${notesPath}`))
    console.log('  It lists what was removed, what was kept and why, and which')
    console.log('  leftovers are shared with other programs so you don\'t delete')
    console.log(yellow('  something another app needs.'))
    console.log(dim('  Move this file somewhere safe before deleting the folder above.'))
  }
}

main()
  .then(() => closeRl())
  .catch((err) => {
    closeRl()
    console.error(red('\nUninstaller crashed:'), err)
    process.exit(1)
  })
