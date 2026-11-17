// Persistent Python worker for Whisper transcription.
//
// Why this exists: a fresh Python subprocess per utterance re-initialises
// CUDA + cuDNN every time, and on Windows that occasionally crashes with
// STATUS_STACK_BUFFER_OVERRUN (exit code 3221226505 / 0xC0000409) inside
// cuDNN's auto-tuner. With ~250+ utterances per session, even a small
// per-spawn crash rate makes every long session bomb at least once.
//
// The fix is architectural: keep one Python process alive for the whole
// session, load the model once, and stream utterance requests over
// stdin/stdout as line-delimited JSON. No re-init = no re-init crash. As a
// free bonus, the model-load overhead (seconds on a GPU, far longer on a
// CPU, where the 3 GB model is decompressed into RAM) is paid once.
//
// Protocol — one JSON envelope per line on the sidecar's stdout:
//
//   {"kind":"loading","stage":"import"|"model"}        while it starts up
//   {"kind":"ready","device":..,"model":..,...}         once the model is up
//   {"kind":"progress","id":..,"processedMs":..,"durationMs":..}
//                                                       during a request
//   {"kind":"response","id":..,"ok":true,"result":..}   once per request
//   {"kind":"response","id":..,"ok":false,"error":..}
//
// Every field except `kind` is treated as optional on the way in, and an
// unknown kind is ignored. The sidecar and this file ship together, but the
// sidecar runs from a venv the user set up, which may predate this server
// (older sidecars emit only ready and response) — and a newer sidecar must
// be free to add envelopes without breaking a server that predates them.
//
// Concurrency: a single in-flight request at a time, serialised via a
// promise chain. faster-whisper itself isn't safe for concurrent
// transcribes against the same model, and a single GPU is the bottleneck
// anyway.
//
// Robustness:
//   - If the worker dies mid-request, the in-flight promise rejects with
//     the exit reason. The next `transcribe()` call lazily restarts the
//     worker — no auto-restart bookkeeping required.
//   - Each request gets an idle deadline (90 min without its position
//     advancing). If a request stalls, we kill the worker so the queue can
//     move on; one that keeps moving is never cut off for being long.
//   - Each request carries an id; mismatched responses are logged and
//     dropped rather than mis-routed.
//   - A request that fails with ok:false leaves the process alive, because
//     most failures are about the audio, not the process. The exception is
//     a CUDA-class error, after which the context is often poisoned and an
//     immediate retry lands in the same state: callers use
//     `isCudaClassError` to recognise one and `resetGpuWorker` to make the
//     next request spawn afresh.
//
// See server/features/transcription/services/whisper/invoke.ts for the public API; this file is
// intentionally not exported to consumers outside the whisper module.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { pythonBin, transcribeScript, whisperStatus } from './bootstrap.js'
import type {
  EngineInfo,
  TranscribeOptions,
  TranscribeProgress,
  TranscribeResult,
  TranscribeStage,
} from './invoke.js'

/**
 * How long a request may go without the sidecar reporting that it has moved
 * further through the audio. Armed when the request is sent and re-armed by
 * every progress line whose position has advanced, so a long track on a slow
 * CPU runs for as long as it keeps moving, while a worker that has stopped
 * moving is still caught. A sidecar that sends no progress at all is held to
 * it as a plain wall clock.
 */
const REQUEST_IDLE_TIMEOUT_MS = 90 * 60 * 1000

/**
 * How long to wait for the sidecar's FIRST line of stdout.
 *
 * Until something arrives we cannot tell a Python that is importing torch
 * from one that hung on a broken CUDA install, and two minutes is generous
 * for the former.
 */
const READY_TIMEOUT_MS = 120 * 1000

/**
 * The ready deadline once a `loading` line has arrived.
 *
 * A loading line proves the interpreter is up and the script is running, so
 * the wait is now for the model — and on first run that means downloading
 * ~3 GB from Hugging Face, which is minutes on a good connection and longer
 * on a poor one. Fifteen minutes covers that without waiting forever for a
 * process that has genuinely stalled; every further loading line resets it.
 */
const LOADING_TIMEOUT_MS = 15 * 60 * 1000

/** Grace after stdin EOF before SIGTERM, and after SIGTERM before SIGKILL. */
const SHUTDOWN_GRACE_MS = 500
const KILL_BACKSTOP_MS = 2000

type Envelope = { kind?: unknown; [key: string]: unknown }

type ReadyMessage = {
  kind: 'ready'
  device?: unknown
  model?: unknown
  computeType?: unknown
  versions?: unknown
  cudaDevices?: unknown
}

type ProgressMessage = {
  kind: 'progress'
  id?: unknown
  processedMs?: unknown
  durationMs?: unknown
}

type ResponseMessage =
  | { kind: 'response'; id?: unknown; ok: true; result: TranscribeResult }
  | { kind: 'response'; id?: unknown; ok: false; error?: unknown }

type Pending = {
  id: string
  resolve: (r: TranscribeResult) => void
  reject: (e: Error) => void
  /** The idle deadline; replaced each time the position advances. */
  timer: NodeJS.Timeout
  /** The process serving this request, killed if the deadline passes. */
  child: ChildProcessWithoutNullStreams
  /** Furthest position reported so far; only a move past it re-arms. */
  lastProcessedMs: number
  onProgress?: (p: TranscribeProgress) => void
}

/** Hooks the in-progress spawn registers so stdout can drive it. Inert once
 *  the start has settled, so a late loading line cannot re-arm a deadline
 *  against a worker that is already serving. */
type Startup = {
  onLoading: () => void
  onReady: (msg: ReadyMessage) => void
}

export type WhisperWorkerOptions = {
  /** Interpreter to run the sidecar with. Defaults to the venv's Python. */
  pythonBin?: string
  /** The sidecar script. Defaults to scripts/whisper/transcribe.py. */
  script?: string
  /** Skip the venv readiness probe before spawning. For tests driving a
   *  stand-in sidecar; production always probes, so that a missing venv
   *  reads as "install the add-on" rather than as a spawn failure. */
  skipStatusCheck?: boolean
  readyTimeoutMs?: number
  loadingTimeoutMs?: number
  /** Override REQUEST_IDLE_TIMEOUT_MS. For tests. */
  requestIdleTimeoutMs?: number
}

/** Call a caller-supplied listener without letting its failure become the
 *  transcription's. */
function notify<T>(fn: ((arg: T) => void) | undefined, arg: T): void {
  if (!fn) return
  try {
    fn(arg)
  } catch (err) {
    console.warn(`[whisper-worker] listener threw: ${(err as Error).message}`)
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

/** Keep only the string-valued entries: the sidecar reports null for a
 *  library it could not import (torch, cuda), which is absence, not a version. */
function asVersions(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object') return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string' && v) out[k] = v
  }
  return Object.keys(out).length ? out : undefined
}

export class WhisperWorker {
  private child?: ChildProcessWithoutNullStreams
  private ready = false
  private startingPromise?: Promise<void>
  private startup?: Startup
  private inFlight?: Pending
  private stdoutBuf = ''
  private bannerLogged = false
  private nextId = 1
  private engineInfo?: EngineInfo
  private readonly readyTimeoutMs: number
  private readonly loadingTimeoutMs: number
  private readonly requestIdleTimeoutMs: number
  // Serialise requests through a promise chain. `chain` always resolves
  // (we swallow its rejections) so the chain stays alive across a failed
  // call — the next request simply lazily restarts the worker.
  private chain: Promise<void> = Promise.resolve()

  constructor(
    private readonly device: 'cuda' | 'cpu',
    private readonly modelId: string,
    private readonly computeType: string,
    private readonly options: WhisperWorkerOptions = {},
  ) {
    this.readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS
    this.loadingTimeoutMs = options.loadingTimeoutMs ?? LOADING_TIMEOUT_MS
    this.requestIdleTimeoutMs = options.requestIdleTimeoutMs ?? REQUEST_IDLE_TIMEOUT_MS
  }

  /** Queue an utterance for transcription. Returns the result once Whisper
   *  has finished. Rejects if the worker dies or the request times out. */
  transcribe(opts: TranscribeOptions): Promise<TranscribeResult> {
    let resolveOuter!: (r: TranscribeResult) => void
    let rejectOuter!: (e: Error) => void
    const outer = new Promise<TranscribeResult>((res, rej) => {
      resolveOuter = res
      rejectOuter = rej
    })
    this.chain = this.chain.then(async () => {
      try {
        const result = await this.execute(opts)
        resolveOuter(result)
      } catch (err) {
        rejectOuter(err as Error)
      }
    })
    return outer
  }

  /** What this worker's sidecar reported loading, once it has. */
  engine(): EngineInfo | undefined {
    return this.engineInfo
  }

  /** Close stdin, wait briefly for graceful exit, force-kill if needed.
   *  Used from server shutdown paths and tests. */
  async shutdown(): Promise<void> {
    const child = this.child
    if (!child) return
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve()
      child.once('close', () => resolve())
    })
    try {
      child.stdin.end()
    } catch {
      // ignore — child may already be dead
    }
    // Python exits on stdin EOF within a few hundred ms; SIGTERM if it doesn't.
    const stillRunning = await Promise.race([
      exited.then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), SHUTDOWN_GRACE_MS)),
    ])
    if (stillRunning && this.child === child && !child.killed) {
      this.killChild(child)
    }
  }

  private isLive(): boolean {
    return this.ready && this.child !== undefined && !this.child.killed
  }

  private async execute(opts: TranscribeOptions): Promise<TranscribeResult> {
    // Either a cold spawn or a queue behind one in progress: from the
    // caller's side both are "waiting for the model".
    if (!this.isLive()) notify<TranscribeStage>(opts.onStatus, 'loading_model')
    await this.ensureStarted()
    const child = this.child
    if (!child) {
      throw new Error('Whisper worker failed to start')
    }
    return new Promise<TranscribeResult>((resolve, reject) => {
      const id = `req_${this.nextId++}`
      const pending: Pending = {
        id,
        resolve,
        reject,
        child,
        timer: this.idleDeadline(id, child),
        lastProcessedMs: -1,
        onProgress: opts.onProgress,
      }
      this.inFlight = pending
      const payload = JSON.stringify({
        id,
        audio: opts.audio,
        speakerId: opts.speakerId ?? '',
        speakerDisplay: opts.speakerDisplay ?? '',
        initialPrompt: opts.initialPrompt ?? '',
        language: opts.language ?? 'en',
      })
      try {
        child.stdin.write(payload + '\n')
      } catch (err) {
        clearTimeout(pending.timer)
        this.inFlight = undefined
        reject(err as Error)
        return
      }
      notify<TranscribeStage>(opts.onStatus, 'transcribing')
    })
  }

  /** Kill the child and fail request `id` if it is still in flight when the
   *  idle window passes. */
  private idleDeadline(id: string, child: ChildProcessWithoutNullStreams): NodeJS.Timeout {
    return setTimeout(() => {
      const pending = this.inFlight
      if (pending?.id !== id) return
      this.inFlight = undefined
      this.killChild(child)
      pending.reject(
        new Error(`Whisper request ${id} timed out: no progress for ${this.requestIdleTimeoutMs}ms`),
      )
    }, this.requestIdleTimeoutMs)
  }

  private async ensureStarted(): Promise<void> {
    if (this.isLive()) return
    if (this.startingPromise) return this.startingPromise

    if (!this.options.skipStatusCheck) {
      const status = await whisperStatus()
      if (!status.ready) {
        throw new Error(status.error ?? 'Whisper sidecar is not ready.')
      }
    }

    this.startingPromise = new Promise<void>((resolve, reject) => {
      const args = [
        this.options.script ?? transcribeScript(),
        '--serve',
        '--model', this.modelId,
        '--device', this.device,
        '--compute-type', this.computeType,
      ]
      const child = spawn(this.options.pythonBin ?? pythonBin(), args, { stdio: ['pipe', 'pipe', 'pipe'] })
      this.child = child
      this.stdoutBuf = ''
      this.ready = false
      this.bannerLogged = false

      let settled = false
      let deadline: NodeJS.Timeout | undefined
      const settle = (err?: Error) => {
        if (settled) return
        settled = true
        if (deadline) clearTimeout(deadline)
        if (err) {
          reject(err)
        } else {
          this.ready = true
          resolve()
        }
      }
      const arm = (ms: number, waitingFor: string) => {
        if (settled) return
        if (deadline) clearTimeout(deadline)
        deadline = setTimeout(() => {
          settle(new Error(`Whisper worker did not become ready within ${ms}ms (${waitingFor})`))
          this.killChild(child)
        }, ms)
      }

      arm(this.readyTimeoutMs, 'no output from the sidecar')
      this.startup = {
        onLoading: () => arm(this.loadingTimeoutMs, 'the sidecar is still loading the model'),
        onReady: (msg) => {
          this.recordReady(msg)
          settle()
        },
      }

      // Every handler checks it still belongs to the current process: a
      // process we gave up on can keep talking for a moment after a
      // replacement has been spawned, and must not drive the new one's state.
      child.stdout.on('data', (buf: Buffer) => {
        if (this.child === child) this.handleStdout(buf)
      })
      child.stderr.on('data', (buf: Buffer) => this.handleStderr(buf))
      child.on('error', (err) => {
        settle(err)
        if (this.child === child) this.failPending(err)
      })
      child.on('close', (code, signal) => {
        const err = new Error(`Whisper worker exited (code=${code}, signal=${signal ?? 'none'})`)
        settle(err)
        if (this.child !== child) return
        this.failPending(err)
        // Drop our reference so the next ensureStarted() spawns afresh.
        this.child = undefined
        this.ready = false
        this.startup = undefined
      })
    })

    try {
      await this.startingPromise
    } finally {
      this.startingPromise = undefined
    }
  }

  private handleStdout(buf: Buffer): void {
    this.stdoutBuf += buf.toString('utf8')
    while (true) {
      const nl = this.stdoutBuf.indexOf('\n')
      if (nl < 0) break
      const line = this.stdoutBuf.slice(0, nl).trim()
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1)
      if (!line) continue
      let msg: Envelope
      try {
        msg = JSON.parse(line) as Envelope
      } catch {
        process.stderr.write(`[whisper-worker] bad JSON on stdout: ${line.slice(0, 200)}\n`)
        continue
      }
      switch (msg.kind) {
        case 'loading':
          this.startup?.onLoading()
          break
        case 'ready':
          this.startup?.onReady(msg as ReadyMessage)
          break
        case 'progress':
          this.handleProgress(msg as ProgressMessage)
          break
        case 'response':
          this.handleResponse(msg as ResponseMessage)
          break
        default:
          // An envelope this server does not know. Ignored by design — see
          // the protocol note at the top of the file.
          break
      }
    }
  }

  private handleProgress(msg: ProgressMessage): void {
    const pending = this.inFlight
    if (!pending || pending.id !== msg.id) return
    const processedMs = Number(msg.processedMs)
    const durationMs = Number(msg.durationMs)
    if (!Number.isFinite(processedMs) || !Number.isFinite(durationMs)) return
    if (processedMs > pending.lastProcessedMs) {
      pending.lastProcessedMs = processedMs
      clearTimeout(pending.timer)
      pending.timer = this.idleDeadline(pending.id, pending.child)
    }
    notify(pending.onProgress, { processedMs, durationMs })
  }

  private handleResponse(msg: ResponseMessage): void {
    const pending = this.inFlight
    if (!pending || pending.id !== msg.id) {
      process.stderr.write(`[whisper-worker] response for unknown id ${String(msg.id)}\n`)
      return
    }
    clearTimeout(pending.timer)
    this.inFlight = undefined
    if (msg.ok) {
      // Each result re-publishes its engine, so `getEngineInfo()` names
      // whichever worker produced the latest transcription rather than
      // whichever one loaded last.
      if (this.engineInfo) recordEngineInfo(this.engineInfo)
      pending.resolve(msg.result)
    } else {
      pending.reject(new Error(asString(msg.error) ?? 'Whisper worker reported a failure without a message'))
    }
  }

  private handleStderr(buf: Buffer): void {
    // Forward Python stderr (model load logs, errors, traces) to our own
    // stderr with a tag so it's easy to spot in mixed server logs.
    process.stderr.write(`[whisper-worker] ${buf}`)
    if (this.bannerLogged) return
    // The load banner also goes through console.log once, so a log capture
    // that only follows stdout still records which model and device were
    // asked for.
    const banner = buf
      .toString('utf8')
      .split(/\r?\n/)
      .find((line) => line.startsWith('[worker] loading model='))
    if (banner) {
      this.bannerLogged = true
      console.log(`[whisper-worker] ${banner}`)
    }
  }

  private recordReady(msg: ReadyMessage): void {
    // A sidecar that predates these fields reports nothing beyond `kind`;
    // the requested values are then the best description available.
    const device = asString(msg.device) ?? this.device
    const versions = asVersions(msg.versions)
    const cudaDevices = typeof msg.cudaDevices === 'number' ? msg.cudaDevices : undefined
    this.engineInfo = {
      name: 'faster-whisper',
      model: asString(msg.model) ?? this.modelId,
      device,
      computeType: asString(msg.computeType) ?? this.computeType,
      fallback: device !== this.device,
      ...(versions ? { versions } : {}),
      ...(cudaDevices !== undefined ? { cudaDevices } : {}),
    }
    recordEngineInfo(this.engineInfo)
    if (this.engineInfo.fallback) {
      console.warn(
        `[whisper-worker] asked for device=${this.device} but the model loaded on ${device}; transcription will be slower`,
      )
    }
  }

  private failPending(err: Error): void {
    const pending = this.inFlight
    this.inFlight = undefined
    this.ready = false
    if (pending) {
      clearTimeout(pending.timer)
      pending.reject(err)
    }
  }

  /** Kill one specific process. Taking the target as an argument, rather
   *  than reading `this.child` when the backstop fires, means a replacement
   *  spawned in the meantime is never the one that gets the SIGKILL. */
  private killChild(target: ChildProcessWithoutNullStreams | undefined = this.child): void {
    if (!target) return
    try {
      target.kill('SIGTERM')
    } catch {
      // ignore
    }
    // SIGTERM doesn't always work on Windows; SIGKILL as a backstop.
    setTimeout(() => {
      try {
        if (target.exitCode === null && target.signalCode === null) target.kill('SIGKILL')
      } catch {
        // ignore
      }
    }, KILL_BACKSTOP_MS)
  }
}

// ---------------------------------------------------------------------------
// Process-wide singletons: one worker per device.
//
// Each is pinned to one model + compute_type for its lifetime. If either ever
// needs to change at runtime, callers should `await shutdownWhisperWorkers()`
// first and then ask for the worker again with the new arguments — until then
// the cached worker wins. `options` is honoured only when a worker is created.
// ---------------------------------------------------------------------------

let gpuWorker: WhisperWorker | undefined
let cpuWorker: WhisperWorker | undefined

export function getGpuWorker(modelId: string, computeType: string, options?: WhisperWorkerOptions): WhisperWorker {
  if (!gpuWorker) {
    gpuWorker = new WhisperWorker('cuda', modelId, computeType, options)
  }
  return gpuWorker
}

export function getCpuWorker(modelId: string, computeType: string, options?: WhisperWorkerOptions): WhisperWorker {
  if (!cpuWorker) {
    cpuWorker = new WhisperWorker('cpu', modelId, computeType, options)
  }
  return cpuWorker
}

/**
 * Shut the GPU worker down so the next request spawns a fresh process.
 *
 * The singleton is released before the shutdown completes: a caller that
 * does not await still gets a new process on its next request, rather than
 * the one being torn down.
 */
export async function resetGpuWorker(): Promise<void> {
  const w = gpuWorker
  gpuWorker = undefined
  if (w) await w.shutdown()
}

export async function shutdownWhisperWorkers(): Promise<void> {
  const workers = [gpuWorker, cpuWorker].filter((w): w is WhisperWorker => w !== undefined)
  gpuWorker = undefined
  cpuWorker = undefined
  await Promise.all(workers.map((w) => w.shutdown()))
}

/**
 * Does this failure message point at the CUDA stack rather than the audio?
 *
 * After one of these the process's CUDA context is frequently poisoned, so
 * an immediate retry on the same worker fails the same way. Callers reset
 * the worker first, and only then retry.
 */
export function isCudaClassError(message: string): boolean {
  return /cuda|cudnn|cublas|out of memory|device-side assert/i.test(message)
}

// ---------------------------------------------------------------------------
// Engine info: what the most recent transcription actually ran on.
//
// Workers publish on ready and on every successful response; the whisper.cpp
// path publishes after each run. So this reads as "the engine behind the
// latest result", which is the honest answer for a status panel when a GPU
// session has quietly dropped to the CPU fallback.
// ---------------------------------------------------------------------------

let lastEngineInfo: EngineInfo | undefined

export function recordEngineInfo(info: EngineInfo): void {
  lastEngineInfo = { ...info }
}

export function getEngineInfo(): EngineInfo | undefined {
  return lastEngineInfo
}
