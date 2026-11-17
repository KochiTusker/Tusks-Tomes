/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReforgeConfig, ReforgeInput } from './reforge'
import type { ReforgeResumeRecord } from './reforgeResume'

const cfg = (over: Partial<ReforgeConfig> = {}): ReforgeConfig => ({
  regenerateChronicle: false,
  doExtras: true,
  doCondense: true,
  extrasSource: 'transcript',
  geminiTier: 'paid',
  ...over,
})

const input: ReforgeInput = {
  chronicle: 'CHRONICLE',
  groundedTranscript: '[Dungeon Master (DM)] The gate creaks.\n[Vell (Player 1)] We go in.',
  dmQuestions: [],
  dmAnswers: {},
  kb: [],
  campaign: 'Ironvale',
  sessionNumber: 7,
}

const record = (over: Partial<ReforgeResumeRecord> = {}): ReforgeResumeRecord => ({
  version: 1,
  savedAt: '2026-09-24T01:12:42.000Z',
  sourceId: 'lib-entry-1',
  campaign: 'Ironvale',
  sessionNumber: 7,
  config: cfg({ provider: 'openrouter', model: 'moonshotai/kimi-k3' }),
  provider: 'openrouter',
  modelLabel: 'Kimi K3',
  priorOutputs: { extras: null, condensed: null },
  progress: {
    inFlight: { phase: 'phase4', nextChunk: 5, totalChunks: 6, chunkSizeChars: 30_000, partial: '{"jests":[],"gore":[],"quotes":[]}' },
  },
  stopReason: '402 This request would exceed your available credits',
  ...over,
})

/** A fresh copy of the module — what a page reload leaves behind. */
async function afterReload() {
  vi.resetModules()
  return import('./reforgeResume')
}

beforeEach(async () => {
  localStorage.clear()
  ;(await import('./reforgeResume')).clearStoppedReforge()
})

describe('describeKeptWork', () => {
  it('names the finished chunks and what a resume still runs', async () => {
    const { describeKeptWork } = await import('./reforgeResume')
    expect(describeKeptWork(record().config, record().progress)).toBe(
      'Kept: Extras chunks 1–5 of 6. Resume runs Extras from chunk 6 and Condense.',
    )
  })

  it('lists every phase still to run after a stop in the chronicle rewrite', async () => {
    const { describeKeptWork } = await import('./reforgeResume')
    const progress = {
      inFlight: { phase: 'phase3' as const, nextChunk: 2, totalChunks: 4, chunkSizeChars: 40_000, partial: 'Two parts.' },
    }
    expect(describeKeptWork(cfg({ regenerateChronicle: true }), progress)).toBe(
      'Kept: Chronicle rewrite chunks 1–2 of 4. Resume runs Chronicle rewrite from chunk 3, Extras and Condense.',
    )
  })

  it('names a finished phase as kept whole', async () => {
    const { describeKeptWork } = await import('./reforgeResume')
    const progress = { extras: { jests: ['j'], gore: [], quotes: [] } }
    expect(describeKeptWork(cfg(), progress)).toBe('Kept: the extras. Resume runs Condense.')
  })
})

describe('stopped-run storage', () => {
  it('keeps a library-sourced run across a reload, without copying the source text', async () => {
    const { saveStoppedReforge } = await import('./reforgeResume')
    saveStoppedReforge(record(), input)

    expect(localStorage.getItem('reforge_resume')).not.toContain('CHRONICLE')
    const reloaded = (await afterReload()).loadStoppedReforge()
    expect(reloaded?.record.sourceId).toBe('lib-entry-1')
    expect(reloaded?.record.progress.inFlight?.nextChunk).toBe(5)
    // The input is rebuilt from the library on resume.
    expect(reloaded?.input).toBeNull()
  })

  it('keeps a pasted-source run in memory only', async () => {
    const { saveStoppedReforge, loadStoppedReforge } = await import('./reforgeResume')
    saveStoppedReforge(record({ sourceId: undefined }), input)

    expect(loadStoppedReforge()?.input).toEqual(input)
    expect(localStorage.getItem('reforge_resume')).toBeNull()
    expect((await afterReload()).loadStoppedReforge()).toBeNull()
  })

  it('clears both copies', async () => {
    const { saveStoppedReforge, clearStoppedReforge, loadStoppedReforge } = await import('./reforgeResume')
    saveStoppedReforge(record(), input)
    clearStoppedReforge()
    expect(loadStoppedReforge()).toBeNull()
    expect((await afterReload()).loadStoppedReforge()).toBeNull()
  })

  it('ignores a stored record it cannot use', async () => {
    localStorage.setItem('reforge_resume', JSON.stringify({ version: 1, sourceId: 'x' }))
    expect((await afterReload()).loadStoppedReforge()).toBeNull()
  })
})
