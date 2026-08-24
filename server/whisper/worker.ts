// Persistent Python worker for Whisper transcription.
//
// Why this exists: the original one-shot path in invoke.ts spawned a fresh
// Python subprocess per utterance. Each spawn re-initialised CUDA + cuDNN,
// and on Windows that occasionally crashed with STATUS_STACK_BUFFER_OVERRUN
// (exit code 3221226505 / 0xC0000409) during cuDNN's auto-tuner code path.
// With ~250+ utterances per session, even a small per-spawn crash rate
// made every long session bomb at least once.
//
// The fix is architectural: keep one Python process alive for the whole
// session, load the model once, and stream utterance requests over
// stdin/stdout as line-delimited JSON. No re-init = no re-init crash. As
// a free bonus, the ~3-5s per-call model-load overhead vanishes.
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
//   - Each request gets a configurable timeout (default 90 min). If a
//     request stalls, we kill the worker so the queue can move on.
//   - Each request carries an id; mismatched responses are logged and
//     dropped rather than mis-routed.
//
// The class is exported alongside a process-wide singleton for the CUDA
// worker — there's no need for multiple GPU workers, and the CPU
// fallback in liveQueue stays on one-shot spawn (rare path, no benefit
// from a long-lived process).
//
// See server/whisper/invoke.ts for the public API; this file is
// intentionally not exported to consumers outside the whisper module.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { pythonBin, transcribeScript, whisperStatus } from './bootstrap.js'
import type { TranscribeOptions, TranscribeResult } from './invoke.js'

const REQUEST_TIMEOUT_MS = 90 * 60 * 1000
const READY_TIMEOUT_MS = 120 * 1000

type ReadyMessage = { kind: 'ready'; device: string; model: string }
type ResponseMessage =
  | { kind: 'response'; id: string; ok: true; result: TranscribeResult }
  | { kind: 'response'; id: string; ok: false; error: string }
type WorkerMessage = ReadyMessage | ResponseMessage

type Pending = {
  id: string
  resolve: (r: TranscribeResult) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

export class WhisperWorker {
  private child?: ChildProcessWithoutNullStreams
  private ready = false
  private startingPromise?: Promise<void>
  private inFlight?: Pending
  private stdoutBuf = ''
  private nextId = 1
  // Serialise requests through a promise chain. `chain` always resolves
  // (we swallow its rejections) so the chain stays alive across a failed
  // call — the next request simply lazily restarts the worker.
  private chain: Promise<void> = Promise.resolve()

  constructor(
    private readonly device: 'cuda' | 'cpu',
    private readonly modelId: string,
    private readonly computeType: string,
  ) {}

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

  /** Close stdin, wait briefly for graceful exit, force-kill if needed.
   *  Used from server shutdown paths and tests. */
  async shutdown(): Promise<void> {
    if (!this.child) return
    try {
      this.child.stdin.end()
    } catch {
      // ignore — child may already be dead
    }
    // Give Python ~500ms to exit cleanly after stdin EOF; then SIGTERM.
    await new Promise((r) => setTimeout(r, 500))
    if (this.child && !this.child.killed) {
      this.killChild()
    }
  }

  private async execute(opts: TranscribeOptions): Promise<TranscribeResult> {
    await this.ensureStarted()
    const child = this.child
    if (!child) {
      throw new Error('Whisper worker failed to start')
    }
    return new Promise<TranscribeResult>((resolve, reject) => {
      const id = `req_${this.nextId++}`
      const timer = setTimeout(() => {
        if (this.inFlight?.id === id) {
          this.inFlight = undefined
          this.killChild()
          reject(new Error(`Whisper request ${id} timed out after ${REQUEST_TIMEOUT_MS}ms`))
        }
      }, REQUEST_TIMEOUT_MS)
      this.inFlight = { id, resolve, reject, timer }
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
        clearTimeout(timer)
        this.inFlight = undefined
        reject(err as Error)
      }
    })
  }

  private async ensureStarted(): Promise<void> {
    if (this.ready && this.child && !this.child.killed) return
    if (this.startingPromise) return this.startingPromise

    const status = await whisperStatus()
    if (!status.ready) {
      throw new Error(status.error ?? 'Whisper sidecar is not ready.')
    }

    this.startingPromise = new Promise<void>((resolve, reject) => {
      const args = [
        transcribeScript(),
        '--serve',
        '--model', this.modelId,
        '--device', this.device,
        '--compute-type', this.computeType,
      ]
      const child = spawn(pythonBin(), args, { stdio: ['pipe', 'pipe', 'pipe'] })
      this.child = child
      this.stdoutBuf = ''
      this.ready = false

      const readyTimer = setTimeout(() => {
        reject(new Error(`Whisper worker did not become ready within ${READY_TIMEOUT_MS}ms`))
        this.killChild()
      }, READY_TIMEOUT_MS)

      const onReady = () => {
        clearTimeout(readyTimer)
        this.ready = true
        resolve()
      }

      child.stdout.on('data', (buf: Buffer) => this.handleStdout(buf, onReady))
      child.stderr.on('data', (buf: Buffer) => {
        // Forward Python stderr (model load logs, errors, traces) to our
        // own stderr with a tag so it's easy to spot in mixed server logs.
        process.stderr.write(`[whisper-worker] ${buf}`)
      })
      child.on('error', (err) => {
        clearTimeout(readyTimer)
        this.failPending(err)
        if (!this.ready) reject(err)
      })
      child.on('close', (code, signal) => {
        clearTimeout(readyTimer)
        const err = new Error(
          `Whisper worker exited (code=${code}, signal=${signal ?? 'none'})`
        )
        this.failPending(err)
        if (!this.ready) reject(err)
        // After exit we drop our reference so the next ensureStarted()
        // spawns a fresh process.
        this.child = undefined
        this.ready = false
      })
    })

    try {
      await this.startingPromise
    } finally {
      this.startingPromise = undefined
    }
  }

  private handleStdout(buf: Buffer, onReady: () => void): void {
    this.stdoutBuf += buf.toString('utf8')
    while (true) {
      const nl = this.stdoutBuf.indexOf('\n')
      if (nl < 0) break
      const line = this.stdoutBuf.slice(0, nl).trim()
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1)
      if (!line) continue
      let msg: WorkerMessage
      try {
        msg = JSON.parse(line) as WorkerMessage
      } catch {
        process.stderr.write(
          `[whisper-worker] bad JSON on stdout: ${line.slice(0, 200)}\n`
        )
        continue
      }
      if (msg.kind === 'ready') {
        onReady()
        continue
      }
      if (msg.kind === 'response') {
        const pending = this.inFlight
        if (!pending || pending.id !== msg.id) {
          process.stderr.write(
            `[whisper-worker] response for unknown id ${msg.id}\n`
          )
          continue
        }
        clearTimeout(pending.timer)
        this.inFlight = undefined
        if (msg.ok) {
          pending.resolve(msg.result)
        } else {
          pending.reject(new Error(msg.error))
        }
      }
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

  private killChild(): void {
    if (!this.child) return
    try {
      this.child.kill('SIGTERM')
    } catch {
      // ignore
    }
    // SIGTERM doesn't always work on Windows; SIGKILL as a backstop.
    setTimeout(() => {
      try {
        this.child?.kill('SIGKILL')
      } catch {
        // ignore
      }
    }, 2000)
  }
}

// Process-wide singleton. The CPU fallback path in liveQueue.ts keeps
// using one-shot spawns — CPU calls are the rare exception, not the rule,
// and there's no re-init crash to mitigate without cuDNN in the picture.
//
// We pin the worker to one model + compute_type for its lifetime. If
// either ever needs to change at runtime, callers should `await
// shutdownWhisperWorkers()` first and then call getGpuWorker with the
// new arguments — until then the cached worker wins.
let gpuWorker: WhisperWorker | undefined

export function getGpuWorker(modelId: string, computeType: string): WhisperWorker {
  if (!gpuWorker) {
    gpuWorker = new WhisperWorker('cuda', modelId, computeType)
  }
  return gpuWorker
}

export async function shutdownWhisperWorkers(): Promise<void> {
  if (gpuWorker) {
    const w = gpuWorker
    gpuWorker = undefined
    await w.shutdown()
  }
}
