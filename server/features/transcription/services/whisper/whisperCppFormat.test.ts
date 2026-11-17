// Tests for the whisper.cpp → internal-format translation.
//
// This is the part of the bring-your-own-binary bridge that can be verified
// without the binary, which is exactly why the translation is a pure function.
// The fixtures below mirror the real `--output-json-full` shape.

import { describe, expect, it } from 'vitest'
import { parseBackends, parseWhisperCppJson } from './whisperCppFormat.js'

/** A cut-down but structurally faithful --output-json-full document. */
const sample = JSON.stringify({
  systeminfo: 'n_threads = 4 | AVX = 1 | F16C = 1 | VULKAN = 1 | BLAS = 1 | CUDA = 0',
  result: { language: 'en' },
  transcription: [
    {
      text: ' The rogue kicked the door.',
      offsets: { from: 0, to: 2200 },
      tokens: [
        { text: '[_BEG_]', offsets: { from: 0, to: 0 }, p: 0.9 },
        { text: ' The', offsets: { from: 0, to: 300 }, p: 0.98 },
        { text: ' rogue', offsets: { from: 300, to: 800 }, p: 0.95 },
        { text: ' kick', offsets: { from: 800, to: 1200 }, p: 0.9 },
        { text: 'ed', offsets: { from: 1200, to: 1400 }, p: 0.8 },
        { text: ' the', offsets: { from: 1400, to: 1700 }, p: 0.99 },
        { text: ' door', offsets: { from: 1700, to: 2100 }, p: 0.97 },
        { text: '.', offsets: { from: 2100, to: 2200 }, p: 0.6 },
      ],
    },
    {
      text: ' It did not go well.',
      offsets: { from: 2500, to: 4000 },
      tokens: [
        { text: ' It', offsets: { from: 2500, to: 2800 }, p: 0.99 },
        { text: ' did', offsets: { from: 2800, to: 3100 }, p: 0.97 },
        { text: ' not', offsets: { from: 3100, to: 3400 }, p: 0.96 },
        { text: ' go', offsets: { from: 3400, to: 3700 }, p: 0.98 },
        { text: ' well', offsets: { from: 3700, to: 4000 }, p: 0.94 },
      ],
    },
  ],
})

describe('parseWhisperCppJson', () => {
  it('produces the same segment shape as the faster-whisper sidecar', () => {
    const { segments, durationMs, language } = parseWhisperCppJson(sample)
    expect(segments).toHaveLength(2)
    expect(language).toBe('en')
    expect(durationMs).toBe(4000)
    expect(segments[0]).toMatchObject({ startMs: 0, endMs: 2200, text: 'The rogue kicked the door.' })
  })

  it('merges sub-word tokens into whole words', () => {
    // " kick" + "ed" is ONE word. Emitting tokens directly would roughly
    // double the word count and break liveQueue's silence-gap segmentation.
    const { segments } = parseWhisperCppJson(sample)
    const words = segments[0].words.map((w) => w.text)
    expect(words).toEqual(['The', 'rogue', 'kicked', 'the', 'door.'])
  })

  it('spans a merged word from the first token start to the last token end', () => {
    const { segments } = parseWhisperCppJson(sample)
    const kicked = segments[0].words.find((w) => w.text === 'kicked')!
    expect(kicked.startMs).toBe(800)
    expect(kicked.endMs).toBe(1400)
  })

  it('drops whisper.cpp special tokens rather than turning them into words', () => {
    const { segments } = parseWhisperCppJson(sample)
    expect(segments[0].words.some((w) => w.text.includes('[_BEG_]'))).toBe(false)
  })

  it('averages token probabilities into a confidence', () => {
    const { segments } = parseWhisperCppJson(sample)
    expect(segments[0].confidence).toBeGreaterThan(0)
    expect(segments[0].confidence).toBeLessThanOrEqual(1)
    expect(segments[0].words[0].confidence).toBeCloseTo(0.98, 5)
  })

  it('skips segments that are empty after trimming', () => {
    const doc = JSON.stringify({
      result: { language: 'en' },
      transcription: [
        { text: '   ', offsets: { from: 0, to: 100 }, tokens: [] },
        { text: ' real', offsets: { from: 100, to: 200 }, tokens: [{ text: ' real', offsets: { from: 100, to: 200 }, p: 1 }] },
      ],
    })
    expect(parseWhisperCppJson(doc).segments).toHaveLength(1)
  })

  it('throws rather than returning an empty transcript on bad input', () => {
    // A silent empty result reads as "the session had no speech", which is a
    // much more confusing failure than an error.
    expect(() => parseWhisperCppJson('not json')).toThrow(/valid JSON/i)
    expect(() => parseWhisperCppJson('{"result":{}}')).toThrow(/transcription/i)
  })

  it('survives a document with no token data at all', () => {
    // Plain --output-json (not -full) has no tokens. Segments should still
    // come through; only word timings are lost.
    const doc = JSON.stringify({
      result: { language: 'en' },
      transcription: [{ text: ' hello', offsets: { from: 0, to: 500 } }],
    })
    const { segments } = parseWhisperCppJson(doc)
    expect(segments[0].text).toBe('hello')
    expect(segments[0].words).toEqual([])
  })
})

describe('parseBackends', () => {
  it('reports which GPU backends are compiled in', () => {
    const b = parseBackends('n_threads = 4 | AVX = 1 | VULKAN = 1 | BLAS = 1 | CUDA = 0')
    expect(b.vulkan).toBe(true)
    expect(b.cuda).toBe(false)
    expect(b.cpuOnly).toBe(false)
  })

  it('flags an official release build as CPU-only', () => {
    // This is the case the bridge exists to surface: whisper.cpp's own
    // releases ship no Vulkan asset, so someone who downloads one expecting
    // AMD acceleration gets CPU and no explanation.
    const b = parseBackends('n_threads = 8 | AVX = 1 | AVX2 = 1 | F16C = 1 | BLAS = 1 | VULKAN = 0 | CUDA = 0')
    expect(b.cpuOnly).toBe(true)
    expect(b.blas).toBe(true)
  })

  it('does not count BLAS as GPU acceleration', () => {
    // BLAS is a CPU maths library. Treating it as a GPU backend would tell
    // an AMD user they were accelerated when they were not.
    expect(parseBackends('BLAS = 1').cpuOnly).toBe(true)
  })

  it('recognises CUDA under either spelling', () => {
    expect(parseBackends('CUDA = 1').cuda).toBe(true)
    expect(parseBackends('CUBLAS = 1').cuda).toBe(true)
  })

  it('handles Apple builds', () => {
    const b = parseBackends('METAL = 1 | COREML = 1')
    expect(b.metal).toBe(true)
    expect(b.coreml).toBe(true)
    expect(b.cpuOnly).toBe(false)
  })

  it('tolerates an empty or missing systeminfo line', () => {
    const b = parseBackends('')
    expect(b.cpuOnly).toBe(true)
    expect(b.raw).toBe('')
  })
})
