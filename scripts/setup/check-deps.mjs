#!/usr/bin/env node
/*
 * Cross-platform dependency check for Tusk's Tomes.
 *
 * Runs after Node.js has been confirmed installed (the platform-specific
 * setup.cmd / setup.sh wrappers handle the Node-missing case). Verifies
 * everything else the app needs and, where possible, fixes things
 * automatically:
 *
 *   1. Node.js   >= 20
 *   2. Git       (only checked, never installed)
 *   3. npm install   — runs if node_modules is missing or stale
 *   4. .env file     — copies .env.example if .env doesn't exist
 *   5. Python check  — info-only. Python 3.10–3.12 is only needed for the
 *                      Audio Transcription add-on, which is installed
 *                      in-app from Settings → Add-ons (not by this script).
 *   6. Optional: nvidia-smi presence (just reports; CUDA install is opt-in
 *                                     and only relevant to the audio addon).
 *
 * This script never installs system packages silently. When something's
 * missing it prints the exact copy-pasteable command for your OS and
 * exits 1.
 *
 * Run via `npm run setup`, or directly with `node scripts/setup/check-deps.mjs`.
 */

import { spawnSync, spawn } from 'node:child_process'
import { existsSync, copyFileSync, statSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { platform } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')
const PLATFORM = platform() // 'win32' | 'darwin' | 'linux' | ...

// ---------- Output helpers ----------
// No external deps so the script can run before `npm install` ever has.

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR
const c = (code, s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s)
const bold = (s) => c('1', s)
const green = (s) => c('32', s)
const yellow = (s) => c('33', s)
const red = (s) => c('31', s)
const cyan = (s) => c('36', s)
const dim = (s) => c('2', s)

function header(title) {
  console.log(`\n${bold(`── ${title} ─────────────────────────`.padEnd(60, '─'))}`)
}
function ok(msg) { console.log(`  ${green('✓')} ${msg}`) }
function warn(msg) { console.log(`  ${yellow('!')} ${msg}`) }
function fail(msg) { console.log(`  ${red('✗')} ${msg}`) }
function info(msg) { console.log(`  ${cyan('·')} ${msg}`) }

// ---------- Process helpers ----------

function run(cmd, args = [], opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    shell: PLATFORM === 'win32',
    ...opts,
  })
  return { code: r.status, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() }
}

function runInherit(cmd, args = []) {
  return new Promise((res) => {
    const child = spawn(cmd, args, {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      shell: PLATFORM === 'win32',
    })
    child.on('exit', (code) => res(code ?? 1))
  })
}

// ---------- Suggestions per OS ----------

function installCmd(pkg) {
  switch (PLATFORM) {
    case 'win32':
      return `winget install ${pkg.winget}`
    case 'darwin':
      return `brew install ${pkg.brew}`
    case 'linux':
      // Best-effort: prefer apt, then dnf, then pacman. Just print all
      // three — the user knows what they have.
      return [
        `sudo apt install ${pkg.apt}    # Debian / Ubuntu`,
        `sudo dnf install ${pkg.dnf}    # Fedora / RHEL`,
        `sudo pacman -S ${pkg.pacman}    # Arch`,
      ].join('\n      ')
    default:
      return `(install ${pkg.brew ?? pkg.apt ?? 'the package'} via your OS package manager)`
  }
}

const PKG_NODE = { winget: 'OpenJS.NodeJS.LTS', brew: 'node@20', apt: 'nodejs npm', dnf: 'nodejs npm', pacman: 'nodejs npm' }
const PKG_GIT = { winget: 'Git.Git', brew: 'git', apt: 'git', dnf: 'git', pacman: 'git' }

// ---------- Individual checks ----------

function checkNode() {
  const v = process.versions.node
  const major = parseInt(v.split('.')[0], 10)
  if (major >= 20) {
    ok(`Node.js ${v} (>= 20 required)`)
    return true
  }
  fail(`Node.js ${v} is too old — need 20 or newer.`)
  info(`Install: ${installCmd(PKG_NODE)}`)
  return false
}


function checkGit() {
  const r = run('git', ['--version'])
  if (r.code === 0) {
    ok(r.stdout)
    return true
  }
  fail('Git not found on PATH.')
  info(`Install: ${installCmd(PKG_GIT)}`)
  return false
}

function checkGpu() {
  const r = run('nvidia-smi', ['--query-gpu=name,driver_version', '--format=csv,noheader'])
  if (r.code === 0 && r.stdout) {
    const lines = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
    ok(`NVIDIA GPU detected — Whisper will run on CUDA: ${lines.join(' | ')}`)
    // Parse the first GPU's driver version (e.g. "NVIDIA RTX 3080, 552.44").
    // CUDA 12.x requires driver >= 525.60.13 on Linux / 528.33 on Windows.
    // Warn (don't block) if older — the Whisper setup script will fall
    // back to CPU wheels in that case, but the user should know why.
    const driverMatch = lines[0]?.match(/,\s*(\d+(?:\.\d+)+)\s*$/)
    if (driverMatch) {
      const driverMajor = Number(driverMatch[1].split('.')[0])
      if (Number.isFinite(driverMajor) && driverMajor < 525) {
        warn(
          `NVIDIA driver ${driverMatch[1]} is older than 525 — CUDA 12.x wheels (default for ` +
            'faster-whisper) require driver 525+. Whisper setup will likely fall back to CPU, or ' +
            'you can re-run with `--cuda 11.8` to use older CUDA 11 wheels. Update the driver via ' +
            'GeForce Experience / NVIDIA App for best Whisper performance.',
        )
      }
    }
    return 'cuda'
  }
  info('No NVIDIA GPU detected. Whisper will run on CPU (slower; still works).')
  return 'cpu'
}

/** Visual Studio Build Tools check — Windows only, and no longer a
 *  requirement.
 *
 *  This used to warn that MSVC was needed because `pdf-parse` compiled a
 *  native node-gyp addon at install time. `pdf-parse` was replaced by
 *  `pdfjs-dist` (pure JavaScript) and there is now NO dependency in the tree
 *  that compiles anything: the only packages with install scripts are
 *  `esbuild` and `ffmpeg-static`, both of which download a prebuilt binary,
 *  plus `fsevents` (macOS-only, optional).
 *
 *  The old warning told people to install a multi-gigabyte C++ toolchain they
 *  don't need, which is a real deterrent for exactly the non-technical users
 *  this project is trying to reach. Kept as an informational check only so
 *  the removal is visible rather than silent — if a compiling dependency is
 *  ever added back, restore the warning here. */
function checkBuildToolsWindows() {
  if (PLATFORM !== 'win32') return true
  info('No C++ build tools needed — nothing in the dependency tree compiles native code.')
  return true
}

function ensureEnv() {
  const envPath = join(REPO_ROOT, '.env')
  const examplePath = join(REPO_ROOT, '.env.example')
  if (existsSync(envPath)) {
    ok('.env exists.')
    return true
  }
  if (!existsSync(examplePath)) {
    warn('.env.example missing — skipping .env bootstrap.')
    return true
  }
  copyFileSync(examplePath, envPath)
  ok('Created .env from .env.example. Open it and add at least one provider key when you have one (you can also do this from the Settings tab in the running app).')
  return true
}

function nodeModulesUpToDate() {
  const nmPath = join(REPO_ROOT, 'node_modules')
  const lockPath = join(REPO_ROOT, 'package-lock.json')
  if (!existsSync(nmPath)) return false
  if (!existsSync(lockPath)) return true
  try {
    const nmStamp = statSync(join(nmPath, '.package-lock.json')).mtimeMs
    const lockStamp = statSync(lockPath).mtimeMs
    return nmStamp >= lockStamp
  } catch {
    return false
  }
}

/** Print platform-specific guidance after `npm install` fails. We can't
 *  intercept the npm output (stdio is inherited so the user sees real-time
 *  progress), so we print every common cause and let the reader match the
 *  one their error showed. */
function printNpmInstallRemediation() {
  console.log('')
  console.log(`  ${yellow(bold('Common causes — match against the error above:'))}`)
  if (PLATFORM === 'win32') {
    console.log(`
    • ${bold('"running scripts is disabled"')} — you launched from PowerShell with a restricted ExecutionPolicy. Either re-run via ${cyan('setup.bat')} (double-click), or run ${cyan('cmd /c npm install')}, or fix once with: ${cyan('Set-ExecutionPolicy -Scope CurrentUser RemoteSigned')}.
    • ${bold('EPERM / EBUSY / "operation not permitted"')} — a file in node_modules is locked. Close VS Code, pause OneDrive sync for this folder, temporarily pause your antivirus, then retry.
    • ${bold('EACCES')} — the repo lives in a write-protected location (e.g. Program Files, a network drive). Move the folder somewhere writable (Documents, Desktop) and re-run setup.
    • ${bold('node-gyp errors')} — shouldn't happen: nothing here compiles native code. If you see one, it's likely a stale ${cyan('node_modules')}. Delete it and re-run setup.
`)
  } else {
    console.log(`
    • ${bold('EACCES')} — node_modules ownership is wrong (often after a previous ${cyan('sudo')} install). Fix with: ${cyan('sudo chown -R $USER:$(id -gn) node_modules')}, then re-run setup ${red('without')} sudo.
    • ${bold('EROFS / read-only')} — the repo is on a read-only filesystem or directory. Move it somewhere writable and re-run.
    • ${bold('node-gyp')} — install build tools: ${cyan('xcode-select --install')} (macOS) or ${cyan('sudo apt install build-essential python3')} (Debian/Ubuntu).
    • ${bold('Network / proxy')} — set npm proxy: ${cyan('npm config set proxy http://your-proxy')}.
`)
  }
  console.log(`  Then re-run ${cyan('setup.bat')} (Windows) / ${cyan('bash setup.sh')} (POSIX), or ${cyan('npm install')} directly.`)
  console.log('')
}

async function npmInstall() {
  if (nodeModulesUpToDate()) {
    ok('node_modules already up to date — skipping npm install.')
    return true
  }
  info('Running npm install (this can take a minute or two)…')
  // --no-audit / --no-fund: keep real errors visible above the noise.
  const code = await runInherit('npm', ['install', '--no-audit', '--no-fund'])
  if (code === 0) {
    ok('npm install complete.')
    return true
  }
  fail('npm install failed.')
  printNpmInstallRemediation()
  return false
}


// ---------- Pre-flight checks ----------

/** Refuse to continue if we're running under sudo / as root on POSIX.
 *  A sudo install leaves node_modules root-owned and breaks every subsequent
 *  non-sudo `npm install` (including the in-app updater). Vault learned
 *  this the hard way; we surface it before any damage is done. */
function checkNotRoot() {
  if (PLATFORM === 'win32') return true
  const sudoed = process.env.SUDO_USER || (typeof process.geteuid === 'function' && process.geteuid() === 0)
  if (!sudoed) return true
  console.log('')
  fail(`Refusing to run as ${process.env.SUDO_USER ? 'sudo' : 'root'}.`)
  console.log(`
  ${yellow('Why:')} npm install under sudo leaves ${cyan('node_modules')} owned by root, which then
  breaks every later install / update you run as your own user (including the
  in-app updater). It's a footgun that has cost real time in sister projects.

  ${bold('Recover (if a previous sudo install corrupted ownership):')}
      ${cyan('sudo chown -R $USER:$(id -gn) .')}

  Then re-run this script ${red('without')} sudo:
      ${cyan('bash setup.sh')}
`)
  return false
}

/** Pre-flight write test: confirm the repo dir is actually writable before
 *  Node spends a minute on npm install only to die on the first EACCES. */
function checkRepoWritable() {
  const probe = join(REPO_ROOT, '.write-probe-' + Date.now())
  try {
    writeFileSync(probe, '')
    unlinkSync(probe)
    return true
  } catch (err) {
    console.log('')
    fail(`Repo directory is not writable: ${REPO_ROOT}`)
    console.log(`
  ${red('Reason:')} ${err.code ?? err.message}

  ${bold('Common causes:')}
    • Repo is in a write-protected location (Program Files, system path, network drive).
    • Folder is locked by an open editor or sync agent (OneDrive, Dropbox, antivirus).
    • You're running as a user that lacks write permission.

  ${bold('Fix:')} move the folder to a writable location (Documents, Desktop, home folder)
  and re-run setup.
`)
    return false
  }
}

// ---------- Orchestrator ----------

async function main() {
  console.log(bold(`\nTusk's Tomes — first-time setup`))
  console.log(dim(`Working directory: ${REPO_ROOT}`))
  console.log(dim(`Platform: ${PLATFORM}`))

  if (!checkNotRoot()) process.exit(1)
  if (!checkRepoWritable()) process.exit(1)

  header('1. System prerequisites')
  const nodeOk = checkNode()
  const gitOk = checkGit()
  checkGpu()

  // Python is only needed for the optional Whisper audio transcription sidecar.
  // Install Whisper from Settings → Whisper inside the running app instead.
  // faster-whisper requires Python 3.10, 3.11, or 3.12 — torch wheels for 3.13
  // either don't exist or are CUDA-restricted, so the venv build silently
  // falls back to broken installs. Validate the version here so a fresh user
  // who happens to have python 3.13 doesn't waste 5 minutes troubleshooting.
  const pyResult = run(PLATFORM === 'win32' ? 'python' : 'python3', ['--version'])
  if (pyResult.code === 0) {
    const versionMatch = pyResult.stdout.match(/Python\s+(\d+)\.(\d+)/i)
    if (versionMatch) {
      const major = Number(versionMatch[1])
      const minor = Number(versionMatch[2])
      if (major === 3 && minor >= 10 && minor <= 12) {
        info(
          `Python ${major}.${minor} detected — compatible with Whisper. Install the Audio ` +
            'Transcription add-on from Settings → Add-ons when you want it.',
        )
      } else if (major === 3 && minor >= 13) {
        // Deliberately says UNTESTED rather than "will fail". The original
        // blocker was that PyTorch shipped no cp313 wheels at all; torch 2.6+
        // and recent CTranslate2 releases now do, and requirements.txt
        // permits them. Nobody has verified the full stack on 3.13 here, so
        // the honest message is "we don't know", not "it's broken".
        warn(
          `Python ${major}.${minor} detected — 3.10–3.12 are the versions verified with Whisper. ` +
            '3.13+ is untested here: PyTorch had no 3.13 builds for a long while, which is where ' +
            'the restriction came from, and although upstream has since shipped them nobody has ' +
            'confirmed the whole stack on 3.13. Feel free to try it and report back. If the ' +
            'add-on install fails, put 3.12 alongside (winget install Python.Python.3.12 on ' +
            'Windows, pyenv install 3.12 elsewhere) and the Whisper setup picks it up.',
        )
      } else {
        warn(
          `Python ${major}.${minor} detected — Whisper requires Python 3.10, 3.11, or 3.12. ` +
            'Audio transcription will not work on this Python version. Install a compatible ' +
            'Python (winget install Python.Python.3.12 on Windows) before enabling the Audio ' +
            'Transcription add-on.',
        )
      }
    } else {
      info(
        `Python detected (${pyResult.stdout}) — could not parse version string. Whisper setup ` +
          'will retry the version check at install time.',
      )
    }
  } else {
    info(
      "Python not found — that's fine unless you need audio transcription. Install Python " +
        '3.10/3.11/3.12 later, then enable the Audio Transcription add-on from Settings → Add-ons.',
    )
  }

  if (PLATFORM === 'win32') {
    checkBuildToolsWindows()
  }

  if (!nodeOk || !gitOk) {
    console.log(`\n${red(bold('Some required tools are missing.'))} Install them, open a new terminal, and re-run this script.`)
    process.exit(1)
  }

  header('2. .env file')
  ensureEnv()

  header('3. Node dependencies')
  const installOk = await npmInstall()
  if (!installOk) process.exit(1)

  header('4. Done')
  console.log(`
  ${green('All set.')} Start the app:

      ${cyan('npm run dev')}

  Then open ${cyan('http://localhost:5173')} in your browser.

  Walkthrough:
    1. ${bold('Settings')}  — paste at least one API key (Gemini / Claude / OpenAI), or set up a local LLM.
    2. ${bold('Tome of Lore')} — drop your campaign PDFs / notes in, populate the glossary, list your players.
    3. ${bold('Chronicle')} — paste a session transcript and kick off the pipeline.
    4. ${bold('Settings → Add-ons')} — optional: install the Audio Transcription add-on if you want to upload Craig recordings or YouTube .sbv captions directly. Requires Python 3.10–3.12.

  ${dim('If something breaks, run `npm run smoke-test` for a quick health check.')}
`)
}

main().catch((err) => {
  console.error(`\n${red('Setup crashed:')} ${err.stack ?? err.message ?? err}`)
  process.exit(1)
})
