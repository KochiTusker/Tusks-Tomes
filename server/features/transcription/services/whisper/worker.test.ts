// Tests for the persistent Whisper worker.
//
// The Python sidecar is stood in for by a small Node script that speaks the
// same line-delimited JSON protocol: loading lines, a ready line, progress
// lines during a request, a response. Real processes and real pipes, because
// the behaviour under test is exactly the plumbing — which line drives which
// callback, which timeout is armed when, whether a reset actually spawns a
// new process — and a mocked child would only ever confirm the mock.
//
// The stand-in reports device `cpu` whatever it was asked for, the way
// faster-whisper does when CUDA is unusable. That is the case the engine
// info exists to expose.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  WhisperWorker,
  getCpuWorker,
  getEngineInfo,
  getGpuWorker,
  isCudaClassError,
  resetGpuWorker,
  shutdownWhisperWorkers,
  type WhisperWorkerOptions,
} from './worker.js'
import type { TranscribeStage } from './invoke.js'

type Mode = 'normal' | 'legacy' | 'silent' | 'loading-only' | 'slow' | 'stuck'
const MODES: Mode[] = ['normal', 'legacy', 'silent', 'loading-only', 'slow', 'stuck']

/**
 * The stand-in sidecar. One script per mode:
 *   normal        the current protocol, with an unknown envelope thrown in
 *   legacy        a sidecar from before loading/progress existed: bare ready
 *   silent        prints nothing and stays alive
 *   loading-only  prints a loading line, then stays alive
 *   slow          answers after ~600 ms, reporting an advancing position
 *                 every 100 ms on the way
 *   stuck         reports the same position every 100 ms and never answers
 * Every start appends the requested device to spawns.log beside the script.
 */
function fakeSidecarSource(mode: Mode): string {
  return `'use strict'
const fs = require('node:fs')
const path = require('node:path')
const readline = require('node:readline')
const MODE = ${JSON.stringify(mode)}
const argv = process.argv.slice(2)
const arg = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined }
const model = arg('--model')
const device = arg('--device')
const computeType = arg('--compute-type')
fs.appendFileSync(path.join(__dirname, 'spawns.log'), device + '\\n')
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')

if (MODE === 'silent') {
  setInterval(() => {}, 1000)
} else if (MODE === 'loading-only') {
  out({ kind: 'loading', stage: 'import' })
  setInterval(() => {}, 1000)
} else {
  if (MODE === 'normal') {
    out({ kind: 'loading', stage: 'import' })
    out({ kind: 'loading', stage: 'model' })
    process.stderr.write('[worker] loading model=' + model + ' device=' + device + ' compute_type=' + computeType + '\\n')
    out({
      kind: 'ready',
      device: 'cpu',
      model,
      computeType: 'int8',
      versions: { faster_whisper: '1.1.0', ctranslate2: '4.5.0', torch: null, cuda: null },
      cudaDevices: 0,
    })
    out({ kind: 'banner', text: 'an envelope from a newer sidecar' })
  } else {
    out({ kind: 'ready' })
  }
  const rl = readline.createInterface({ input: process.stdin })
  rl.on('line', (line) => {
    if (!line.trim()) return
    const req = JSON.parse(line)
    if (MODE === 'stuck') {
      setInterval(() => out({ kind: 'progress', id: req.id, processedMs: 100, durationMs: 1000 }), 100)
      return
    }
    if (MODE === 'slow') {
      let at = 0
      const tick = setInterval(() => {
        at += 100
        out({ kind: 'progress', id: req.id, processedMs: at, durationMs: 600 })
        if (at < 600) return
        clearInterval(tick)
        out({
          kind: 'response',
          id: req.id,
          ok: true,
          result: { speakerId: req.speakerId, speakerDisplay: req.speakerDisplay, durationMs: 600, elapsedMs: 600, model, device, language: req.language, segments: [] },
        })
      }, 100)
      return
    }
    if (MODE === 'normal') {
      out({ kind: 'progress', id: req.id, processedMs: 500, durationMs: 1000 })
      out({ kind: 'progress', id: 'not-this-request', processedMs: 999999, durationMs: 1000 })
      out({ kind: 'heartbeat', id: req.id })
      out({ kind: 'progress', id: req.id, processedMs: 1000, durationMs: 1000 })
    }
    if (req.audio === 'boom.wav') {
      out({ kind: 'response', id: req.id, ok: false, error: 'CUDA failed with error out of memory' })
      return
    }
    out({
      kind: 'response',
      id: req.id,
      ok: true,
      result: {
        speakerId: req.speakerId,
        speakerDisplay: req.speakerDisplay,
        durationMs: 1000,
        elapsedMs: 5,
        model,
        device: MODE === 'normal' ? 'cpu' : device,
        language: req.language,
        segments: [{ startMs: 0, endMs: 1000, text: 'heard ' + req.audio, words: [], confidence: null }],
      },
    })
  })
}
`
}

let dir = ''
const scripts = {} as Record<Mode, string>
const live: WhisperWorker[] = []

function optionsFor(mode: Mode, extra: Partial<WhisperWorkerOptions> = {}): WhisperWorkerOptions {
  return { pythonBin: process.execPath, script: scripts[mode], skipStatusCheck: true, ...extra }
}

function standalone(device: 'cuda' | 'cpu', mode: Mode = 'normal', extra: Partial<WhisperWorkerOptions> = {}): WhisperWorker {
  const w = new WhisperWorker(device, 'large-v3', device === 'cuda' ? 'int8_float16' : 'int8', optionsFor(mode, extra))
  live.push(w)
  return w
}

async function spawnLog(): Promise<string[]> {
  try {
    return (await fs.readFile(path.join(dir, 'spawns.log'), 'utf8')).split('\n').filter(Boolean)
  } catch {
    return []
  }
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tt-whisper-worker-'))
  for (const mode of MODES) {
    scripts[mode] = path.join(dir, `fake-${mode}.cjs`)
    await fs.writeFile(scripts[mode], fakeSidecarSource(mode))
  }
})

afterAll(async () => {
  await shutdownWhisperWorkers()
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

beforeEach(async () => {
  await shutdownWhisperWorkers()
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(async () => {
  await Promise.all(live.splice(0).map((w) => w.shutdown()))
  vi.restoreAllMocks()
})

describe('WhisperWorker against a stand-in sidecar', () => {
  it('reports loading then transcribing on a cold start, and only transcribing once warm', async () => {
    const w = standalone('cuda')
    const stages: TranscribeStage[] = []
    await w.transcribe({ audio: 'one.wav', onStatus: (s) => stages.push(s) })
    expect(stages).toEqual(['loading_model', 'transcribing'])

    stages.length = 0
    await w.transcribe({ audio: 'two.wav', onStatus: (s) => stages.push(s) })
    expect(stages).toEqual(['transcribing'])
  })

  it('routes progress to the in-flight request only, in order', async () => {
    const w = standalone('cuda')
    const seen: number[] = []
    await w.transcribe({
      audio: 'one.wav',
      onProgress: (p) => {
        expect(p.durationMs).toBe(1000)
        seen.push(p.processedMs)
      },
    })
    // The 999999 addressed to another id never arrives.
    expect(seen).toEqual([500, 1000])
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1])
  })

  it('records the engine the sidecar actually loaded and flags the fallback', async () => {
    const w = standalone('cuda')
    await w.transcribe({ audio: 'one.wav' })
    const info = w.engine()
    expect(info).toEqual({
      name: 'faster-whisper',
      model: 'large-v3',
      device: 'cpu',
      computeType: 'int8',
      // null entries (libraries the sidecar could not import) are dropped.
      versions: { faster_whisper: '1.1.0', ctranslate2: '4.5.0' },
      cudaDevices: 0,
      fallback: true,
    })
    expect(getEngineInfo()).toEqual(info)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('loaded on cpu'))
  })

  it('resolves with the sidecar result, unknown envelopes notwithstanding', async () => {
    const w = standalone('cuda')
    const r = await w.transcribe({ audio: 'one.wav', speakerId: 'u_1', speakerDisplay: 'Lucian', language: 'en' })
    expect(r.device).toBe('cpu')
    expect(r.speakerDisplay).toBe('Lucian')
    expect(r.segments[0].text).toBe('heard one.wav')
  })

  it('treats a sidecar from before loading and progress existed as ready on the requested device', async () => {
    const w = standalone('cuda', 'legacy')
    const stages: TranscribeStage[] = []
    let progressCalls = 0
    const r = await w.transcribe({
      audio: 'old.wav',
      onStatus: (s) => stages.push(s),
      onProgress: () => progressCalls++,
    })
    expect(r.device).toBe('cuda')
    expect(stages).toEqual(['loading_model', 'transcribing'])
    expect(progressCalls).toBe(0)
    expect(w.engine()).toEqual({
      name: 'faster-whisper',
      model: 'large-v3',
      device: 'cuda',
      computeType: 'int8_float16',
      fallback: false,
    })
  })

  it('rejects a failed request with the sidecar message and stays up for the next one', async () => {
    const w = standalone('cuda')
    await expect(w.transcribe({ audio: 'boom.wav' })).rejects.toThrow(/out of memory/)
    const before = (await spawnLog()).length
    const r = await w.transcribe({ audio: 'after.wav' })
    expect(r.segments[0].text).toBe('heard after.wav')
    expect((await spawnLog()).length).toBe(before)
  })

  it('logs the load banner once through console.log', async () => {
    const w = standalone('cuda')
    await w.transcribe({ audio: 'a.wav' })
    await w.transcribe({ audio: 'b.wav' })
    const banners = vi
      .mocked(console.log)
      .mock.calls.filter((c) => String(c[0]).includes('[worker] loading model=large-v3 device=cuda'))
    expect(banners).toHaveLength(1)
  })

  it('gives up on a silent sidecar at the ready deadline', async () => {
    const w = standalone('cuda', 'silent', { readyTimeoutMs: 300, loadingTimeoutMs: 10_000 })
    const t0 = Date.now()
    await expect(w.transcribe({ audio: 'x.wav' })).rejects.toThrow(/did not become ready within 300ms/)
    expect(Date.now() - t0).toBeLessThan(5_000)
  })

  it('lets a request run past the idle window while its position keeps advancing', async () => {
    // ~600 ms of work against a 300 ms idle window: a flat wall clock would
    // kill this; progress re-arming must not.
    const w = standalone('cpu', 'slow', { requestIdleTimeoutMs: 300 })
    const result = await w.transcribe({ audio: 'long-track.wav' })
    expect(result.durationMs).toBe(600)
  })

  it('still times out a request whose position stops advancing', async () => {
    // Progress lines keep arriving, but always at the same position — the
    // shape of a worker that is alive and going nowhere.
    const w = standalone('cpu', 'stuck', { requestIdleTimeoutMs: 400 })
    await expect(w.transcribe({ audio: 'stuck.wav' })).rejects.toThrow(/no progress for 400ms/)
  })

  it('extends the deadline once a loading line proves the sidecar alive', async () => {
    // Without the extension the 1s ready deadline would fire; the loading
    // line moves it to the 2.5s loading deadline, and that is the one seen.
    const w = standalone('cuda', 'loading-only', { readyTimeoutMs: 1_000, loadingTimeoutMs: 2_500 })
    const t0 = Date.now()
    await expect(w.transcribe({ audio: 'x.wav' })).rejects.toThrow(/still loading the model/)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2_000)
  })
})

describe('per-device singletons', () => {
  it('keeps a separate process per device', async () => {
    const gpu = getGpuWorker('large-v3', 'int8_float16', optionsFor('normal'))
    const cpu = getCpuWorker('large-v3', 'int8', optionsFor('normal'))
    expect(cpu).not.toBe(gpu)

    const before = (await spawnLog()).length
    await gpu.transcribe({ audio: 'g.wav' })
    await cpu.transcribe({ audio: 'c.wav' })
    expect((await spawnLog()).slice(before)).toEqual(['cuda', 'cpu'])

    // The CPU worker asked for cpu and got cpu: no fallback to report.
    expect(cpu.engine()?.fallback).toBe(false)
    expect(gpu.engine()?.fallback).toBe(true)
    // The module-level record follows the latest result.
    expect(getEngineInfo()).toEqual(cpu.engine())
  })

  it('resetGpuWorker() makes the next request spawn a fresh process', async () => {
    const first = getGpuWorker('large-v3', 'int8_float16', optionsFor('normal'))
    await first.transcribe({ audio: 'one.wav' })
    const before = (await spawnLog()).length

    await resetGpuWorker()
    const second = getGpuWorker('large-v3', 'int8_float16', optionsFor('normal'))
    expect(second).not.toBe(first)
    await second.transcribe({ audio: 'two.wav' })
    expect((await spawnLog()).length).toBe(before + 1)
  })
})

describe('isCudaClassError', () => {
  it('recognises the CUDA stack by name', () => {
    for (const msg of [
      'CUDA failed with error out of memory',
      'cuDNN error: CUDNN_STATUS_INTERNAL_ERROR',
      'CUBLAS_STATUS_NOT_INITIALIZED',
      'RuntimeError: device-side assert triggered',
      'Out of memory',
    ]) {
      expect(isCudaClassError(msg)).toBe(true)
    }
  })

  it('leaves audio and I/O failures alone', () => {
    expect(isCudaClassError('audio file not found: /tmp/x.wav')).toBe(false)
    expect(isCudaClassError('bad JSON: Expecting value')).toBe(false)
  })
})
