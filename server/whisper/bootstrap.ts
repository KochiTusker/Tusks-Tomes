// Whisper sidecar readiness check + scaffolding helpers.
//
// At runtime, the React app calls `/api/whisper/status` to decide whether
// to show a "Set up Whisper" prompt or proceed with transcription. Step 16
// adds `runSetup()`, which streams the platform setup script's stdout/stderr
// so the UI can show progress while the venv is created.

import { promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SERVER_ROOT = path.resolve(__dirname, '..')
const PROJECT_ROOT = path.resolve(SERVER_ROOT, '..')

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

export type WhisperStatus = {
  ready: boolean
  pythonPath: string
  venvPath: string
  scriptPath: string
  error?: string
}

export async function whisperStatus(): Promise<WhisperStatus> {
  const out: WhisperStatus = {
    ready: false,
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

  // Quick import check: spawn python -c "import faster_whisper". Cheap,
  // verifies the venv has the package installed.
  const ok = await new Promise<boolean>((resolve) => {
    const child = spawn(out.pythonPath, ['-c', 'import faster_whisper'])
    child.on('error', () => resolve(false))
    child.on('exit', (code) => resolve(code === 0))
  })
  if (!ok) {
    out.error = `faster-whisper not importable from ${out.pythonPath}. Run pip install -r scripts/whisper/requirements.txt inside the venv.`
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
