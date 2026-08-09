// K.2.1 / B3 prove tests — provider pacing helper.
//
// The bug pre-K.2.1: the Free→Paid escalation branches at
// pipeline.ts:506 and pipeline.ts:756 called paidProvider.generate
// immediately, bypassing paidProvider.getNextDelayMs(). The pacing
// helper here is the extracted, unit-testable version of the
// "delay = getNextDelayMs(); sleep(delay)" pattern that already lives
// at chunkedGenerate's primary call site (pipeline.ts:380-403).
//
// These tests pin the contract: given a provider with a known delay
// and a request of known size, computePacingDelay returns the right
// number. Wiring it into the two escalation branches lands in the
// K.2.1 fix commit.

import { describe, expect, it } from 'vitest'
import { computePacingDelay } from './providerPacing'
import type { GenerateRequest } from './providers/llm'

function makeReq(overrides: Partial<GenerateRequest> = {}): GenerateRequest {
  return {
    systemPrompt: 'sys',
    cacheablePrefix: '',
    userPrompt: 'usr',
    model: 'mock-model',
    maxOutputTokens: 1024,
    ...overrides,
  }
}

describe('computePacingDelay (K.2.1 / B3)', () => {
  it('returns 0 when provider has no getNextDelayMs (local provider)', () => {
    const delay = computePacingDelay({
      req: makeReq(),
      provider: {}, // no getNextDelayMs
    })
    expect(delay).toBe(0)
  })

  it('returns 0 when skip=true (caller already paid the delay)', () => {
    const delay = computePacingDelay({
      req: makeReq(),
      provider: { getNextDelayMs: () => 5000 },
      skip: true,
    })
    expect(delay).toBe(0)
  })

  it('returns the provider-reported delay when positive', () => {
    const delay = computePacingDelay({
      req: makeReq(),
      provider: { getNextDelayMs: () => 5000 },
    })
    expect(delay).toBe(5000)
  })

  it('returns 0 when provider returns 0 (no wait needed)', () => {
    const delay = computePacingDelay({
      req: makeReq(),
      provider: { getNextDelayMs: () => 0 },
    })
    expect(delay).toBe(0)
  })

  it('clamps negative or NaN delays to 0 (defensive)', () => {
    expect(computePacingDelay({ req: makeReq(), provider: { getNextDelayMs: () => -100 } })).toBe(0)
    expect(computePacingDelay({ req: makeReq(), provider: { getNextDelayMs: () => NaN } })).toBe(0)
    expect(computePacingDelay({ req: makeReq(), provider: { getNextDelayMs: () => Infinity } })).toBe(0)
  })

  it('passes the estimated input tokens to the provider', () => {
    let capturedTokens = -1
    const longPrompt = 'x'.repeat(4000) // ~1000 tokens at 4 chars/token
    computePacingDelay({
      req: makeReq({ userPrompt: longPrompt }),
      provider: {
        getNextDelayMs: (tokens) => {
          capturedTokens = tokens
          return 0
        },
      },
    })
    // The estimateTokensFromChars(promptChars) helper rounds to ~chars/4.
    // Just assert it received SOMETHING in the right ballpark — exact
    // value depends on rateLimit.ts's heuristic.
    expect(capturedTokens).toBeGreaterThan(500)
    expect(capturedTokens).toBeLessThan(2000)
  })

  it('passes the safety multiplier to the provider (static)', () => {
    let capturedMult = -1
    computePacingDelay({
      req: makeReq(),
      provider: {
        getNextDelayMs: (_t, mult) => {
          capturedMult = mult ?? -1
          return 0
        },
      },
      safetyMultiplier: 2.5,
    })
    expect(capturedMult).toBe(2.5)
  })

  it('resolves a function-valued safety multiplier at call time', () => {
    let capturedMult = -1
    computePacingDelay({
      req: makeReq(),
      provider: {
        getNextDelayMs: (_t, mult) => {
          capturedMult = mult ?? -1
          return 0
        },
      },
      safetyMultiplier: () => 3.0,
    })
    expect(capturedMult).toBe(3.0)
  })

  it('defaults the multiplier to 1 when not supplied', () => {
    let capturedMult = -1
    computePacingDelay({
      req: makeReq(),
      provider: {
        getNextDelayMs: (_t, mult) => {
          capturedMult = mult ?? -1
          return 0
        },
      },
    })
    expect(capturedMult).toBe(1)
  })

  it('sums prompt sizes from system + cacheablePrefix + userPrompt', () => {
    let capturedTokens = -1
    computePacingDelay({
      req: makeReq({
        systemPrompt: 'a'.repeat(400),
        cacheablePrefix: 'b'.repeat(800),
        userPrompt: 'c'.repeat(200),
      }),
      provider: {
        getNextDelayMs: (tokens) => {
          capturedTokens = tokens
          return 0
        },
      },
    })
    // 400+800+200 = 1400 chars; estimateTokensFromChars(1400) is roughly 350.
    expect(capturedTokens).toBeGreaterThan(200)
    expect(capturedTokens).toBeLessThan(500)
  })
})

// ─── Escalation-path proof: paid provider's getNextDelayMs IS consulted ──
//
// The K.2.1 fix wires computePacingDelay into the two escalation branches
// in pipeline.ts. These integration-style tests use MockProvider to
// observe that the paid provider's pacing call fires — exactly the gap
// the plan's "B3" finding identified.

import { MockProvider, mockResponse } from './providers/mockProvider'

describe('K.2.1 escalation pacing — paid provider receives a pacing call', () => {
  it('paid mock records getNextDelayMs invocations when computePacingDelay runs', () => {
    const paid = new MockProvider({ name: 'gemini', nextDelayMs: 5000 })
    const delay = computePacingDelay({
      req: makeReq({ userPrompt: 'hello world' }),
      provider: paid,
      safetyMultiplier: 1.5,
    })
    expect(delay).toBe(5000)
    expect(paid.delayCallsReceived).toHaveLength(1)
    expect(paid.delayCallsReceived[0]).toMatchObject({
      extraMultiplier: 1.5,
      returnedMs: 5000,
    })
  })

  it('a dynamic delay function on paid is invoked with the right token estimate', () => {
    const paid = new MockProvider({
      name: 'gemini',
      nextDelayMs: (tokens) => (tokens > 100 ? 7000 : 1000),
    })
    computePacingDelay({
      req: makeReq({ userPrompt: 'x'.repeat(1000) }),
      provider: paid,
    })
    expect(paid.delayCallsReceived).toHaveLength(1)
    expect(paid.delayCallsReceived[0].returnedMs).toBe(7000)
  })
})
