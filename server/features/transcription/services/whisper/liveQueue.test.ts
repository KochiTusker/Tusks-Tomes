// Tests for the transcription queue's account of a run.
//
// The engine is a stub `transcribeFile`: what is under test is what the
// queue records about a run — audio totals, throughput, the device each
// utterance ran on, the retry ladder, the snapshot it leaves in the
// manifest — and none of that needs Python. Each test gets a fresh module,
// because the GPU-unavailable flag is deliberately module-level and only a
// server restart clears it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { TranscribeOptions, TranscribeResult } from './invoke.js'
import type { SessionManifest } from '../sessions/sessionManifest.js'
import { throughputOf } from '../sessions/liveSessionBridge.js'

type TranscribeFn = (opts: TranscribeOptions) => Promise<TranscribeResult>

let WORK: string
let transcribeFile: ReturnType<typeof vi.fn<TranscribeFn>>
let resetGpuWorker: ReturnType<typeof vi.fn<() => Promise<void>>>

beforeEach(async () => {
  WORK = await fs.mkdtemp(path.join(os.tmpdir(), 'live-queue-test-'))
  vi.resetModules()
  vi.doMock('../../../../platform/appData.js', async () => {
    const actual = await vi.importActual<typeof import('../../../../platform/appData.js')>('../../../../platform/appData.js')
    return {
      ...actual,
      sessionsRoot: () => path.join(WORK, 'sessions'),
      configDir: () => WORK,
      // These resolve configDir inside the real module, so they need their
      // own overrides or the queue would read the developer's own files.
      glossaryFile: () => path.join(WORK, 'glossary.json'),
      speakersFile: () => path.join(WORK, 'speakers.json'),
    }
  })
  transcribeFile = vi.fn<TranscribeFn>()
  resetGpuWorker = vi.fn<() => Promise<void>>(async () => {})
  vi.doMock('./invoke.js', () => ({
    transcribeFile,
    resetGpuWorker,
    getEngineInfo: () => undefined,
    isCudaClassError: (message: string) =>
      /cuda|cudnn|cublas|out of memory|device-side assert/i.test(message),
    buildInitialPrompt: (names: string[]) => names.join(', '),
  }))
})

afterEach(async () => {
  vi.doUnmock('./invoke.js')
  vi.doUnmock('../appData.js')
  vi.resetModules()
  await fs.rm(WORK, { recursive: true, force: true })
})

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function stubResult(over: Partial<TranscribeResult> = {}): TranscribeResult {
  return {
    speakerId: 'a',
    speakerDisplay: 'A',
    durationMs: 1000,
    elapsedMs: 10,
    model: 'large-v3',
    device: 'cuda',
    language: 'en',
    segments: [{ startMs: 0, endMs: 900, text: 'hello there', words: [], confidence: null }],
    ...over,
  }
}

type Seed = { speaker: string; durationMs: number }

/** Utterances land in the manifest in the order given, back to back. */
async function seedSession(id: string, seeds: Seed[]): Promise<void> {
  const dir = path.join(WORK, 'sessions', id)
  await fs.mkdir(dir, { recursive: true })
  const participants: SessionManifest['participants'] = []
  let cursor = 0
  seeds.forEach((seed, i) => {
    let participant = participants.find((p) => p.discordUserId === seed.speaker)
    if (!participant) {
      participant = {
        discordUserId: seed.speaker,
        discordDisplayName: seed.speaker.toUpperCase(),
        utterances: [],
      }
      participants.push(participant)
    }
    participant.utterances.push({
      utteranceId: `u_${i}`,
      startedAtMs: cursor,
      endedAtMs: cursor + seed.durationMs,
      filename: `u_${i}.flac`,
      durationMs: seed.durationMs,
    })
    cursor += seed.durationMs
  })
  const manifest: SessionManifest = {
    version: 1,
    sessionId: id,
    guildId: '',
    voiceChannelId: '',
    voiceChannelName: 'Test',
    startedAt: new Date().toISOString(),
    endedAt: null,
    participants,
    processing: { transcribedAt: null, sbvPath: null },
  }
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest))
}

async function readManifestFile(id: string): Promise<SessionManifest> {
  const raw = await fs.readFile(path.join(WORK, 'sessions', id, 'manifest.json'), 'utf8')
  return JSON.parse(raw) as SessionManifest
}

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > until) throw new Error('waitFor timed out')
    await sleep(5)
  }
}

describe('liveQueue — the account of a run', () => {
  it('records audio totals, utterance counts, throughput and a snapshot after every utterance', async () => {
    await seedSession('s1', [
      { speaker: 'a', durationMs: 60_000 },
      { speaker: 'b', durationMs: 30_000 },
    ])
    const queue = await import('./liveQueue.js')
    const runStatesSeen: string[] = []
    const snapshotDoneSeen: Array<number | undefined> = []
    let calls = 0
    transcribeFile.mockImplementation(async () => {
      calls += 1
      const first = calls === 1
      runStatesSeen.push(queue.getLiveSessionState('s1')!.runState)
      snapshotDoneSeen.push((await readManifestFile('s1')).processing.progress?.utterancesDone)
      await sleep(first ? 30 : 15)
      return stubResult({ durationMs: first ? 60_000 : 30_000, elapsedMs: first ? 30 : 15 })
    })

    const t0 = Date.now()
    const state = await queue.transcribeExistingSession('s1')
    const t1 = Date.now()

    expect(state.utterancesTotal).toBe(2)
    expect(state.utterancesDone).toBe(2)
    expect(state.totalAudioMs).toBe(90_000)
    expect(state.processedAudioMs).toBe(90_000)
    // 90 s of audio in 45 ms of engine time.
    expect(throughputOf(state.completed)).toBe(2000)
    expect(state.lastActivityAt).toBeGreaterThanOrEqual(t0)
    expect(state.lastActivityAt).toBeLessThanOrEqual(t1)
    expect(state.runState).toBe('done')
    expect(state.current).toBeNull()
    expect(state.devices).toEqual({ cuda: 2 })
    expect(state.engine).toMatchObject({ device: 'cuda', fallback: false, model: 'large-v3' })
    expect(state.errors).toEqual([])
    expect(runStatesSeen).toEqual(['transcribing', 'transcribing'])
    // One snapshot before the first utterance, then one after each.
    expect(snapshotDoneSeen).toEqual([0, 1])
    expect(queue.isLiveSessionRunning('s1')).toBe(false)

    const manifest = await readManifestFile('s1')
    expect(manifest.processing.transcribedAt).toBeTruthy()
    expect(manifest.processing.sbvPath).toBe('session.sbv')
    expect(manifest.processing.errors).toEqual([])
    expect(manifest.processing.devices).toEqual({ cuda: 2 })
    expect(manifest.processing.progress).toMatchObject({
      runState: 'done',
      startedAt: state.startedAt,
      utterancesTotal: 2,
      utterancesDone: 2,
      totalAudioMs: 90_000,
      processedAudioMs: 90_000,
      throughput: 2000,
      devices: { cuda: 2 },
      failure: null,
    })
    const sbv = await fs.readFile(path.join(WORK, 'sessions', 's1', 'session.sbv'), 'utf8')
    expect(sbv).toContain('[A] hello there')
    expect(sbv).toContain('[B] hello there')
  })

  it('progress and status callbacks drive current.progressMs, lastActivityAt and runState', async () => {
    await seedSession('s2', [{ speaker: 'a', durationMs: 60_000 }])
    const queue = await import('./liveQueue.js')
    const seen: Array<Record<string, unknown>> = []
    transcribeFile.mockImplementation(async (opts) => {
      const state = queue.getLiveSessionState('s2')!
      const before = state.lastActivityAt!
      seen.push({ attempt: state.current?.attempt, audioMs: state.current?.audioMs })
      opts.onStatus?.('loading_model')
      seen.push({ runState: state.runState })
      await sleep(10)
      opts.onStatus?.('transcribing')
      opts.onProgress?.({ processedMs: 12_000, durationMs: 60_000 })
      seen.push({
        runState: state.runState,
        progressMs: state.current?.progressMs,
        bumped: state.lastActivityAt! > before,
        // Completed audio only; the in-flight figure is added at response time.
        processedAudioMs: state.processedAudioMs,
      })
      return stubResult({ durationMs: 60_000 })
    })

    await queue.transcribeExistingSession('s2')

    expect(seen).toEqual([
      { attempt: 1, audioMs: 60_000 },
      { runState: 'loading_model' },
      { runState: 'transcribing', progressMs: 12_000, bumped: true, processedAudioMs: 0 },
    ])
  })

  it('resets the GPU worker once after a CUDA-class failure and retries on the GPU', async () => {
    await seedSession('s3', [{ speaker: 'a', durationMs: 5_000 }])
    const queue = await import('./liveQueue.js')
    transcribeFile
      .mockRejectedValueOnce(new Error('CUDA error: out of memory'))
      .mockResolvedValueOnce(stubResult({ durationMs: 5_000 }))

    const state = await queue.transcribeExistingSession('s3')

    expect(resetGpuWorker).toHaveBeenCalledTimes(1)
    expect(transcribeFile).toHaveBeenCalledTimes(2)
    // The retry stayed on the GPU: no device override.
    expect(transcribeFile.mock.calls[1][0].device).toBeUndefined()
    expect(state.engine).toMatchObject({ device: 'cuda', fallback: false })
    expect(state.engine?.fallbackReason).toBeUndefined()
    expect(state.devices).toEqual({ cuda: 1 })
    expect(state.utterancesDone).toBe(1)
    expect(state.processedAudioMs).toBe(5_000)
    expect(state.errors).toEqual([expect.stringMatching(/^note: .*GPU worker reset/)])
  })

  it('falls back to the CPU after two GPU failures and sends later utterances straight there', async () => {
    await seedSession('s4', [
      { speaker: 'a', durationMs: 5_000 },
      { speaker: 'a', durationMs: 5_000 },
    ])
    const queue = await import('./liveQueue.js')
    transcribeFile.mockImplementation(async (opts) =>
      stubResult({ durationMs: 5_000, device: opts.device === 'cpu' ? 'cpu' : 'cuda' }),
    )
    transcribeFile
      .mockRejectedValueOnce(new Error('worker exited with code 1'))
      .mockRejectedValueOnce(new Error('worker exited with code 1'))

    const state = await queue.transcribeExistingSession('s4')

    // Not a CUDA-class message, so no reset.
    expect(resetGpuWorker).not.toHaveBeenCalled()
    // GPU, GPU, CPU for the first utterance; CPU only for the second.
    expect(transcribeFile.mock.calls.map((c) => c[0].device ?? 'gpu')).toEqual(['gpu', 'gpu', 'cpu', 'cpu'])
    expect(state.engine).toMatchObject({
      device: 'cpu',
      computeType: 'int8',
      fallback: true,
      fallbackReason: 'worker exited with code 1',
    })
    expect(state.devices).toEqual({ cpu: 2 })
    expect(state.utterancesDone).toBe(2)
    expect(state.processedAudioMs).toBe(10_000)
    // The transition is noted once, not once per utterance.
    expect(state.errors.filter((e) => e.startsWith('note:'))).toHaveLength(1)
    expect(state.errors[0]).toMatch(/GPU unavailable/)

    const manifest = await readManifestFile('s4')
    expect(manifest.processing.devices).toEqual({ cpu: 2 })
    expect(manifest.processing.errors).toHaveLength(1)
    expect(manifest.processing.progress?.engine).toMatchObject({
      device: 'cpu',
      fallback: true,
      fallbackReason: 'worker exited with code 1',
    })
  })

  it('an utterance that fails on all three attempts is counted, listed and persisted, and the run finishes', async () => {
    await seedSession('s5', [
      { speaker: 'a', durationMs: 5_000 },
      { speaker: 'a', durationMs: 7_000 },
    ])
    const queue = await import('./liveQueue.js')
    transcribeFile.mockImplementation(async () => stubResult({ durationMs: 7_000 }))
    transcribeFile
      .mockRejectedValueOnce(new Error('worker exited with code 1'))
      .mockRejectedValueOnce(new Error('worker exited with code 1'))
      .mockRejectedValueOnce(new Error('CPU worker exited with code 1'))

    const state = await queue.transcribeExistingSession('s5')

    expect(state.runState).toBe('done')
    expect(state.utterancesDone).toBe(2)
    expect(state.utterancesTotal).toBe(2)
    // Only the utterance that completed counts towards the audio done.
    expect(state.processedAudioMs).toBe(7_000)
    expect(state.devices).toEqual({ cuda: 1 })
    expect(state.errors).toEqual(['a/u_0: CPU worker exited with code 1'])
    // The CPU did not succeed, so the GPU is still tried first.
    expect(transcribeFile.mock.calls.map((c) => c[0].device ?? 'gpu')).toEqual(['gpu', 'gpu', 'cpu', 'gpu'])

    const manifest = await readManifestFile('s5')
    expect(manifest.processing.errors).toEqual(['a/u_0: CPU worker exited with code 1'])
    expect(manifest.processing.progress).toMatchObject({ runState: 'done', utterancesDone: 2 })
  })

  it('failLiveSession marks a live run failed and persists the failure', async () => {
    await seedSession('s6', [{ speaker: 'a', durationMs: 5_000 }])
    const queue = await import('./liveQueue.js')
    let release: (() => void) | undefined
    transcribeFile.mockImplementation(
      () =>
        new Promise<TranscribeResult>((resolve) => {
          release = () => resolve(stubResult({ durationMs: 5_000 }))
        }),
    )

    const run = queue.transcribeExistingSession('s6')
    await waitFor(() => release !== undefined)
    expect(queue.isLiveSessionRunning('s6')).toBe(true)

    await queue.failLiveSession('s6', 'disk full')

    const state = queue.getLiveSessionState('s6')!
    expect(state.runState).toBe('failed')
    expect(state.failure).toBe('disk full')
    expect(state.current).toBeNull()
    expect(queue.isLiveSessionRunning('s6')).toBe(false)
    expect((await readManifestFile('s6')).processing.progress).toMatchObject({
      runState: 'failed',
      failure: 'disk full',
      utterancesTotal: 1,
    })

    // Let the parked utterance through so nothing is left draining.
    release!()
    await run
  })

  it('failLiveSession records the failure on the manifest when nothing is in memory', async () => {
    await seedSession('s7', [{ speaker: 'a', durationMs: 5_000 }])
    const queue = await import('./liveQueue.js')

    await queue.failLiveSession('s7', 'session directory vanished')

    expect(queue.getLiveSessionState('s7')).toBeUndefined()
    expect((await readManifestFile('s7')).processing.progress).toMatchObject({
      runState: 'failed',
      failure: 'session directory vanished',
    })
  })

  it('a second call while a run is under way joins it instead of enqueuing the manifest again', async () => {
    await seedSession('s8', [
      { speaker: 'a', durationMs: 1_000 },
      { speaker: 'a', durationMs: 1_000 },
      { speaker: 'b', durationMs: 1_000 },
    ])
    const queue = await import('./liveQueue.js')
    transcribeFile.mockImplementation(async () => {
      await sleep(5)
      return stubResult({ durationMs: 1_000 })
    })

    const [first, second] = await Promise.all([
      queue.transcribeExistingSession('s8'),
      queue.transcribeExistingSession('s8'),
    ])

    expect(transcribeFile).toHaveBeenCalledTimes(3)
    expect(second).toBe(first)
    expect(first.utterancesTotal).toBe(3)
    expect(first.utterancesDone).toBe(3)
    expect(first.segments).toHaveLength(3)
    expect(first.runState).toBe('done')
  })

  it('a run after a finished one starts from fresh counters', async () => {
    await seedSession('s9', [{ speaker: 'a', durationMs: 2_000 }])
    const queue = await import('./liveQueue.js')
    transcribeFile.mockImplementation(async () => stubResult({ durationMs: 2_000 }))

    const first = await queue.transcribeExistingSession('s9')
    const second = await queue.transcribeExistingSession('s9')

    expect(second).not.toBe(first)
    expect(second.utterancesDone).toBe(1)
    expect(second.processedAudioMs).toBe(2_000)
    expect(second.segments).toHaveLength(1)
    expect(transcribeFile).toHaveBeenCalledTimes(2)
  })
})
