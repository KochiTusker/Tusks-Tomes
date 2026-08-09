import { describe, expect, it, vi } from 'vitest'
import { MockProvider, mockResponse } from './mockProvider'
import type { GenerateRequest, ProviderEvent } from './llm'

// Sanity tests for the test utility itself. Keeps the contract pinned so
// downstream tests can rely on the documented behaviour.

const REQ: GenerateRequest = {
  systemPrompt: 'sys',
  userPrompt: 'hello',
  model: 'mock-model',
  maxOutputTokens: 100,
}

describe('MockProvider — queue mode', () => {
  it('returns enqueued responses in FIFO order', async () => {
    const p = new MockProvider()
    p.enqueue(mockResponse('first'))
    p.enqueue(mockResponse('second'))
    expect((await p.generate(REQ)).text).toBe('first')
    expect((await p.generate(REQ)).text).toBe('second')
  })

  it('records every call with the request + callIndex', async () => {
    const p = new MockProvider()
    p.enqueueMany([mockResponse('a'), mockResponse('b')])
    await p.generate(REQ)
    await p.generate({ ...REQ, userPrompt: 'world' })
    expect(p.calls.map((c) => c.req.userPrompt)).toEqual(['hello', 'world'])
    expect(p.calls.map((c) => c.callIndex)).toEqual([0, 1])
  })

  it('throws Error instances from the queue (not resolves them)', async () => {
    const p = new MockProvider()
    p.enqueue(new Error('boom'))
    p.enqueue(mockResponse('after-boom'))
    await expect(p.generate(REQ)).rejects.toThrow('boom')
    // Subsequent calls keep working — error consumption is exactly-one.
    expect((await p.generate(REQ)).text).toBe('after-boom')
  })

  it('throws a helpful diagnostic when the queue exhausts mid-test', async () => {
    const p = new MockProvider()
    p.enqueue(mockResponse('only-one'))
    await p.generate(REQ)
    await expect(p.generate(REQ)).rejects.toThrow(/queue exhausted/)
  })

  it('refuses setHandler while queued responses remain', () => {
    const p = new MockProvider()
    p.enqueue(mockResponse('x'))
    expect(() => p.setHandler(() => mockResponse('y'))).toThrow(/queued responses remain/)
  })
})

describe('MockProvider — handler mode', () => {
  it('invokes the handler with request + callIndex', async () => {
    const p = new MockProvider()
    p.setHandler((req, idx) => mockResponse(`call-${idx}-${req.userPrompt}`))
    expect((await p.generate(REQ)).text).toBe('call-0-hello')
    expect((await p.generate({ ...REQ, userPrompt: 'two' })).text).toBe('call-1-two')
  })

  it('supports async handlers', async () => {
    const p = new MockProvider()
    p.setHandler(async (_req, idx) => {
      await Promise.resolve()
      return mockResponse(`async-${idx}`)
    })
    expect((await p.generate(REQ)).text).toBe('async-0')
  })

  it('setHandler(null) clears the handler', async () => {
    const p = new MockProvider()
    p.setHandler(() => mockResponse('handled'))
    p.setHandler(null)
    p.enqueue(mockResponse('queued'))
    expect((await p.generate(REQ)).text).toBe('queued')
  })

  it('refuses enqueue while a handler is set', () => {
    const p = new MockProvider()
    p.setHandler(() => mockResponse('x'))
    expect(() => p.enqueue(mockResponse('y'))).toThrow(/handler is set/)
  })
})

describe('MockProvider — abort signal honoured', () => {
  it('rejects with AbortError when signal is already aborted', async () => {
    const p = new MockProvider()
    p.enqueue(mockResponse('never-returned'))
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(p.generate(REQ, { signal: ctrl.signal })).rejects.toThrow(/aborted/i)
  })
})

describe('MockProvider — getNextDelayMs', () => {
  it('returns the configured static value and records the call', () => {
    const p = new MockProvider({ nextDelayMs: 1500 })
    expect(p.getNextDelayMs(500, 2)).toBe(1500)
    expect(p.delayCallsReceived).toEqual([
      { estimatedInputTokens: 500, extraMultiplier: 2, returnedMs: 1500 },
    ])
  })

  it('accepts a function returning a dynamic value', () => {
    const p = new MockProvider({
      nextDelayMs: (tokens, mult) => tokens * mult,
    })
    expect(p.getNextDelayMs(100, 3)).toBe(300)
    expect(p.getNextDelayMs(50, 1)).toBe(50)
  })

  it('defaults extraMultiplier to 1 when omitted', () => {
    const p = new MockProvider({ nextDelayMs: 999 })
    p.getNextDelayMs(100)
    expect(p.delayCallsReceived[0].extraMultiplier).toBe(1)
  })
})

describe('MockProvider — prefix cache hooks', () => {
  it('records createPrefixCache calls and returns the configured handle', async () => {
    const p = new MockProvider({ prefixCacheHandle: 'h-42' })
    const handle = await p.createPrefixCache!(REQ)
    expect(handle).toBe('h-42')
    expect(p.prefixCacheCreations).toHaveLength(1)
  })

  it('records deletePrefixCache calls', async () => {
    const p = new MockProvider()
    await p.deletePrefixCache!('h-99')
    expect(p.prefixCacheDeletions).toEqual(['h-99'])
  })

  it('omits prefix cache methods when supportsPrefixCache=false', () => {
    const p = new MockProvider({ supportsPrefixCache: false })
    expect(typeof p.createPrefixCache).toBe('undefined')
    expect(typeof p.deletePrefixCache).toBe('undefined')
  })
})

describe('MockProvider — provider events', () => {
  it('fireProviderEvent records the event and forwards to opts.onProviderEvent of the latest call', async () => {
    const p = new MockProvider()
    p.enqueue(mockResponse('x'))
    const onProviderEvent = vi.fn()
    await p.generate(REQ, { onProviderEvent })

    const event: ProviderEvent = {
      kind: 'quota_exhausted',
      provider: 'gemini',
      quotaKind: 'rate_limit',
      tier: 'free',
      model: 'mock-model',
    }
    p.fireProviderEvent(event)
    expect(onProviderEvent).toHaveBeenCalledWith(event)
    expect(p.providerEvents).toEqual([event])
  })
})

describe('MockProvider — reset', () => {
  it('clears all recorded state', async () => {
    const p = new MockProvider()
    p.enqueue(mockResponse('x'))
    await p.generate(REQ)
    expect(p.calls.length).toBe(1)
    p.reset()
    expect(p.calls.length).toBe(0)
    expect(p.delayCallsReceived.length).toBe(0)
    expect(p.providerEvents.length).toBe(0)
  })
})

describe('MockProvider — listModels + estimateCost', () => {
  it('returns the configured model list', async () => {
    const p = new MockProvider({ models: ['m1', 'm2'] })
    expect(await p.listModels()).toEqual(['m1', 'm2'])
  })

  it('returns the configured costPerCall from estimateCost', () => {
    const p = new MockProvider({ costPerCall: 0.42 })
    expect(p.estimateCost({ inputTokens: 100, outputTokens: 50 }, 'm1')).toBe(0.42)
  })
})
