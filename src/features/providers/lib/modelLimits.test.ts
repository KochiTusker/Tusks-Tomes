import { describe, expect, it } from 'vitest'
import { MAX_OUTPUT_TOKENS } from './constants'
import {
  clampMaxOutputTokens,
  inputFitsContext,
  maxChunkCharsForOutputCeiling,
  shouldRetrieveVaultKb,
} from './modelLimits'

describe('clampMaxOutputTokens', () => {
  it('leaves the request alone when the model can take it', () => {
    // gemini-2.5-pro advertises 65,536 — comfortably above our 32,768 default.
    const r = clampMaxOutputTokens(MAX_OUTPUT_TOKENS, 65_536)
    expect(r.tokens).toBe(MAX_OUTPUT_TOKENS)
    expect(r.clamped).toBe(false)
  })

  it('clamps to the model ceiling when ours is higher', () => {
    // glm-4.7-flash and nemotron-3-super-120b both cap at 16,384. Sending
    // 32,768 to them is an invalid request, not a truncated one.
    const r = clampMaxOutputTokens(MAX_OUTPUT_TOKENS, 16_384)
    expect(r.tokens).toBe(16_384)
    expect(r.clamped).toBe(true)
    expect(r.modelCeiling).toBe(16_384)
  })

  it('passes through unchanged when the catalogue declares no ceiling', () => {
    // Guessing a limit here would silently truncate models that have none.
    for (const ceiling of [null, undefined, 0, -1, Number.NaN]) {
      const r = clampMaxOutputTokens(MAX_OUTPUT_TOKENS, ceiling as number | null)
      expect(r.tokens).toBe(MAX_OUTPUT_TOKENS)
      expect(r.clamped).toBe(false)
    }
  })

  it('is a no-op when the ceiling exactly equals the request', () => {
    const r = clampMaxOutputTokens(32_768, 32_768)
    expect(r.tokens).toBe(32_768)
    expect(r.clamped).toBe(false)
  })

  it('reports clamped so callers can surface it rather than silently shrinking', () => {
    // The UI needs to say "this model caps output at 16k" — a silent clamp on a
    // 1:1 phase would look like a truncated chronicle with no explanation.
    expect(clampMaxOutputTokens(32_768, 8_192).clamped).toBe(true)
  })
})

describe('maxChunkCharsForOutputCeiling', () => {
  it('bounds a 1:1 phase so its output stays under the ceiling', () => {
    // Phase 1 emits ~1 output token per input token. At a 16,384 ceiling with
    // 20% head-room that is 13,107 tokens ~= 52,428 chars of input.
    expect(maxChunkCharsForOutputCeiling(16_384, 1.0)).toBe(52_428)
  })

  it('allows much larger chunks when the phase emits little', () => {
    // Phase 2 audit emits ~2% of its input, so the ceiling never binds in
    // practice at any chunk size we use.
    const limit = maxChunkCharsForOutputCeiling(16_384, 0.02)!
    expect(limit).toBeGreaterThan(2_000_000)
  })

  it('returns null when there is no ceiling to respect', () => {
    expect(maxChunkCharsForOutputCeiling(null, 1.0)).toBeNull()
    expect(maxChunkCharsForOutputCeiling(undefined, 1.0)).toBeNull()
    expect(maxChunkCharsForOutputCeiling(0, 1.0)).toBeNull()
  })

  it('returns null for a nonsensical output ratio rather than dividing by zero', () => {
    expect(maxChunkCharsForOutputCeiling(16_384, 0)).toBeNull()
    expect(maxChunkCharsForOutputCeiling(16_384, -1)).toBeNull()
  })

  it('does not bind on the default Phase 1 chunk for a 16k model', () => {
    // The default geminiPaid:flagship p1 chunk is 30,000 chars, which emits
    // ~7,500 tokens — well inside 16,384. So a 16k ceiling is a REQUEST
    // validity problem, not a truncation problem, at today's sizes.
    expect(maxChunkCharsForOutputCeiling(16_384, 1.0)!).toBeGreaterThan(30_000)
  })
})

describe('inputFitsContext', () => {
  const P6_CHUNK = 100_000
  const OVERHEAD = 3_790 // Phase 6 static prompt, measured from prompts.ts
  const VAULT = 2_130_000 // reference Obsidian vault
  const RETRIEVED = 176_000 // same vault after retrieveForText, -92%

  it('rejects the full vault on every sub-1M-context model', () => {
    for (const ctx of [131_072, 262_144, 400_000, 512_288]) {
      expect(
        inputFitsContext({
          contextLength: ctx,
          chunkChars: P6_CHUNK,
          kbChars: VAULT,
          overheadChars: OVERHEAD,
        }),
      ).toBe(false)
    }
  })

  it('accepts the full vault on a 1M-context model', () => {
    expect(
      inputFitsContext({
        contextLength: 1_048_576,
        chunkChars: P6_CHUNK,
        kbChars: VAULT,
        overheadChars: OVERHEAD,
      }),
    ).toBe(true)
  })

  it('accepts the RETRIEVED vault everywhere — this is what unlocks cheap models', () => {
    // Retrieval is not a cost optimisation here, it is what makes Phase 6
    // possible at all on a 131k model. The whole vault costs only $0.033 on
    // gpt-oss-120b; it simply cannot be sent.
    for (const ctx of [131_072, 262_144, 400_000, 1_048_576]) {
      expect(
        inputFitsContext({
          contextLength: ctx,
          chunkChars: P6_CHUNK,
          kbChars: RETRIEVED,
          overheadChars: OVERHEAD,
        }),
      ).toBe(true)
    }
  })

  it('accounts for reserved output space', () => {
    // 120k input tokens leaves 11k of a 131k window; asking for 32k out fails.
    const base = {
      contextLength: 131_072,
      chunkChars: 480_000,
      kbChars: 0,
      overheadChars: 0,
    }
    expect(inputFitsContext(base)).toBe(true)
    expect(inputFitsContext({ ...base, expectedOutputTokens: 32_768 })).toBe(false)
  })

  it('treats an unknown context length as permissive rather than blocking', () => {
    // A catalogue row with no declared context should not make a model
    // unusable; the request will fail loudly if it genuinely does not fit.
    expect(
      inputFitsContext({ contextLength: 0, chunkChars: 1e9, kbChars: 1e9, overheadChars: 0 }),
    ).toBe(true)
  })
})

describe('shouldRetrieveVaultKb', () => {
  const VAULT = 2_130_000
  const GLOSSARY = 50_000
  const P6 = { chunkChars: 100_000, overheadChars: 3_790 }

  it('respects an explicit opt-in regardless of whether it would fit', () => {
    const d = shouldRetrieveVaultKb({
      userEnabled: true, kbChars: GLOSSARY, contextLength: 1_048_576, ...P6,
    })
    expect(d).toEqual({ retrieve: true, reason: 'user-enabled' })
  })

  it('auto-enables when the vault cannot fit the window', () => {
    // This is what makes Phase 6 possible on a 131k model at all. The whole
    // vault costs only $0.033 there — it simply cannot be sent.
    const d = shouldRetrieveVaultKb({
      userEnabled: false, kbChars: VAULT, contextLength: 131_072, ...P6,
    })
    expect(d).toEqual({ retrieve: true, reason: 'context-overflow' })
  })

  it('leaves a comfortable setup alone', () => {
    // Someone on Gemini Pro with a typed glossary should see no change they
    // did not ask for.
    const d = shouldRetrieveVaultKb({
      userEnabled: false, kbChars: GLOSSARY, contextLength: 1_048_576, ...P6,
    })
    expect(d).toEqual({ retrieve: false, reason: 'fits' })
  })

  it('does not auto-enable on a 1M model carrying the full vault', () => {
    // It fits, so there is no trade to make.
    const d = shouldRetrieveVaultKb({
      userEnabled: false, kbChars: VAULT, contextLength: 1_048_576, ...P6,
    })
    expect(d.retrieve).toBe(false)
  })

  it('auto-enables the vault on every sub-1M model', () => {
    for (const ctx of [131_072, 262_144, 400_000, 512_288]) {
      const d = shouldRetrieveVaultKb({
        userEnabled: false, kbChars: VAULT, contextLength: ctx, ...P6,
      })
      expect(d.reason).toBe('context-overflow')
    }
  })

  it('does nothing when the context length is unknown', () => {
    // Guessing here would silently change what a run sends. Better to leave
    // the user's setting alone and let a genuine overflow fail loudly.
    const d = shouldRetrieveVaultKb({
      userEnabled: false, kbChars: VAULT, contextLength: null, ...P6,
    })
    expect(d).toEqual({ retrieve: false, reason: 'unknown-context' })
  })
})
