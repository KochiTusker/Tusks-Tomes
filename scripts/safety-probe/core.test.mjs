// Tests for the safety-probe core. Covers:
//   - classifyOutcomeFromResponse across the full block-reason matrix
//   - planProbeCells produces the right Cartesian product
//   - runProbe respects abort signals + pacing + fetch mocks
//   - computeBlockRates excludes the f10 control fixture and counts only
//     the three unconfigurable block outcomes
//   - decideShipPath applies the 30pp threshold + variant precedence
//   - renderProbeMarkdown produces the predictable section structure
//   - writeProbeMarkdown + pruneProbeFiles + listRecentProbeRuns disk ops

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  PROBE_FILE_LIMIT,
  SHIP_THRESHOLD,
  classifyOutcomeFromResponse,
  computeBlockRates,
  decideShipPath,
  listRecentProbeRuns,
  planProbeCells,
  pruneProbeFiles,
  renderProbeMarkdown,
  runProbe,
  writeProbeMarkdown,
} from './core.mjs'

let tmpRoot

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tusks-safety-probe-'))
})

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

describe('classifyOutcomeFromResponse', () => {
  it('classifies promptFeedback.PROHIBITED_CONTENT', () => {
    expect(
      classifyOutcomeFromResponse({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }),
    ).toEqual({ outcome: 'prohibited_content', blockReason: 'PROHIBITED_CONTENT' })
  })

  it('classifies promptFeedback.BLOCKLIST + SPII', () => {
    expect(classifyOutcomeFromResponse({ promptFeedback: { blockReason: 'BLOCKLIST' } }).outcome).toBe('blocklist')
    expect(classifyOutcomeFromResponse({ promptFeedback: { blockReason: 'SPII' } }).outcome).toBe('spii')
  })

  it('classifies SAFETY as configurable (distinct from prohibited)', () => {
    // SAFETY = HARM_CATEGORY_* threshold tripped. BLOCK_NONE relaxes it.
    // The probe surfaces this distinctly so we can see "filter is firing
    // but it's the configurable kind, not the unconfigurable kind."
    const result = classifyOutcomeFromResponse({ promptFeedback: { blockReason: 'SAFETY' } })
    expect(result.outcome).toBe('safety')
  })

  it('classifies candidate.finishReason when promptFeedback is absent', () => {
    expect(
      classifyOutcomeFromResponse({ candidates: [{ finishReason: 'PROHIBITED_CONTENT' }] }).outcome,
    ).toBe('prohibited_content')
    expect(
      classifyOutcomeFromResponse({ candidates: [{ finishReason: 'RECITATION' }] }).outcome,
    ).toBe('recitation')
  })

  it('classifies pass when the candidate has non-empty text', () => {
    expect(
      classifyOutcomeFromResponse({
        candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'some response' }] } }],
      }).outcome,
    ).toBe('pass')
  })

  it('classifies other_error when neither block nor pass signal is present', () => {
    expect(classifyOutcomeFromResponse({}).outcome).toBe('other_error')
    expect(classifyOutcomeFromResponse({ candidates: [] }).outcome).toBe('other_error')
    expect(classifyOutcomeFromResponse({ candidates: [{}] }).outcome).toBe('other_error')
  })

  it('promptFeedback takes precedence over candidate.finishReason', () => {
    const result = classifyOutcomeFromResponse({
      promptFeedback: { blockReason: 'BLOCKLIST' },
      candidates: [{ finishReason: 'PROHIBITED_CONTENT' }],
    })
    expect(result.outcome).toBe('blocklist')
  })
})

describe('planProbeCells', () => {
  it('produces the full Cartesian product (models × fixtures × variants × phases)', () => {
    const models = [
      { tier: 'paid', modelId: 'gemini-2.5-pro', apiKey: 'k1' },
      { tier: 'free', modelId: 'gemini-2.5-flash', apiKey: 'k2' },
    ]
    const cells = planProbeCells({ models })
    // 2 models × 10 fixtures × 3 variants × 2 phases = 120
    expect(cells).toHaveLength(120)
  })

  it('respects variants restriction', () => {
    const cells = planProbeCells({
      models: [{ tier: 'paid', modelId: 'm', apiKey: 'k' }],
      variants: ['V0'],
    })
    // 1 model × 10 fixtures × 1 variant × 2 phases = 20
    expect(cells).toHaveLength(20)
    expect(cells.every((c) => c.variant === 'V0')).toBe(true)
  })

  it('respects phases restriction', () => {
    const cells = planProbeCells({
      models: [{ tier: 'paid', modelId: 'm', apiKey: 'k' }],
      phases: ['phase2'],
    })
    // 1 × 10 × 3 × 1 = 30
    expect(cells).toHaveLength(30)
    expect(cells.every((c) => c.phase === 'phase2')).toBe(true)
  })

  it('respects fixtureIds restriction', () => {
    const cells = planProbeCells({
      models: [{ tier: 'paid', modelId: 'm', apiKey: 'k' }],
      fixtureIds: ['f01_clean', 'f06_gore'],
    })
    // 1 × 2 × 3 × 2 = 12
    expect(cells).toHaveLength(12)
    const ids = new Set(cells.map((c) => c.fixtureId))
    expect(ids).toEqual(new Set(['f01_clean', 'f06_gore']))
  })

  it('cells carry the fixture category + severity for downstream rendering', () => {
    const cells = planProbeCells({
      models: [{ tier: 'paid', modelId: 'm', apiKey: 'k' }],
      fixtureIds: ['f01_clean'],
      variants: ['V0'],
      phases: ['phase2'],
    })
    expect(cells).toHaveLength(1)
    expect(cells[0].fixtureCategory).toBe('baseline')
    expect(cells[0].fixtureSeverity).toBe('baseline')
  })
})

describe('runProbe with mocked fetch', () => {
  it('executes every cell when fetch returns pass', async () => {
    const calls = []
    const fakeFetch = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) })
      return {
        ok: true,
        async json() {
          return {
            candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'ok' }] } }],
          }
        },
      }
    }
    const result = await runProbe({
      models: [{ tier: 'paid', modelId: 'gemini-2.5-pro', apiKey: 'k1' }],
      variants: ['V0'],
      phases: ['phase2'],
      fixtureIds: ['f01_clean', 'f02_mild_combat'],
      fetchImpl: fakeFetch,
    })
    expect(result.cells).toHaveLength(2)
    expect(result.cells.every((c) => c.outcome === 'pass')).toBe(true)
    // The fetch URL includes the model id.
    expect(calls[0].url).toContain('gemini-2.5-pro')
  })

  it('classifies a PROHIBITED_CONTENT response correctly', async () => {
    const fakeFetch = async () => ({
      ok: true,
      async json() {
        return { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }
      },
    })
    const result = await runProbe({
      models: [{ tier: 'paid', modelId: 'm', apiKey: 'k' }],
      variants: ['V0'],
      phases: ['phase2'],
      fixtureIds: ['f06_gore'],
      fetchImpl: fakeFetch,
    })
    expect(result.cells[0].outcome).toBe('prohibited_content')
    expect(result.cells[0].blockReason).toBe('PROHIBITED_CONTENT')
  })

  it('classifies HTTP 500 as transient_error and HTTP 400 as other_error', async () => {
    const fakeFetch500 = async () => ({ ok: false, status: 500, async text() { return '{}' } })
    const fakeFetch400 = async () => ({ ok: false, status: 400, async text() { return '{}' } })
    const r1 = await runProbe({
      models: [{ tier: 'paid', modelId: 'm', apiKey: 'k' }],
      variants: ['V0'],
      phases: ['phase2'],
      fixtureIds: ['f01_clean'],
      fetchImpl: fakeFetch500,
    })
    const r2 = await runProbe({
      models: [{ tier: 'paid', modelId: 'm', apiKey: 'k' }],
      variants: ['V0'],
      phases: ['phase2'],
      fixtureIds: ['f01_clean'],
      fetchImpl: fakeFetch400,
    })
    expect(r1.cells[0].outcome).toBe('transient_error')
    expect(r2.cells[0].outcome).toBe('other_error')
  })

  it('sends systemInstruction when variant != V0', async () => {
    const calls = []
    const fakeFetch = async (url, init) => {
      calls.push(JSON.parse(init.body))
      return {
        ok: true,
        async json() { return { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'ok' }] } }] } },
      }
    }
    await runProbe({
      models: [{ tier: 'paid', modelId: 'm', apiKey: 'k' }],
      variants: ['V0', 'V1', 'V2'],
      phases: ['phase2'],
      fixtureIds: ['f01_clean'],
      fetchImpl: fakeFetch,
    })
    // V0 has no systemInstruction; V1/V2 do.
    const v0Call = calls[0]
    const v1Call = calls[1]
    const v2Call = calls[2]
    expect(v0Call.systemInstruction).toBeUndefined()
    expect(v1Call.systemInstruction.parts[0].text).toContain('tabletop role-playing')
    expect(v2Call.systemInstruction.parts[0].text).toContain('meta-analysis')
  })

  it('honors --max-tokens via maxOutputTokens', async () => {
    const calls = []
    const fakeFetch = async (url, init) => {
      calls.push(JSON.parse(init.body))
      return {
        ok: true,
        async json() { return { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'ok' }] } }] } },
      }
    }
    await runProbe({
      models: [{ tier: 'paid', modelId: 'm', apiKey: 'k' }],
      variants: ['V0'],
      phases: ['phase2'],
      fixtureIds: ['f01_clean'],
      fetchImpl: fakeFetch,
      maxOutputTokens: 32,
    })
    expect(calls[0].generationConfig.maxOutputTokens).toBe(32)
  })

  it('honors abort signal mid-run', async () => {
    let callCount = 0
    const controller = new AbortController()
    const fakeFetch = async () => {
      callCount += 1
      if (callCount === 2) controller.abort()
      return {
        ok: true,
        async json() { return { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'ok' }] } }] } },
      }
    }
    const result = await runProbe({
      models: [{ tier: 'paid', modelId: 'm', apiKey: 'k' }],
      variants: ['V0'],
      phases: ['phase2'],
      fixtureIds: ['f01_clean', 'f02_mild_combat', 'f03_graphic_combat'],
      fetchImpl: fakeFetch,
      signal: controller.signal,
    })
    // We should NOT have processed the third cell — break before fixture 3.
    expect(result.cells.length).toBeLessThan(3)
  })

  it('emits an onProgress callback per cell with the right counter shape', async () => {
    const progress = []
    const fakeFetch = async () => ({
      ok: true,
      async json() { return { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'ok' }] } }] } },
    })
    await runProbe({
      models: [{ tier: 'paid', modelId: 'm', apiKey: 'k' }],
      variants: ['V0'],
      phases: ['phase2'],
      fixtureIds: ['f01_clean', 'f02_mild_combat'],
      fetchImpl: fakeFetch,
      onProgress: (cell, completed, total) => progress.push({ cell: cell.fixtureId, completed, total }),
    })
    expect(progress).toHaveLength(2)
    expect(progress[0].completed).toBe(1)
    expect(progress[0].total).toBe(2)
    expect(progress[1].completed).toBe(2)
  })
})

describe('computeBlockRates', () => {
  it('excludes the f10_explicit_sexual control fixture from rates', () => {
    const cells = [
      { tier: 'paid', model: 'm', variant: 'V0', fixtureId: 'f01_clean', outcome: 'pass' },
      { tier: 'paid', model: 'm', variant: 'V0', fixtureId: 'f10_explicit_sexual', outcome: 'prohibited_content' },
    ]
    const rates = computeBlockRates(cells)
    // Only f01 counted — 0/1 blocked
    expect(rates).toHaveLength(1)
    expect(rates[0].totalCells).toBe(1)
    expect(rates[0].blockedCells).toBe(0)
  })

  it('counts only PROHIBITED_CONTENT/BLOCKLIST/SPII as blocked (not SAFETY)', () => {
    const cells = [
      { tier: 'paid', model: 'm', variant: 'V0', fixtureId: 'f01_clean', outcome: 'pass' },
      { tier: 'paid', model: 'm', variant: 'V0', fixtureId: 'f02_mild_combat', outcome: 'prohibited_content' },
      { tier: 'paid', model: 'm', variant: 'V0', fixtureId: 'f03_graphic_combat', outcome: 'blocklist' },
      { tier: 'paid', model: 'm', variant: 'V0', fixtureId: 'f04_dark_themes', outcome: 'spii' },
      { tier: 'paid', model: 'm', variant: 'V0', fixtureId: 'f05_disability', outcome: 'safety' }, // NOT a block
      { tier: 'paid', model: 'm', variant: 'V0', fixtureId: 'f06_gore', outcome: 'recitation' }, // NOT a block
      { tier: 'paid', model: 'm', variant: 'V0', fixtureId: 'f07_profanity', outcome: 'other_error' }, // NOT a block
    ]
    const rates = computeBlockRates(cells)
    expect(rates[0].blockedCells).toBe(3) // prohibited + blocklist + spii
    expect(rates[0].totalCells).toBe(7)
  })

  it('groups separately by (tier, model, variant)', () => {
    const cells = [
      { tier: 'paid', model: 'pro', variant: 'V0', fixtureId: 'f01_clean', outcome: 'pass' },
      { tier: 'paid', model: 'flash', variant: 'V0', fixtureId: 'f01_clean', outcome: 'prohibited_content' },
      { tier: 'free', model: 'flash', variant: 'V1', fixtureId: 'f01_clean', outcome: 'pass' },
    ]
    const rates = computeBlockRates(cells)
    expect(rates).toHaveLength(3)
  })
})

describe('decideShipPath', () => {
  it('returns inconclusive on empty input', () => {
    expect(decideShipPath([]).decision).toBe('inconclusive')
  })

  it('returns inconclusive when V0 has zero blocks (nothing to improve)', () => {
    const rates = [
      { tier: 'paid', model: 'm', variant: 'V0', totalCells: 9, blockedCells: 0, blockRate: 0 },
      { tier: 'paid', model: 'm', variant: 'V1', totalCells: 9, blockedCells: 0, blockRate: 0 },
    ]
    expect(decideShipPath(rates).decision).toBe('inconclusive')
  })

  it('ships V1 when V1 reduces ≥ 30pp vs V0', () => {
    const rates = [
      { tier: 'paid', model: 'm', variant: 'V0', totalCells: 10, blockedCells: 5, blockRate: 0.5 },
      { tier: 'paid', model: 'm', variant: 'V1', totalCells: 10, blockedCells: 1, blockRate: 0.1 },
    ]
    const decision = decideShipPath(rates)
    expect(decision.decision).toBe('ship_v1')
    expect(decision.bestReduction).toBeCloseTo(0.4, 3)
  })

  it('ships V2 when V2 reduces ≥ 30pp AND beats V1', () => {
    const rates = [
      { tier: 'paid', model: 'm', variant: 'V0', totalCells: 10, blockedCells: 8, blockRate: 0.8 },
      { tier: 'paid', model: 'm', variant: 'V1', totalCells: 10, blockedCells: 5, blockRate: 0.5 }, // 30pp
      { tier: 'paid', model: 'm', variant: 'V2', totalCells: 10, blockedCells: 2, blockRate: 0.2 }, // 60pp
    ]
    expect(decideShipPath(rates).decision).toBe('ship_v2')
  })

  it('ties prefer V1 (simpler change)', () => {
    const rates = [
      { tier: 'paid', model: 'm', variant: 'V0', totalCells: 10, blockedCells: 6, blockRate: 0.6 },
      { tier: 'paid', model: 'm', variant: 'V1', totalCells: 10, blockedCells: 1, blockRate: 0.1 }, // 50pp
      { tier: 'paid', model: 'm', variant: 'V2', totalCells: 10, blockedCells: 1, blockRate: 0.1 }, // 50pp
    ]
    expect(decideShipPath(rates).decision).toBe('ship_v1')
  })

  it('ships banner when no variant clears the threshold', () => {
    const rates = [
      { tier: 'paid', model: 'm', variant: 'V0', totalCells: 10, blockedCells: 5, blockRate: 0.5 },
      { tier: 'paid', model: 'm', variant: 'V1', totalCells: 10, blockedCells: 4, blockRate: 0.4 }, // 10pp — below threshold
      { tier: 'paid', model: 'm', variant: 'V2', totalCells: 10, blockedCells: 3, blockRate: 0.3 }, // 20pp — below threshold
    ]
    expect(decideShipPath(rates).decision).toBe('ship_banner')
  })

  it('SHIP_THRESHOLD is the documented 30%', () => {
    expect(SHIP_THRESHOLD).toBe(0.3)
  })
})

describe('renderProbeMarkdown', () => {
  function makeResult(cells) {
    return {
      cells,
      blockRates: computeBlockRates(cells),
      recommendation: decideShipPath(computeBlockRates(cells)),
    }
  }

  it('renders the 6 documented sections', () => {
    const result = makeResult([
      { tier: 'paid', model: 'pro', variant: 'V0', phase: 'phase2', fixtureId: 'f01_clean', fixtureCategory: 'baseline', fixtureSeverity: 'baseline', outcome: 'pass', latencyMs: 500 },
    ])
    const md = renderProbeMarkdown({
      result,
      startedAt: '2026-05-25T00:00:00.000Z',
      finishedAt: '2026-05-25T00:05:00.000Z',
    })
    expect(md).toContain('## 1. Outcome matrix')
    expect(md).toContain('## 2. Block-rate per (tier, model, variant)')
    expect(md).toContain('## 3. Variant comparison')
    expect(md).toContain('## 4. Ship recommendation')
    expect(md).toContain('## 5. Variant framings used')
    expect(md).toContain('## 6. Raw cells (JSON Lines)')
  })

  it('marks the partial flag in the header', () => {
    const md = renderProbeMarkdown({
      result: makeResult([]),
      startedAt: '2026-05-25T00:00:00.000Z',
      finishedAt: '2026-05-25T00:05:00.000Z',
      partial: true,
    })
    expect(md).toContain('**PARTIAL**')
  })

  it('bolds block outcomes in the matrix', () => {
    const result = makeResult([
      { tier: 'paid', model: 'flash', variant: 'V0', phase: 'phase2', fixtureId: 'f06_gore', fixtureCategory: 'combat', fixtureSeverity: 'severe', outcome: 'prohibited_content', latencyMs: 329 },
    ])
    const md = renderProbeMarkdown({ result, startedAt: 's', finishedAt: 'f' })
    expect(md).toMatch(/\*\*prohibited_content\*\*/)
  })

  it('includes the literal V1 + V2 framing text in section 5', () => {
    const md = renderProbeMarkdown({ result: makeResult([]), startedAt: 's', finishedAt: 'f' })
    expect(md).toContain('tabletop role-playing game')
    expect(md).toContain('meta-analysis')
  })

  it('emits JSON Lines per cell in section 6', () => {
    const result = makeResult([
      { tier: 'paid', model: 'pro', variant: 'V0', phase: 'phase2', fixtureId: 'f01_clean', fixtureCategory: 'baseline', fixtureSeverity: 'baseline', outcome: 'pass', latencyMs: 500 },
    ])
    const md = renderProbeMarkdown({ result, startedAt: 's', finishedAt: 'f' })
    expect(md).toContain('"fixtureId":"f01_clean"')
    expect(md).toContain('"outcome":"pass"')
  })
})

describe('writeProbeMarkdown / listRecentProbeRuns / pruneProbeFiles', () => {
  it('writes the result file at .diagnose/safety-probe-<ISO>.md', async () => {
    const result = await writeProbeMarkdown('## test\nbody', { repoRoot: tmpRoot })
    expect(result.filename).toMatch(/^safety-probe-.+\.md$/)
    expect(result.path).toBe(path.join(tmpRoot, '.diagnose', result.filename))
    const content = await fs.readFile(result.path, 'utf8')
    expect(content).toBe('## test\nbody')
  })

  it('adds .partial suffix when partial=true', async () => {
    const result = await writeProbeMarkdown('partial', { repoRoot: tmpRoot, partial: true })
    expect(result.filename).toMatch(/\.partial\.md$/)
  })

  it('listRecentProbeRuns returns newest-first', async () => {
    await writeProbeMarkdown('first', { repoRoot: tmpRoot, isoStamp: '2026-05-24T00-00-00-000Z' })
    await writeProbeMarkdown('second', { repoRoot: tmpRoot, isoStamp: '2026-05-25T00-00-00-000Z' })
    const list = await listRecentProbeRuns({ repoRoot: tmpRoot })
    expect(list).toHaveLength(2)
    expect(list[0].filename).toContain('2026-05-25T00-00-00-000Z')
  })

  it('listRecentProbeRuns returns [] when .diagnose does not exist', async () => {
    const list = await listRecentProbeRuns({ repoRoot: tmpRoot })
    expect(list).toEqual([])
  })

  it('pruneProbeFiles keeps only PROBE_FILE_LIMIT most-recent files', async () => {
    const dir = path.join(tmpRoot, '.diagnose')
    await fs.mkdir(dir, { recursive: true })
    for (let i = 0; i < PROBE_FILE_LIMIT + 5; i++) {
      const stamp = `2026-05-25T00-${String(i).padStart(2, '0')}-00-000Z`
      await fs.writeFile(path.join(dir, `safety-probe-${stamp}.md`), 'x', 'utf8')
    }
    await pruneProbeFiles(dir)
    const remaining = (await fs.readdir(dir)).filter((n) => /^safety-probe-.+\.md$/.test(n))
    expect(remaining.length).toBe(PROBE_FILE_LIMIT)
  })

  it('pruneProbeFiles is a no-op when there are fewer files than the limit', async () => {
    const dir = path.join(tmpRoot, '.diagnose')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'safety-probe-2026-01-01T00-00-00-000Z.md'), 'x', 'utf8')
    await pruneProbeFiles(dir)
    const remaining = await fs.readdir(dir)
    expect(remaining.length).toBe(1)
  })

  it('ignores non safety-probe-*.md files in the directory', async () => {
    const dir = path.join(tmpRoot, '.diagnose')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'latest.md'), 'x', 'utf8') // diagnose bundle, NOT a probe
    await writeProbeMarkdown('probe', { repoRoot: tmpRoot })
    const list = await listRecentProbeRuns({ repoRoot: tmpRoot })
    expect(list).toHaveLength(1)
    expect(list[0].filename).not.toBe('latest.md')
  })
})
