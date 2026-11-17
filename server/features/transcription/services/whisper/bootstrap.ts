// Whisper sidecar readiness check + scaffolding helpers.
//
// At runtime, the React app calls `/api/whisper/status` to decide whether
// to show a "Set up Whisper" prompt or proceed with transcription. Step 16
// adds `runSetup()`, which streams the platform setup script's stdout/stderr
// so the UI can show progress while the venv is created.
//
// Two questions live here and they are deliberately separate:
//
//   whisperInstalled()  — is the venv on disk? Filesystem facts only, a few
//                         stat calls. This is what server start-up asks,
//                         because start-up must never wait on a child
//                         process it does not control.
//   whisperStatus()     — does the venv actually work? Spawns Python to
//                         import faster-whisper. Asked at request time by
//                         the status endpoint and before each transcription,
//                         where a slow answer costs one request, not the
//                         whole app.

import { promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { repoRoot } from '../../../../platform/repoRoot.js'

const PROJECT_ROOT = repoRoot()

/** How long the import probe may take before it is killed and reported as
 *  not ready. A healthy venv answers in about a second; a Python that
 *  hangs (a broken CUDA runtime, a locked DLL, an antivirus scan of a
 *  fresh venv) would otherwise hold the caller for as long as it likes. */
export const IMPORT_PROBE_TIMEOUT_MS = 10_000

export function venvDir(): string {
  return path.join(PROJECT_ROOT, 'vendor', 'python-venv')
}

export function pythonBin(): string {
  // Windows: .venv\Scripts\python.exe; POSIX: .venv/bin/python.
  const isWin = process.platform === 'win32'
  return isWin
    ? path.join(venvDir(), 'Scripts', 'python.exe')
    : path.join(venvDir(), 'bin', 'python')
}

export function transcribeScript(): string {
  return path.join(PROJECT_ROOT, 'scripts', 'whisper', 'transcribe.py')
}

export type WhisperInstall = {
  /** True when the venv's Python and the transcribe script both exist. */
  installed: boolean
  pythonPath: string
  venvPath: string
  scriptPath: string
  error?: string
}

export type WhisperStatus = {
  ready: boolean
  pythonPath: string
  venvPath: string
  scriptPath: string
  error?: string
}

/** Filesystem-only check: is the sidecar on disk? Never spawns anything,
 *  so it is safe to call from server start-up. */
export async function whisperInstalled(): Promise<WhisperInstall> {
  const out: WhisperInstall = {
    installed: false,
    pythonPath: pythonBin(),
    venvPath: venvDir(),
    scriptPath: transcribeScript(),
  }
  try {
    await fs.access(out.pythonPath)
  } catch {
    out.error = `Python venv not found at ${out.venvPath}. Install the Audio Transcription add-on from Settings → Add-ons (one-click, ~5-15 min), or run \`npm run whisper:setup\` from the repo root if you prefer the CLI.`
    return out
  }
  try {
    await fs.access(out.scriptPath)
  } catch {
    out.error = `transcribe.py missing at ${out.scriptPath}.`
    return out
  }
  out.installed = true
  return out
}

export type ProbeResult = {
  ok: boolean
  /** True when the child was killed for overrunning the timeout. */
  timedOut: boolean
  error?: string
}

/** Run a command and report whether it exited 0 within the timeout. The
 *  child is killed when the timeout passes, so the caller always gets an
 *  answer; a child that ignores the kill is left to the OS. */
export function runProbe(command: string, args: string[], timeoutMs: number): Promise<ProbeResult> {
  return new Promise<ProbeResult>((resolve) => {
    let settled = false
    const done = (result: ProbeResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, { stdio: 'ignore', windowsHide: true })
    } catch (err) {
      done({ ok: false, timedOut: false, error: (err as Error).message })
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // Already gone; the close event will settle the promise.
      }
      done({
        ok: false,
        timedOut: true,
        error: `did not finish within ${Math.round(timeoutMs / 1000)}s and was stopped`,
      })
    }, timeoutMs)
    child.on('error', (err) => done({ ok: false, timedOut: false, error: err.message }))
    child.on('close', (code) =>
      done(code === 0 ? { ok: true, timedOut: false } : { ok: false, timedOut: false, error: `exited with code ${code}` }),
    )
  })
}

/** Full check: on disk AND faster-whisper imports. Spawns Python, bounded
 *  by IMPORT_PROBE_TIMEOUT_MS. */
export async function whisperStatus(): Promise<WhisperStatus> {
  const install = await whisperInstalled()
  const out: WhisperStatus = {
    ready: false,
    pythonPath: install.pythonPath,
    venvPath: install.venvPath,
    scriptPath: install.scriptPath,
  }
  if (!install.installed) {
    out.error = install.error
    return out
  }

  // Quick import check: spawn python -c "import faster_whisper". Cheap
  // when the venv is healthy; capped so a hung interpreter cannot hold
  // the request.
  const probe = await runProbe(out.pythonPath, ['-c', 'import faster_whisper'], IMPORT_PROBE_TIMEOUT_MS)
  if (!probe.ok) {
    out.error = probe.timedOut
      ? `The faster-whisper import check ${probe.error}. The venv at ${out.venvPath} may be damaged or blocked; re-run the Audio Transcription install from Settings → Transcription.`
      : `faster-whisper not importable from ${out.pythonPath} (${probe.error ?? 'unknown failure'}). Run pip install -r scripts/whisper/requirements.txt inside the venv.`
    return out
  }

  out.ready = true
  return out
}

export type SetupLogLine = { stream: 'stdout' | 'stderr'; line: string }

/**
 * Invoke the platform-appropriate setup script and stream log lines via a
 * callback. Resolves with the exit code once the child terminates.
 */
export async function runSetup(onLine: (entry: SetupLogLine) => void): Promise<number> {
  const isWin = process.platform === 'win32'
  const scriptDir = path.join(PROJECT_ROOT, 'scripts', 'whisper')
  const ps1 = path.join(scriptDir, 'setup.ps1')
  const sh = path.join(scriptDir, 'setup.sh')
  let command: string
  let args: string[]
  if (isWin) {
    command = 'powershell'
    args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1]
  } else {
    command = 'bash'
    args = [sh]
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: PROJECT_ROOT })
    function emit(stream: 'stdout' | 'stderr', buf: Buffer) {
      const text = buf.toString('utf8')
      for (const line of text.split(/\r?\n/)) {
        if (line) onLine({ stream, line })
      }
    }
    child.stdout.on('data', (b: Buffer) => emit('stdout', b))
    child.stderr.on('data', (b: Buffer) => emit('stderr', b))
    child.on('error', reject)
    child.on('close', (code) => resolve(code ?? -1))
  })
}
