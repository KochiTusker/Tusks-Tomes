// Transcribe through a user-supplied whisper.cpp build.
//
// The contract this MUST satisfy is `TranscribeResult` from invoke.ts — the
// same object the faster-whisper sidecar returns. Everything downstream
// (liveQueue's silence-gap segmentation, the speaker-mapping table, the
// Sessions tab, the transcript export) consumes that shape and knows nothing
// about engines. Get the shape right and the whole UI works unchanged; get it
// wrong and it fails in confusing places far from here.
//
// The division of responsibility for this add-on:
//   THE USER owns the binary, the model, and whether their build has a GPU
//   backend compiled in. We can't install, sign, or verify any of that.
//   WE own everything in this file: correct arguments, a safe spawn, parsing
//   the output into the shared contract, and turning failures into messages
//   that say what to do next. That's what the tests cover.

import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { readWhisperCppConfig, whisperCppStatus } from '../api/whisperCpp.js'
import { parseWhisperCppJson } from './whisperCppFormat.js'
import type { TranscribeOptions, TranscribeResult } from './invoke.js'

/**
 * Build the argument list for a transcription run.
 *
 * Exported so tests can assert the flags without spawning anything — the
 * arguments are the part most likely to drift and least likely to be noticed,
 * because a wrong flag usually still produces *a* transcript.
 *
 * Notable choices:
 *   --output-json-full  token-level data, which is where word timings come
 *                       from. Plain --output-json omits tokens and would
 *                       silently degrade liveQueue's segmentation.
 *   --no-context        matches condition_on_previous_text=False in the
 *                       faster-whisper sidecar. Without it, whisper.cpp
 *                       carries context across segments and is far more prone
 *                       to looping on repeated phrases.
 *   --no-prints         keeps progress chatter off stdout.
 */
export function buildWhisperCppArgs(opts: {
  binaryPath: string
  modelPath: string
  audioPath: string
  outputBase: string
  language?: string
  initialPrompt?: string
  threads?: number
}): string[] {
  const args = [
    '--model', opts.modelPath,
    '--file', opts.audioPath,
    '--output-json-full',
    '--output-file', opts.outputBase,
    '--no-context',
    '--no-prints',
  ]
  // whisper.cpp uses "auto" for detection; the sidecar's default is also auto.
  args.push('--language', opts.language && opts.language !== 'auto' ? opts.language : 'auto')
  if (opts.initialPrompt?.trim()) args.push('--prompt', opts.initialPrompt.trim())
  if (opts.threads && Number.isFinite(opts.threads)) args.push('--threads', String(opts.threads))
  return args
}

/** Turn whisper.cpp's failure modes into something a user can act on. */
export function explainFailure(exitCode: number | null, output: string): string {
  const text = output.toLowerCase()
  if (/failed to load model|invalid model|unable to load model/.test(text)) {
    return 'whisper.cpp could not load the model file. Check the path points at a real GGML .bin (a Git-LFS pointer is the usual culprit).'
  }
  if (/no such file|cannot open|failed to open/.test(text)) {
    return 'whisper.cpp could not open the audio file. It may have been moved, or be in a format this build lacks support for.'
  }
  if (/out of memory|vk::deviceoutofmemory|failed to allocate/.test(text)) {
    return 'Your GPU ran out of memory. Try a smaller model (medium or small) — large-v3 needs several gigabytes of VRAM.'
  }
  if (/vulkan|device lost/.test(text) && /error|fail/.test(text)) {
    return 'The Vulkan device failed during transcription. This usually means a graphics-driver problem; updating your GPU drivers is the first thing to try.'
  }
  return `whisper.cpp exited with code ${exitCode ?? 'unknown'}. Last output: ${output.trim().slice(-400) || '(none)'}`
}

/**
 * Run one file through whisper.cpp and return it in the shared contract.
 *
 * whisper.cpp writes its JSON to `<output-file>.json` rather than stdout, so
 * we hand it a path inside the OS temp directory and read the file back. The
 * temp file is always cleaned up, including on failure.
 */
export async function transcribeFileWithWhisperCpp(opts: TranscribeOptions): Promise<TranscribeResult> {
  const status = await whisperCppStatus()
  if (!status.configured) {
    throw new Error('whisper.cpp bridge is not configured — set the binary and model paths in Settings.')
  }
  if (!status.binaryOk) throw new Error(status.summary)
  if (!status.modelOk) throw new Error(status.summary)

  const cfg = await readWhisperCppConfig()
  const startedAt = Date.now()
  const outputBase = path.join(os.tmpdir(), `tusks-whispercpp-${randomBytes(8).toString('hex')}`)
  const jsonPath = `${outputBase}.json`

  const args = buildWhisperCppArgs({
    binaryPath: cfg.binaryPath,
    modelPath: cfg.modelPath,
    audioPath: opts.audio,
    outputBase,
    language: opts.language,
    initialPrompt: opts.initialPrompt,
  })

  try {
    const { code, output } = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      let child
      try {
        // shell:false with an absolute binary path. The model and audio paths
        // are user-controlled strings; passed as argv entries they are never
        // interpreted by a shell, so spaces and metacharacters are safe.
        child = spawn(cfg.binaryPath, args, {
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          // Neutral cwd, same rule as the Codex/Claude Code providers: a
          // transcription binary has no business resolving relative paths
          // against the project tree.
          cwd: os.tmpdir(),
        })
      } catch (err) {
        return reject(new Error(`Could not start whisper.cpp: ${(err as Error).message}`))
      }
      let out = ''
      const onAbort = () => {
        try {
          child.kill()
        } catch {
          /* already gone */
        }
      }
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      child.stdout?.on('data', (b: Buffer) => (out += b.toString('utf8')))
      child.stderr?.on('data', (b: Buffer) => (out += b.toString('utf8')))
      child.on('error', (err) => {
        opts.signal?.removeEventListener('abort', onAbort)
        reject(new Error(`Could not start whisper.cpp: ${err.message}`))
      })
      child.on('close', (c) => {
        opts.signal?.removeEventListener('abort', onAbort)
        resolve({ code: c, output: out })
      })
    })

    let raw: string
    try {
      raw = await fs.readFile(jsonPath, 'utf8')
    } catch {
      // No output file means the run failed, whatever the exit code claimed.
      throw new Error(explainFailure(code, output))
    }
    if (code !== 0 && !raw.trim()) throw new Error(explainFailure(code, output))

    const parsed = parseWhisperCppJson(raw)
    const backends = status.backends
    const device = backends?.cpuOnly
      ? 'cpu'
      : [backends?.vulkan && 'vulkan', backends?.cuda && 'cuda', backends?.metal && 'metal']
          .filter(Boolean)
          .join('+') || 'cpu'

    return {
      speakerId: opts.speakerId ?? 'speaker',
      speakerDisplay: opts.speakerDisplay ?? opts.speakerId ?? 'Speaker',
      durationMs: parsed.durationMs,
      elapsedMs: Date.now() - startedAt,
      model: path.basename(cfg.modelPath),
      device,
      language: parsed.language ?? opts.language ?? 'auto',
      segments: parsed.segments,
    }
  } finally {
    await fs.rm(jsonPath, { force: true }).catch(() => undefined)
  }
}
