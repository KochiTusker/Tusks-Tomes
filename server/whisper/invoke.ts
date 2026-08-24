// Public Whisper transcription API. Two code paths:
//
//   - GPU (device='cuda', the default): routes through the persistent
//     Python worker in worker.ts. One Python process per server lifetime
//     handles every utterance, eliminating the cuDNN re-init crash that
//     plagued back-to-back one-shot spawns.
//
//   - CPU (device='cpu', usually the retry fallback in liveQueue.ts):
//     keeps the original one-shot `spawn` path. CPU calls are rare and
//     don't suffer from the re-init crash class, so the simpler
//     short-lived process is fine.
//
// Either path returns the same TranscribeResult, so callers don't need
// to care which one ran.

import { spawn } from 'node:child_process'
import { pythonBin, transcribeScript, whisperStatus } from './bootstrap.js'
import { getGpuWorker } from './worker.js'
import { isWhisperCppEnabled, whisperCppStatus } from '../api/whisperCpp.js'

export type Word = {
  startMs: number
  endMs: number
  text: string
  confidence: number | null
}

export type Segment = {
  startMs: number
  endMs: number
  text: string
  words: Word[]
  confidence: number | null
}

export type TranscribeResult = {
  speakerId: string
  speakerDisplay: string
  durationMs: number
  elapsedMs: number
  model: string
  device: string
  language: string
  segments: Segment[]
}

export type TranscribeOptions = {
  audio: string
  speakerId?: string
  speakerDisplay?: string
  initialPrompt?: string
  model?: string
  device?: 'cuda' | 'cpu'
  computeType?: string
  language?: string
  signal?: AbortSignal
}

export type TranscriptionEngine = 'faster-whisper' | 'whisper-cpp'

/**
 * Decide which transcription engine handles a request.
 *
 * Pure so the policy can be tested without an add-on, a binary or a model on
 * disk — this is the switch that determines what every upload runs through, so
 * "it silently kept using the old engine" needs to be a caught regression
 * rather than a support ticket.
 *
 * The rule is deliberately conservative: whisper.cpp is used ONLY when the
 * add-on is enabled AND the user has configured it AND both the binary and
 * model actually check out. A half-configured bridge falls back rather than
 * failing the run, because a user who is mid-setup should still be able to
 * transcribe.
 */
export function chooseEngine(input: {
  cppAddonLoaded: boolean
  cppConfigured: boolean
  cppBinaryOk: boolean
  cppModelOk: boolean
}): TranscriptionEngine {
  const usable = input.cppAddonLoaded && input.cppConfigured && input.cppBinaryOk && input.cppModelOk
  return usable ? 'whisper-cpp' : 'faster-whisper'
}

/** Resolve the engine against live add-on + config state. */
export async function activeEngine(): Promise<TranscriptionEngine> {
  // Cheap short-circuit: don't probe a binary that can't be in play anyway.
  // Checks the marker file rather than the add-on loader — importing the
  // loader here creates a circular import (see isWhisperCppEnabled).
  if (!(await isWhisperCppEnabled())) return 'faster-whisper'
  try {
    const s = await whisperCppStatus()
    return chooseEngine({
      cppAddonLoaded: true,
      cppConfigured: s.configured,
      cppBinaryOk: s.binaryOk,
      cppModelOk: s.modelOk,
    })
  } catch {
    // A broken bridge must never block transcription outright.
    return 'faster-whisper'
  }
}

export async function transcribeFile(opts: TranscribeOptions): Promise<TranscribeResult> {
  // Single dispatch point for every caller — liveQueue.ts calls this in three
  // places and needs no knowledge of which engine is active.
  if ((await activeEngine()) === 'whisper-cpp') {
    const { transcribeFileWithWhisperCpp } = await import('./invokeCpp.js')
    return transcribeFileWithWhisperCpp(opts)
  }

  const device = opts.device ?? 'cuda'
  const model = opts.model ?? 'large-v3'
  const computeType = opts.computeType ?? (device === 'cuda' ? 'int8_float16' : 'int8')
  // GPU: route through the persistent worker — one cuDNN init per server
  // lifetime instead of one per utterance.
  if (device === 'cuda') {
    const worker = getGpuWorker(model, computeType)
    return worker.transcribe({ ...opts, model, computeType, device })
  }

  // CPU: one-shot spawn (back-compat behaviour).
  const status = await whisperStatus()
  if (!status.ready) {
    throw new Error(status.error ?? 'Whisper sidecar is not ready.')
  }
  const args: string[] = [
    transcribeScript(),
    '--audio', opts.audio,
    '--model', model,
    '--device', device,
    '--compute-type', computeType,
    '--language', opts.language ?? 'en',
  ]
  if (opts.speakerId) args.push('--speaker-id', opts.speakerId)
  if (opts.speakerDisplay) args.push('--speaker-display', opts.speakerDisplay)
  if (opts.initialPrompt) args.push('--initial-prompt', opts.initialPrompt)

  return new Promise<TranscribeResult>((resolve, reject) => {
    const child = spawn(pythonBin(), args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    child.stdout.on('data', (b: Buffer) => stdoutChunks.push(b))
    child.stderr.on('data', (b: Buffer) => stderrChunks.push(b))

    const onAbort = () => {
      child.kill('SIGTERM')
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    child.on('error', (err) => {
      opts.signal?.removeEventListener('abort', onAbort)
      reject(err)
    })

    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort)
      if (opts.signal?.aborted) {
        return reject(new DOMException('Aborted', 'AbortError'))
      }
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString('utf8')
        return reject(new Error(`transcribe.py exited with code ${code}:\n${stderr}`))
      }
      const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim()
      if (!stdout) {
        return reject(new Error('transcribe.py produced no output'))
      }
      try {
        resolve(JSON.parse(stdout) as TranscribeResult)
      } catch (err) {
        reject(new Error(`Failed to parse transcribe.py output: ${(err as Error).message}`))
      }
    })
  })
}

/**
 * Build the ~200-token initial prompt that biases Whisper toward the
 * campaign vocabulary. Caller passes pre-deduplicated canonical names.
 * The actual token-count cap is approximated at chars/4 = ~800 chars.
 */
export function buildInitialPrompt(canonicalNames: string[]): string {
  const MAX_CHARS = 800
  const distinct = Array.from(new Set(canonicalNames.map((n) => n.trim()).filter(Boolean)))
  const out: string[] = []
  let chars = 0
  out.push('A campaign log featuring characters and places: ')
  chars += out[0].length
  for (const name of distinct) {
    const piece = chars === out[0].length ? name : `, ${name}`
    if (chars + piece.length > MAX_CHARS) break
    out.push(piece)
    chars += piece.length
  }
  out.push('.')
  return out.join('')
}
