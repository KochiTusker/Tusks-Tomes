// Bridge to a user-supplied whisper.cpp build.
//
// WHY A BRIDGE RATHER THAN A BUNDLED ENGINE.
//
// GPU transcription on AMD / Intel needs whisper.cpp compiled with Vulkan, and
// there is no such release binary — the project's own releases ship CPU, BLAS
// (still CPU) and CUDA only. Shipping our own build would make this project a
// binary publisher, with the signing, checksum and platform-gatekeeper burden
// that implies, for software we cannot test on the hardware it targets.
//
// So the arrangement is the same one the Claude Code and Codex add-ons already
// use: the user installs the tool, and we bridge to it. They own the binary and
// its provenance; we own the integration, the validation, and telling them
// clearly when their build won't do what they hoped.
//
// The most useful thing here is NOT the transcription — it's `backends`. Anyone
// who downloads an official whisper.cpp release expecting AMD acceleration gets
// a CPU-only build and no indication why it's slow. Reading the binary's own
// system_info line lets the UI say so directly.

import express, { type Express, type Router } from 'express'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configDir, readJson, writeJson } from '../../../platform/appData.js'
import { loopbackOnly } from '../../../platform/loopbackGate.js'
import { parseBackends, type WhisperCppBackends } from '../services/whisper/whisperCppFormat.js'
import { asyncRoute } from '../../../platform/asyncRoute.js'

export type WhisperCppConfig = {
  /** Absolute path to the whisper-cli / main executable. */
  binaryPath: string
  /** Absolute path to a GGML/GGUF model file. */
  modelPath: string
}

export type WhisperCppStatus = {
  configured: boolean
  binaryPath: string | null
  modelPath: string | null
  /** Did the binary run and report a version? */
  binaryOk: boolean
  version: string | null
  /** Does the model file exist and look plausible? */
  modelOk: boolean
  modelSizeMb: number | null
  backends: WhisperCppBackends | null
  /** Plain-language summary for the UI. */
  summary: string
  error?: string
}

export function whisperCppConfigPath(): string {
  return path.join(configDir(), 'whisper-cpp.json')
}

export async function readWhisperCppConfig(): Promise<WhisperCppConfig> {
  const cfg = await readJson<Partial<WhisperCppConfig>>(whisperCppConfigPath(), {})
  return {
    binaryPath: typeof cfg.binaryPath === 'string' ? cfg.binaryPath : '',
    modelPath: typeof cfg.modelPath === 'string' ? cfg.modelPath : '',
  }
}

/** Model files smaller than this are almost certainly a Git-LFS pointer or a
 *  truncated download rather than real weights — the tiny model is ~75 MB. */
const MIN_MODEL_BYTES = 20 * 1024 * 1024

/**
 * Run the binary to learn its version and, crucially, which backends it was
 * compiled with.
 *
 * whisper.cpp prints its `system_info:` line to stderr on a normal run. There
 * is no dedicated "print capabilities" flag, so we invoke `--help`, which is
 * cheap, touches no audio, and on current builds still emits the banner. If it
 * doesn't, we fall back to reporting "unknown" rather than guessing.
 */
function probeBinary(binaryPath: string): Promise<{ ok: boolean; version: string | null; systeminfo: string; error?: string }> {
  return new Promise((resolve) => {
    let child
    try {
      // shell:false and an absolute path: the binary location is user-supplied
      // config, so it must never be concatenated into a shell string.
      child = spawn(binaryPath, ['--help'], {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Neutral cwd — same rule as the Codex/Claude Code providers. A
        // transcription binary has no business resolving relative paths
        // against the project tree.
        cwd: os.tmpdir(),
      })
    } catch (err) {
      return resolve({ ok: false, version: null, systeminfo: '', error: (err as Error).message })
    }
    let out = ''
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      resolve({ ok: false, version: null, systeminfo: '', error: 'timed out after 8s' })
    }, 8_000)
    child.stdout?.on('data', (b: Buffer) => (out += b.toString('utf8')))
    child.stderr?.on('data', (b: Buffer) => (out += b.toString('utf8')))
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ ok: false, version: null, systeminfo: '', error: err.message })
    })
    child.on('close', () => {
      clearTimeout(timer)
      const systeminfo = out.split(/\r?\n/).find((l) => /system_info|WHISPER\s*:/i.test(l)) ?? ''
      const version = out.match(/whisper\.cpp[^\n]*?v?(\d+\.\d+\.\d+)/i)?.[1] ?? null
      // `--help` exits non-zero on some builds; presence of usage text is the
      // real signal that we ran a whisper.cpp binary.
      const looksRight = /whisper/i.test(out) && /usage|--model|-m\b/i.test(out)
      resolve({ ok: looksRight, version, systeminfo })
    })
  })
}

function summarise(s: Omit<WhisperCppStatus, 'summary'>): string {
  if (!s.configured) return 'Not set up yet — point this at your whisper.cpp binary and a model file.'
  if (!s.binaryOk) return `That binary didn't run. ${s.error ?? 'Check the path is correct and the file is executable.'}`
  if (!s.modelOk) return 'The binary works, but the model file is missing or too small to be real weights.'
  const b = s.backends
  if (!b) return 'Ready. Could not determine which backends this build has.'
  if (b.cpuOnly) {
    return (
      'Ready, but this is a CPU-only build — it will not use your graphics card. ' +
      'Official whisper.cpp releases are built without a GPU backend; you need one ' +
      'compiled with Vulkan (or CUDA/Metal) for acceleration.'
    )
  }
  const active = [
    b.vulkan && 'Vulkan',
    b.cuda && 'CUDA',
    b.metal && 'Metal',
    b.coreml && 'CoreML',
    b.openvino && 'OpenVINO',
  ].filter(Boolean)
  return `Ready, with GPU acceleration via ${active.join(' + ')}.`
}

export async function whisperCppStatus(): Promise<WhisperCppStatus> {
  const cfg = await readWhisperCppConfig()
  const configured = Boolean(cfg.binaryPath && cfg.modelPath)
  const base: Omit<WhisperCppStatus, 'summary'> = {
    configured,
    binaryPath: cfg.binaryPath || null,
    modelPath: cfg.modelPath || null,
    binaryOk: false,
    version: null,
    modelOk: false,
    modelSizeMb: null,
    backends: null,
  }
  if (!configured) return { ...base, summary: summarise(base) }

  const probe = await probeBinary(cfg.binaryPath)
  base.binaryOk = probe.ok
  base.version = probe.version
  base.backends = probe.ok ? parseBackends(probe.systeminfo) : null
  if (probe.error) base.error = probe.error

  try {
    const stat = await fs.stat(cfg.modelPath)
    base.modelSizeMb = Math.round(stat.size / (1024 * 1024))
    base.modelOk = stat.isFile() && stat.size >= MIN_MODEL_BYTES
  } catch {
    base.modelOk = false
  }

  return { ...base, summary: summarise(base) }
}

export function whisperCppRouter(): Router {
  const router = express.Router()

  // loopbackOnly: probing spawns a user-nominated executable on the host.
  router.get('/status', loopbackOnly(), asyncRoute('whisper-cpp/status', async (_req, res) => {
    res.json(await whisperCppStatus())
  }))

  router.post('/config', loopbackOnly(), asyncRoute('whisper-cpp/config', async (req, res) => {
    const body = (req.body ?? {}) as Partial<WhisperCppConfig>
    const binaryPath = typeof body.binaryPath === 'string' ? body.binaryPath.trim() : ''
    const modelPath = typeof body.modelPath === 'string' ? body.modelPath.trim() : ''

    // Absolute paths only. A relative path would resolve against whatever
    // cwd the server happens to have, which is neither predictable nor
    // something a user can reason about.
    for (const [label, p] of [
      ['binaryPath', binaryPath],
      ['modelPath', modelPath],
    ] as const) {
      if (p && !path.isAbsolute(p)) {
        return res.status(400).json({ error: `${label} must be an absolute path.` })
      }
    }
    await writeJson(whisperCppConfigPath(), { binaryPath, modelPath })
    // The dispatcher caches the probe for a while so a drain of many
    // utterances checks the binary once; a path just saved here must be
    // seen by the next transcription, not by the one after the cache lapses.
    // Imported lazily: the dispatcher imports this module for the probe.
    const { invalidateWhisperCppStatus } = await import('../services/whisper/invoke.js')
    invalidateWhisperCppStatus()
    res.json({ ok: true, ...(await whisperCppStatus()) })
  }))

  return router
}

/** Mounts the whisper.cpp bridge routes. */
export function registerWhisperCppRoutes(app: Express): void {
  app.use('/api/whisper-cpp', whisperCppRouter())
}
