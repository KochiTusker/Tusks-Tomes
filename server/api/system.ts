// Best-effort system info for the routing recommendation engine. RAM and CPU
// come from Node's `os` module. GPU VRAM is detected via `nvidia-smi` when
// available — if not, the client falls back to a user-supplied HardwareProfile
// from the legacy provider settings.

import express, { type Router } from 'express'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { claudeCodeStatus } from './claudeCode.js'
import { codexStatus } from './codex.js'
import { isAddonLoaded } from '../addons/loader.js'
import { loopbackOnly } from '../lib/loopbackGate.js'

export type PythonProbe = {
  /** A python executable answered `--version`. */
  found: boolean
  /** e.g. "3.12.4" — null when not found or unparseable. */
  version: string | null
  /** 3.10 ≤ version ≤ 3.12 — the range faster-whisper's torch wheels
   *  support. 3.13+ has no wheels; installs fail after the download. */
  supported: boolean
}

export type SystemInfo = {
  ramGb: number
  cpuCount: number
  cpuModel: string | null
  platform: NodeJS.Platform
  arch: string
  gpu: {
    detected: boolean
    name?: string
    vramGb?: number
    source: 'nvidia-smi' | null
    error?: string
  }
  python: PythonProbe
}

function nvidiaSmi(): Promise<{ name: string; vramGb: number } | { error: string } | null> {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let resolved = false
    const child = spawn(
      'nvidia-smi',
      ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    const finish = (value: { name: string; vramGb: number } | { error: string } | null) => {
      if (resolved) return
      resolved = true
      resolve(value)
    }
    child.stdout.on('data', (b: Buffer) => (out += b.toString('utf8')))
    child.stderr.on('data', (b: Buffer) => (err += b.toString('utf8')))
    child.on('error', () => finish(null)) // nvidia-smi missing entirely
    child.on('close', (code) => {
      if (code !== 0) {
        finish({ error: err.trim() || `nvidia-smi exited ${code}` })
        return
      }
      const line = out.trim().split(/\r?\n/)[0] ?? ''
      const parts = line.split(',').map((s) => s.trim())
      if (parts.length < 2) {
        finish({ error: 'unexpected nvidia-smi output' })
        return
      }
      const name = parts[0]
      const vramMb = parseInt(parts[1], 10)
      if (!Number.isFinite(vramMb)) {
        finish({ error: `could not parse VRAM from "${parts[1]}"` })
        return
      }
      finish({ name, vramGb: Math.round((vramMb / 1024) * 10) / 10 })
    })
    setTimeout(() => finish(null), 2500)
  })
}

/** Per-CLI detection result. `loaded` is the add-on mount state, which is
 *  distinct from `installed`: a CLI can be present on PATH while its add-on
 *  is not yet enabled, or enabled-but-not-yet-mounted pending a restart. */
export type CliProbe = {
  installed: boolean
  version: string | null
  authenticated: boolean
  /** Is the add-on's route surface mounted in THIS process? */
  loaded: boolean
}

export type CliDetect = {
  claudeCode: CliProbe
  codex: CliProbe
  /** True when a CLI is usable but its add-on isn't mounted yet, i.e. the
   *  user must restart before the pipeline can actually route to it. */
  restartRequired: boolean
}

/** Try one python launcher; resolve its version string or null. */
function pythonVersion(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let out = ''
    let resolved = false
    const finish = (v: string | null) => {
      if (!resolved) {
        resolved = true
        resolve(v)
      }
    }
    try {
      const child = spawn(cmd, [...args, '--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
      // Some pythons print the version on stderr; accept either.
      child.stdout.on('data', (b: Buffer) => (out += b.toString('utf8')))
      child.stderr.on('data', (b: Buffer) => (out += b.toString('utf8')))
      child.on('error', () => finish(null))
      child.on('close', () => {
        const m = out.match(/Python\s+(\d+\.\d+\.\d+)/)
        finish(m ? m[1] : null)
      })
      setTimeout(() => finish(null), 2500)
    } catch {
      finish(null)
    }
  })
}

/** Detect the Python the Whisper installer will actually use. Mirrors the
 *  setup scripts exactly — `python` on Windows (setup.ps1 runs
 *  `python -m venv` and errors if that alias is missing), `python3` then
 *  `python` on POSIX. Deliberately no `py` launcher probing: reporting a
 *  python the installer would not use would make this gate lie. */
export async function detectPython(): Promise<PythonProbe> {
  const candidates: Array<[string, string[]]> =
    process.platform === 'win32'
      ? [['python', []]]
      : [
          ['python3', []],
          ['python', []],
        ]
  for (const [cmd, args] of candidates) {
    const version = await pythonVersion(cmd, args)
    if (version) {
      const [major, minor] = version.split('.').map((n) => parseInt(n, 10))
      const supported = major === 3 && minor >= 10 && minor <= 12
      return { found: true, version, supported }
    }
  }
  return { found: false, version: null, supported: false }
}

export function systemRouter(): Router {
  const router = express.Router()

  /**
   * Subscription-CLI detection for the Recommended Setup wizard.
   *
   * This lives on systemRouter — which is mounted unconditionally at startup —
   * rather than on the add-ons' own routers, which are only mounted by
   * addon.registerRoutes() once the add-on is enabled AND the server has been
   * restarted (see addons/loader.ts). Without this endpoint the wizard would
   * have to ask "do you have a Claude Code subscription?" from a page with no
   * way to check, and could never answer it for a first-time user.
   *
   * loopbackOnly: this spawns `claude --version` / `codex --version` on the
   * host. Same rule as the /generate routes — LAN visitors must not be able
   * to trigger process creation.
   */
  router.get('/cli-detect', loopbackOnly(), async (_req, res) => {
    try {
      const [cc, cx] = await Promise.all([claudeCodeStatus(true), codexStatus(true)])
      const claudeCode: CliProbe = {
        installed: cc.installed,
        version: cc.version,
        authenticated: cc.authenticated,
        loaded: isAddonLoaded('claude-code-addon'),
      }
      const codex: CliProbe = {
        installed: cx.installed,
        version: cx.version,
        authenticated: cx.authenticated,
        loaded: isAddonLoaded('codex-addon'),
      }
      const usableButUnmounted = (p: CliProbe) => p.installed && p.authenticated && !p.loaded
      res.json({
        claudeCode,
        codex,
        restartRequired: usableButUnmounted(claudeCode) || usableButUnmounted(codex),
      } satisfies CliDetect)
    } catch (err) {
      console.error('[system/cli-detect] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.get('/info', async (_req, res) => {
    const cpus = os.cpus()
    const info: SystemInfo = {
      ramGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
      cpuCount: cpus.length,
      cpuModel: cpus[0]?.model ?? null,
      platform: os.platform(),
      arch: os.arch(),
      gpu: { detected: false, source: null },
      python: await detectPython(),
    }
    const gpu = await nvidiaSmi()
    if (gpu && 'vramGb' in gpu) {
      info.gpu = { detected: true, name: gpu.name, vramGb: gpu.vramGb, source: 'nvidia-smi' }
    } else if (gpu && 'error' in gpu) {
      info.gpu = { detected: false, source: 'nvidia-smi', error: gpu.error }
    }
    res.json(info)
  })

  return router
}
