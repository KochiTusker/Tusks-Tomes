// Test-only LLMProvider implementation. Used across pipeline.integration,
// resumeFlow, fallback, and provider-pacing tests to stub the LLM layer
// without touching real SDKs. Two modes (mutually exclusive per instance):
//
//   1. **Queue mode** (call enqueue()): each generate() call shifts one
//      pre-scripted response off the front. Errors throw; values resolve.
//      Use when the test has a known fixed sequence of N calls.
//
//   2. **Handler mode** (call setHandler()): generate() invokes the supplied
//      function with the request + 0-indexed call number. Use when the
//      response depends on the request (e.g. "return chunk-index as text").
//
// All calls and getNextDelayMs invocations are recorded in `.calls` /
// `.delayCallsReceived` so tests can assert on what the pipeline actually
// asked for. ProviderEvents fired via opts.onProviderEvent are captured.
//
// The mock implements every LLMProvider method including optional ones
// (createPrefixCache, deletePrefixCache, estimateCost) so a test can
// exercise paths that check for their presence with `typeof p.createPrefixCache === 'function'`.

import type {
  GenerateOptions,
  GenerateRequest,
  GenerateResponse,
  LLMProvider,
  ProviderEvent,
  ProviderName,
  Usage,
} from './llm'

/** Shape recorded for every generate() invocation. */
export interface MockProviderCall {
  req: GenerateRequest
  opts: GenerateOptions | undefined
  /** 0-indexed sequence number within this provider instance. */
  callIndex: number
  /** Wall-clock ms at the start of the generate() call. */
  ts: number
}

/** Shape recorded for every getNextDelayMs() invocation. */
export interface MockDelayCall {
  estimatedInputTokens: number
  extraMultiplier: number
  /** What this mock returned. */
  returnedMs: number
}

/** Per-call handler signature for handler mode. */
export type MockHandler = (
  req: GenerateRequest,
  callIndex: number,
  opts: GenerateOptions | undefined,
) => Promise<GenerateResponse> | GenerateResponse

const DEFAULT_USAGE: Usage = { inputTokens: 100, cachedInputTokens: 0, outputTokens: 50 }

/** Convenience builder: makes a GenerateResponse with sensible defaults. */
export function mockResponse(
  text: string,
  usage: Partial<Usage> = {},
): GenerateResponse {
  return {
    text,
    usage: { ...DEFAULT_USAGE, ...usage },
  }
}

export interface MockProviderOptions {
  /** Default name is 'mock'; override to test routing logic that branches on name. */
  name?: ProviderName
  /** Static value (or function) returned by getNextDelayMs. Defaults to 0. */
  nextDelayMs?: number | ((estimatedInputTokens: number, extraMultiplier: number) => number)
  /** What listModels() returns. Defaults to ['mock-model']. */
  models?: string[]
  /** What estimateCost() returns. Defaults to 0. */
  costPerCall?: number
  /** Whether createPrefixCache + deletePrefixCache are present on the
   *  instance (use false to test code paths that detect cache absence). */
  supportsPrefixCache?: boolean
  /** Return value from createPrefixCache. Defaults to a stable 'mock-cache-handle' string;
   *  set to null to test the "couldn't cache" path. */
  prefixCacheHandle?: string | null
}

export class MockProvider implements LLMProvider {
  readonly name: ProviderName

  private queue: Array<GenerateResponse | Error> = []
  private handler: MockHandler | null = null
  private callIndexCounter = 0
  private readonly _calls: MockProviderCall[] = []
  private readonly _delayCallsReceived: MockDelayCall[] = []
  private readonly _providerEvents: ProviderEvent[] = []
  private readonly _prefixCacheCreations: GenerateRequest[] = []
  private readonly _prefixCacheDeletions: string[] = []

  private readonly opts: Required<Omit<MockProviderOptions, 'name'>>

  constructor(options: MockProviderOptions = {}) {
    this.name = options.name ?? 'gemini'  // 'mock' is not a ProviderName; default to gemini for type compat
    this.opts = {
      nextDelayMs: options.nextDelayMs ?? 0,
      models: options.models ?? ['mock-model'],
      costPerCall: options.costPerCall ?? 0,
      supportsPrefixCache: options.supportsPrefixCache ?? true,
      prefixCacheHandle: options.prefixCacheHandle ?? 'mock-cache-handle',
    }

    if (!this.opts.supportsPrefixCache) {
      // Shadow the prototype methods with undefined-typed instance fields
      // so `typeof p.createPrefixCache === 'function'` returns false.
      // `delete` doesn't work — the methods live on the prototype.
      Object.defineProperty(this, 'createPrefixCache', { value: undefined, enumerable: false })
      Object.defineProperty(this, 'deletePrefixCache', { value: undefined, enumerable: false })
    }
  }

  // ───────────────────────── test API ─────────────────────────

  /** Push one scripted response onto the back of the queue. Throw-once
   *  semantics: an Error in the queue rejects the next call only. */
  enqueue(response: GenerateResponse | Error): this {
    if (this.handler) {
      throw new Error('MockProvider: cannot enqueue() while a handler is set. Call setHandler(null) first.')
    }
    this.queue.push(response)
    return this
  }

  /** Bulk-enqueue many responses (often easier than chained enqueue calls). */
  enqueueMany(responses: Array<GenerateResponse | Error>): this {
    for (const r of responses) this.enqueue(r)
    return this
  }

  /** Install a handler function; clears the queue. Pass null to unset. */
  setHandler(handler: MockHandler | null): this {
    if (handler) {
      if (this.queue.length > 0) {
        throw new Error('MockProvider: cannot setHandler() while queued responses remain. Clear the queue first.')
      }
      this.handler = handler
    } else {
      this.handler = null
    }
    return this
  }

  /** Snapshot of every generate() call observed so far. */
  get calls(): readonly MockProviderCall[] {
    return this._calls
  }

  /** Snapshot of every getNextDelayMs() call observed so far. */
  get delayCallsReceived(): readonly MockDelayCall[] {
    return this._delayCallsReceived
  }

  /** Snapshot of every ProviderEvent fired via opts.onProviderEvent. */
  get providerEvents(): readonly ProviderEvent[] {
    return this._providerEvents
  }

  /** Snapshot of every createPrefixCache invocation. */
  get prefixCacheCreations(): readonly GenerateRequest[] {
    return this._prefixCacheCreations
  }

  /** Snapshot of every deletePrefixCache invocation. */
  get prefixCacheDeletions(): readonly string[] {
    return this._prefixCacheDeletions
  }

  /** Reset all recorded state. Useful between sub-tests in a single describe block. */
  reset(): void {
    this.queue.length = 0
    this.handler = null
    this.callIndexCounter = 0
    this._calls.length = 0
    this._delayCallsReceived.length = 0
    this._providerEvents.length = 0
    this._prefixCacheCreations.length = 0
    this._prefixCacheDeletions.length = 0
  }

  // ─────────────────── LLMProvider implementation ───────────────────

  async generate(req: GenerateRequest, opts?: GenerateOptions): Promise<GenerateResponse> {
    const callIndex = this.callIndexCounter++
    this._calls.push({ req, opts, callIndex, ts: Date.now() })

    if (opts?.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }

    if (this.handler) {
      const result = this.handler(req, callIndex, opts)
      return result instanceof Promise ? await result : result
    }

    const next = this.queue.shift()
    if (next === undefined) {
      throw new Error(
        `MockProvider: queue exhausted at call ${callIndex}. ` +
          `Enqueue more responses or install a handler. Last request: ${req.model} / ${req.userPrompt.slice(0, 80)}…`,
      )
    }
    if (next instanceof Error) {
      throw next
    }
    return next
  }

  async listModels(): Promise<string[]> {
    return [...this.opts.models]
  }

  estimateCost(_usage: Usage, _model: string): number {
    return this.opts.costPerCall
  }

  getNextDelayMs(estimatedInputTokens: number, extraMultiplier = 1): number {
    const value =
      typeof this.opts.nextDelayMs === 'function'
        ? this.opts.nextDelayMs(estimatedInputTokens, extraMultiplier)
        : this.opts.nextDelayMs
    this._delayCallsReceived.push({ estimatedInputTokens, extraMultiplier, returnedMs: value })
    return value
  }

  async createPrefixCache(req: GenerateRequest): Promise<string | null> {
    this._prefixCacheCreations.push(req)
    return this.opts.prefixCacheHandle
  }

  async deletePrefixCache(handle: string): Promise<void> {
    this._prefixCacheDeletions.push(handle)
  }

  // ─────────────────── helper for emitting events ───────────────────

  /** Test-side helper: simulate a provider firing a ProviderEvent on the
   *  most-recent generate() call. The pipeline subscribes via
   *  opts.onProviderEvent; this just records the event for assertion
   *  AND invokes the listener so the pipeline reacts. */
  fireProviderEvent(event: ProviderEvent): void {
    this._providerEvents.push(event)
    const lastCall = this._calls[this._calls.length - 1]
    lastCall?.opts?.onProviderEvent?.(event)
  }
}
