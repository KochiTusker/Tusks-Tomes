// Public Whisper transcription API.
//
// Every caller goes through `transcribeFile()`, which picks an engine and a
// device and hides both:
//
//   - whisper.cpp — the bridge for AMD / Intel / Apple GPUs — whenever the
//     user has configured it and both the binary and the model check out.
//     See invokeCpp.ts. There is no switch to flip and no marker file: a
//     bridge that is set up and working is a bridge the user wants used.
//
//   - faster-whisper otherwise, through a persistent Python worker per device
//     (worker.ts). One process handles every utterance for the server's
//     lifetime: the model loads once, and there is no per-utterance CUDA +
//     cuDNN re-initialisation to crash. The CPU worker is persistent for the
//     same reason. It is the retry fallback in liveQueue.ts, and a fallback
//     that reloads a 3 GB model for every utterance it catches is slower than
//     the failure it is covering for.
//
// Either path returns the same TranscribeResult, so callers need not care
// which one ran. `device` on that result is the device the model actually
// loaded on, which is not always the one that was asked for.

import { whisperCppStatus, type WhisperCppStatus } from '../../routes/whisperCpp.js'
import { getCpuWorker, getGpuWorker, recordEngineInfo } from './worker.js'

export { getEngineInfo, isCudaClassError, resetGpuWorker, shutdownWhisperWorkers } from './worker.js'

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
  /** The device the model actually ran on — `cpu` when a CUDA request fell
   *  back, whatever the caller asked for. */
  device: string
  language: string
  segments: Segment[]
}

export type TranscribeProgress = { processedMs: number; durationMs: number }

/** What a request is waiting on. `loading_model` covers both a cold worker
 *  spawn and a queue behind one; `transcribing` means the audio is with the
 *  engine. */
export type TranscribeStage = 'loading_model' | 'transcribing'

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
  /** At most once a second while the engine works through the audio. Only
   *  the faster-whisper sidecar reports progress; whisper.cpp runs silent. */
  onProgress?: (p: TranscribeProgress) => void
  onStatus?: (stage: TranscribeStage) => void
}

export type TranscriptionEngine = 'faster-whisper' | 'whisper-cpp'

/** What the most recent transcription actually ran on. `fallback` is true
 *  when the device differs from the one requested — the sign that a CUDA
 *  install is quietly running on the CPU. */
export type EngineInfo = {
  name: TranscriptionEngine
  model: string
  device: string
  computeType: string
  fallback: boolean
  versions?: Record<string, string>
  cudaDevices?: number
}

/**
 * Decide which transcription engine handles a request.
 *
 * Pure so the policy can be tested without an add-on, a binary or a model on
 * disk — this is the switch that determines what every upload runs through, so
 * "it silently kept using the old engine" needs to be a caught regression
 * rather than a support ticket.
 *
 * The rule is deliberately conservative: whisper.cpp is used ONLY when the
 * add-on is mounted AND the user has configured it AND both the binary and
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

/**
 * How long one whisper.cpp probe stays good for.
 *
 * Probing means spawning the user's binary. A session drain hands the queue
 * hundreds of utterances back to back; probing for each would run the binary
 * hundreds of times to learn the same answer, and on a machine that is also
 * transcribing that is not free. Thirty seconds is short enough that a path
 * changed in Settings is picked up within the same sitting.
 */
const CPP_STATUS_TTL_MS = 30_000

let cppStatusCache: { at: number; status: WhisperCppStatus } | undefined
let cppStatusInFlight: Promise<WhisperCppStatus> | undefined

async function cachedWhisperCppStatus(): Promise<WhisperCppStatus> {
  if (cppStatusCache && Date.now() - cppStatusCache.at < CPP_STATUS_TTL_MS) {
    return cppStatusCache.status
  }
  // Coalesce concurrent callers onto one probe; a failed probe is not cached,
  // so the next request tries again rather than remembering a transient fault.
  if (!cppStatusInFlight) {
    cppStatusInFlight = whisperCppStatus()
      .then((status) => {
        cppStatusCache = { at: Date.now(), status }
        return status
      })
      .finally(() => {
        cppStatusInFlight = undefined
      })
  }
  return cppStatusInFlight
}

/** Forget the cached probe, so the next transcription re-reads the bridge's
 *  configuration straight away rather than after the TTL. */
export function invalidateWhisperCppStatus(): void {
  cppStatusCache = undefined
}

async function resolveEngine(): Promise<{ engine: TranscriptionEngine; cppStatus?: WhisperCppStatus }> {
  try {
    const s = await cachedWhisperCppStatus()
    const engine = chooseEngine({
      // The bridge is a builtin (server/addons/registry.ts): it mounts on
      // every install, so the only question is whether it is configured and
      // working. There is no loader state to consult.
      cppAddonLoaded: true,
      cppConfigured: s.configured,
      cppBinaryOk: s.binaryOk,
      cppModelOk: s.modelOk,
    })
    return { engine, cppStatus: s }
  } catch {
    // A broken bridge must never block transcription outright.
    return { engine: 'faster-whisper' }
  }
}

/** Resolve the engine against live bridge configuration. */
export async function activeEngine(): Promise<TranscriptionEngine> {
  return (await resolveEngine()).engine
}

/**
 * whisper.cpp has no compute-type flag: the precision is baked into the model
 * file, and the project's own naming puts it in the filename
 * (`ggml-large-v3-q5_0.bin`). A file without a quantisation suffix, which is
 * what the download script produces, is f16.
 */
function ggmlComputeType(modelFile: string): string {
  return modelFile.match(/-(q\d+_(?:\d+|k))\.(?:bin|gguf)$/i)?.[1].toLowerCase() ?? 'f16'
}

export async function transcribeFile(opts: TranscribeOptions): Promise<TranscribeResult> {
  // Single dispatch point for every caller — liveQueue.ts calls this in three
  // places and needs no knowledge of which engine is active.
  const { engine, cppStatus } = await resolveEngine()
  if (engine === 'whisper-cpp' && cppStatus) {
    const { transcribeFileWithWhisperCpp } = await import('./invokeCpp.js')
    const result = await transcribeFileWithWhisperCpp(opts, cppStatus)
    recordEngineInfo({
      name: 'whisper-cpp',
      model: result.model,
      device: result.device,
      computeType: ggmlComputeType(result.model),
      // The user chose this engine and the backend is whatever their build
      // has; there is no requested-versus-actual gap to report.
      fallback: false,
    })
    return result
  }

  const device = opts.device ?? 'cuda'
  const model = opts.model ?? 'large-v3'
  const computeType = opts.computeType ?? (device === 'cuda' ? 'int8_float16' : 'int8')
  const worker = device === 'cuda' ? getGpuWorker(model, computeType) : getCpuWorker(model, computeType)
  return worker.transcribe({ ...opts, model, computeType, device })
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
