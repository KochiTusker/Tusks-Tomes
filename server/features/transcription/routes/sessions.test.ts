// Path-traversal regression test for /api/sessions/:id/*.
//
// req.params.id is user-controlled. Express's path-to-regexp decodes
// percent-encoded slashes inside a single :id segment, so a hostile
// request like `DELETE /api/sessions/..%2F..%2Fetc` reaches the handler
// with `req.params.id === "../../etc"`. Without validation, that gets
// composed into `path.join(sessionsRoot(), id)` and the request
// becomes a directory deletion gadget rooted anywhere the server
// process can write.
//
// This test pins three behaviours:
//   1. Every :id route returns 400 on a malformed id (we never reach
//      the filesystem layer).
//   2. A well-formed but unknown id returns 404 (the route is alive).
//   3. sessionDir() itself fails closed if a future caller forgets the
//      route-level guard.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import express from 'express'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { LiveState } from '../services/sessions/liveSessionBridge.js'
import type { ProcessingProgress, SessionManifest } from '../services/sessions/sessionManifest.js'
import type { TranscribeOptions, TranscribeResult } from '../services/whisper/invoke.js'

let WORK: string
// The engine behind the real queue, for the tests that run it. Nothing in
// this file needs Python.
let transcribeStub: ReturnType<typeof vi.fn<(opts: TranscribeOptions) => Promise<TranscribeResult>>>

beforeEach(async () => {
  WORK = await fs.mkdtemp(path.join(tmpdir(), 'sessions-test-'))
  vi.resetModules()
  vi.doMock('../../../platform/appData.js', async () => {
    const actual = await vi.importActual<typeof import('../../../platform/appData')>('../../../platform/appData.js')
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
  transcribeStub = vi.fn<(opts: TranscribeOptions) => Promise<TranscribeResult>>()
  vi.doMock('../services/whisper/invoke.js', () => ({
    transcribeFile: transcribeStub,
    resetGpuWorker: async () => {},
    getEngineInfo: () => undefined,
    isCudaClassError: () => false,
    buildInitialPrompt: (names: string[]) => names.join(', '),
  }))
})

afterEach(async () => {
  vi.doUnmock('../whisper/invoke.js')
  vi.doUnmock('../appData.js')
  vi.resetModules()
  await fs.rm(WORK, { recursive: true, force: true })
})

async function withSessionsServer<T>(
  fn: (baseUrl: string) => Promise<T>,
  opts: { upload?: boolean } = {},
): Promise<T> {
  const { sessionsRouter } = await import('./sessions.js')
  const app = express()
  app.use(express.json())
  app.use('/api/sessions', sessionsRouter())
  if (opts.upload) {
    const { uploadRouter } = await import('./upload.js')
    app.use('/api/sessions', uploadRouter())
  }
  const server: Server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${addr.port}/api/sessions`
  try {
    return await fn(baseUrl)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

describe('Path traversal — /api/sessions/:id', () => {
  // Note: we intentionally omit the empty string here. An HTTP request
  // for `/api/sessions/` is routed to the *list* handler (GET /), not to
  // `:id`, so it doesn't exercise the validator and returns 200/404
  // depending on method — not 400.
  const malicious = [
    '../etc',
    '..\\etc',
    'a/b',
    'a%2Fb', // double-encoded segment, just in case
    'a.b', // dot in id (not allowed by ID_RE)
    'x'.repeat(65), // oversize
    'with space',
    'null\x00byte',
  ]

  for (const evilId of malicious) {
    it(`DELETE ${JSON.stringify(evilId)} → 400 (no filesystem touch)`, async () => {
      await withSessionsServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/${encodeURIComponent(evilId)}`, {
          method: 'DELETE',
        })
        expect(res.status).toBe(400)
      })
    })
    it(`GET    ${JSON.stringify(evilId)}/sbv → 400`, async () => {
      await withSessionsServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/${encodeURIComponent(evilId)}/sbv`)
        expect(res.status).toBe(400)
      })
    })
    it(`GET    ${JSON.stringify(evilId)}/live → 400`, async () => {
      await withSessionsServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/${encodeURIComponent(evilId)}/live`)
        expect(res.status).toBe(400)
      })
    })
  }

  it('Content-Disposition uses RFC 6266 encoded form', async () => {
    // Seed a minimal session on disk so the SBV route reaches the
    // header-setting code path.
    const sid = 'test-session-abc'
    const dir = path.join(WORK, 'sessions', sid)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      path.join(dir, 'manifest.json'),
      JSON.stringify({
        version: 1, sessionId: sid, guildId: 'g', voiceChannelId: 'c',
        voiceChannelName: 'C', startedAt: 'now', endedAt: null,
        participants: [], processing: { transcribedAt: 'now', sbvPath: 'session.sbv' },
      }),
    )
    await fs.writeFile(path.join(dir, 'session.sbv'), '0:00:00.000,0:00:01.000\nhi\n\n')
    await withSessionsServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/${sid}/sbv`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-disposition')).toMatch(/filename\*=UTF-8''/)
    })
  })
})

describe('sessionDir fail-closed at definition', () => {
  it('throws on a non-conforming id even when called directly', async () => {
    const { sessionDir } = await import('../services/sessions/sessionManifest.js')
    expect(() => sessionDir('../etc')).toThrow(/invalid session id/)
    expect(() => sessionDir('a/b')).toThrow(/invalid session id/)
    expect(() => sessionDir('')).toThrow(/invalid session id/)
  })
  it('accepts a conforming id', async () => {
    const { sessionDir } = await import('../services/sessions/sessionManifest.js')
    expect(() => sessionDir('valid-id-1')).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// The progress contract on /:id/live. In-memory state wins while the server
// holds it; the manifest's snapshot stands in once it is forgotten, so a
// finished session keeps its counts and a session the server died under
// reads as cut short rather than as nothing.
// ---------------------------------------------------------------------------

const SID = 'live-contract-1'

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

function snapshot(over: Partial<ProcessingProgress> = {}): ProcessingProgress {
  return {
    runState: 'transcribing',
    startedAt: 1000,
    lastActivityAt: 2000,
    totalAudioMs: 90_000,
    processedAudioMs: 60_000,
    utterancesTotal: 2,
    utterancesDone: 1,
    engine: null,
    throughput: 2000,
    devices: { cuda: 1 },
    failure: null,
    ...over,
  }
}

/** Two utterances of 60 s and 30 s from two speakers, unless told otherwise. */
async function seedManifest(
  processing: Partial<SessionManifest['processing']> = {},
  utterances = 2,
): Promise<void> {
  const dir = path.join(WORK, 'sessions', SID)
  await fs.mkdir(dir, { recursive: true })
  const durations = [60_000, 30_000].slice(0, utterances)
  const manifest: SessionManifest = {
    version: 1,
    sessionId: SID,
    guildId: '',
    voiceChannelId: '',
    voiceChannelName: 'Test',
    startedAt: 'now',
    endedAt: null,
    participants: durations.map((durationMs, i) => ({
      discordUserId: `speaker-${i}`,
      discordDisplayName: `Speaker ${i}`,
      utterances: [
        { utteranceId: `u_${i}`, startedAtMs: 0, endedAtMs: durationMs, filename: `u_${i}.flac`, durationMs },
      ],
    })),
    processing: { transcribedAt: null, sbvPath: null, ...processing },
  }
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest))
}

// Loosely typed on purpose: the assertions are on the wire shape.
async function getLive(baseUrl: string): Promise<Record<string, any>> {
  const res = await fetch(`${baseUrl}/${SID}/live`)
  expect(res.status).toBe(200)
  return (await res.json()) as Record<string, unknown>
}

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > until) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('GET /:id/live — progress contract', () => {
  it('serialises the in-memory state, adding the in-flight progress to processedAudioMs', async () => {
    await seedManifest()
    const bridge = await import('../services/sessions/liveSessionBridge.js')
    const fake: LiveState = {
      active: false,
      pending: 1,
      processedUtterances: 1,
      enqueued: 2,
      segments: [{}, {}, {}],
      errors: ['note: something worth knowing'],
      participants: new Map([['speaker-0', { discordDisplayName: 'Speaker 0' }]]),
      startedAt: 1000,
      runState: 'transcribing',
      lastActivityAt: 2000,
      totalAudioMs: 90_000,
      processedAudioMs: 60_000,
      utterancesTotal: 2,
      utterancesDone: 1,
      current: {
        utteranceId: 'u_1',
        speakerDisplay: 'Speaker 1',
        audioMs: 30_000,
        startedAt: 1500,
        attempt: 2,
        progressMs: 12_000,
      },
      engine: { name: 'faster-whisper', model: 'large-v3', device: 'cuda', computeType: 'int8_float16', fallback: false },
      completed: [{ audioMs: 60_000, elapsedMs: 30 }],
      failure: null,
      devices: { cuda: 1 },
    }
    bridge.registerLiveImpl(() => fake, async () => {})

    await withSessionsServer(async (baseUrl) => {
      const before = Date.now()
      const body = await getLive(baseUrl)
      expect(body).toMatchObject({
        sessionId: SID,
        active: false,
        pending: 1,
        processed: 1,
        enqueued: 2,
        cueCount: 3,
        errors: ['note: something worth knowing'],
        finalized: false,
        runState: 'transcribing',
        startedAt: 1000,
        lastActivityAt: 2000,
        totalAudioMs: 90_000,
        processedAudioMs: 72_000,
        utterancesTotal: 2,
        utterancesDone: 1,
        current: { utteranceId: 'u_1', speakerDisplay: 'Speaker 1', audioMs: 30_000, attempt: 2, progressMs: 12_000 },
        engine: { name: 'faster-whisper', device: 'cuda', fallback: false },
        throughput: 2000,
        failure: null,
      })
      expect(body.serverNow).toBeGreaterThanOrEqual(before)
      expect(body.participants).toEqual([{ discordUserId: 'speaker-0', discordDisplayName: 'Speaker 0' }])
    })
  })

  it('refuses a second transcribe while one runs, and still reports done with the counts once the state is forgotten', async () => {
    await seedManifest()
    const bridge = await import('../services/sessions/liveSessionBridge.js')
    const queue = await import('../services/whisper/liveQueue.js')
    bridge.registerLiveImpl(queue.getLiveSessionState, queue.refreshLiveSbv)
    // Each stub call parks until the test releases it, so the run can be
    // observed mid-flight.
    const release: Array<() => void> = []
    transcribeStub.mockImplementation(
      (opts) =>
        new Promise<TranscribeResult>((resolve) => {
          release.push(() => resolve(stubResult({ speakerId: opts.speakerId ?? 'a' })))
        }),
    )

    await withSessionsServer(async (baseUrl) => {
      const first = await fetch(`${baseUrl}/${SID}/transcribe-multitrack`, { method: 'POST' })
      expect(first.status).toBe(200)
      expect(await first.json()).toEqual({ sessionId: SID, started: true })
      await waitFor(() => release.length === 1)

      const second = await fetch(`${baseUrl}/${SID}/transcribe-multitrack`, { method: 'POST' })
      expect(second.status).toBe(409)
      expect(await second.json()).toEqual({ error: 'already running' })

      const mid = await getLive(baseUrl)
      expect(mid).toMatchObject({
        runState: 'transcribing',
        pending: 2,
        utterancesTotal: 2,
        utterancesDone: 0,
        totalAudioMs: 90_000,
        processedAudioMs: 0,
        finalized: false,
      })
      expect(mid.current).toMatchObject({ utteranceId: 'u_0', audioMs: 60_000, attempt: 1 })

      release[0]()
      await waitFor(() => release.length === 2)
      release[1]()
      // The route forgets the state once the manifest is final; from then
      // on the snapshot is all there is.
      await waitFor(() => queue.getLiveSessionState(SID) === undefined)
      expect(transcribeStub).toHaveBeenCalledTimes(2)

      const after = await getLive(baseUrl)
      expect(after).toMatchObject({
        active: false,
        pending: 0,
        processed: 2,
        enqueued: 2,
        cueCount: 2,
        errors: [],
        finalized: true,
        runState: 'done',
        totalAudioMs: 90_000,
        processedAudioMs: 90_000,
        utterancesTotal: 2,
        utterancesDone: 2,
        current: null,
        engine: { device: 'cuda', fallback: false },
        // 90 s of audio in 20 ms of engine time.
        throughput: 4500,
        failure: null,
      })
      expect(after.startedAt).toBeTypeOf('number')
      expect(after.lastActivityAt).toBeTypeOf('number')
      expect(after.sbv).toContain('[Speaker 0] hello there')
      expect(after.sbv).toContain('[Speaker 1] hello there')
    }, { upload: true })
  })

  it('derives interrupted, failed, legacy-done and idle from the manifest alone', async () => {
    await withSessionsServer(async (baseUrl) => {
      // A snapshot still in flight with nothing in memory: the server went
      // away mid-run.
      await seedManifest({
        progress: snapshot({ runState: 'transcribing', utterancesDone: 1, processedAudioMs: 60_000 }),
        errors: [],
      })
      expect(await getLive(baseUrl)).toMatchObject({
        runState: 'interrupted',
        utterancesTotal: 2,
        utterancesDone: 1,
        processedAudioMs: 60_000,
        processed: 1,
        enqueued: 2,
        throughput: 2000,
        startedAt: 1000,
        lastActivityAt: 2000,
        current: null,
      })

      // The same, with transcribedAt left over from an earlier run: the
      // re-run had been rewriting the SBV, so the transcript is partial.
      await seedManifest({
        transcribedAt: 'earlier',
        sbvPath: 'session.sbv',
        progress: snapshot({ runState: 'finalising' }),
      })
      expect((await getLive(baseUrl)).runState).toBe('interrupted')

      // Errors recorded by a run from before snapshots existed.
      await seedManifest({ errors: ['speaker-0/u_0: worker exited with code 1'] })
      expect(await getLive(baseUrl)).toMatchObject({
        runState: 'interrupted',
        errors: ['speaker-0/u_0: worker exited with code 1'],
      })

      // Transcribed before snapshots existed: complete, with the counts
      // taken from the manifest.
      await seedManifest({ transcribedAt: 'earlier', sbvPath: 'session.sbv' })
      expect(await getLive(baseUrl)).toMatchObject({
        runState: 'done',
        utterancesTotal: 2,
        utterancesDone: 2,
        totalAudioMs: 90_000,
        processedAudioMs: 90_000,
        processed: 2,
        enqueued: 2,
        finalized: true,
        throughput: null,
        engine: null,
        startedAt: null,
      })

      // A run-level failure.
      await seedManifest({ progress: snapshot({ runState: 'failed', failure: 'disk full' }) })
      expect(await getLive(baseUrl)).toMatchObject({ runState: 'failed', failure: 'disk full' })

      // Nothing uploaded yet.
      await seedManifest({}, 0)
      expect(await getLive(baseUrl)).toMatchObject({
        runState: 'idle',
        utterancesTotal: 0,
        utterancesDone: 0,
        totalAudioMs: 0,
        processedAudioMs: 0,
      })
    })
  })
})
