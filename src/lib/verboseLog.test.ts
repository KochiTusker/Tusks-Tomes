/** @vitest-environment jsdom */
// Opt-in diagnostic logger contract:
//   - Ring buffer always fills (regardless of flag) so post-hoc inspection
//     of the last N events is always possible.
//   - Console emit gates on the localStorage flag.
//   - Dumping respects optional category filter + count cap.
//   - window.__tusk handle is installed for DevTools access.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearLog,
  dumpRecentEvents,
  isVerbose,
  setVerbose,
  vlog,
  VERBOSE_CHANGED_EVENT,
} from './verboseLog'

beforeEach(() => {
  // Each test gets a clean slate so ring-buffer assertions are deterministic.
  clearLog()
  setVerbose(false)
  window.localStorage.removeItem('sbts:verbose')
})

afterEach(() => {
  clearLog()
  setVerbose(false)
})

describe('verboseLog — ring buffer always fills', () => {
  it('captures entries via vlog even when verbose is off', () => {
    expect(isVerbose()).toBe(false)
    vlog('pipeline', { type: 'phase_start' })
    vlog('provider', { kind: 'quota_exhausted' })
    const entries = dumpRecentEvents()
    expect(entries).toHaveLength(2)
    expect(entries[0].cat).toBe('pipeline')
    expect(entries[1].cat).toBe('provider')
  })

  it('prints to console only when verbose is on', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vlog('gemini', { hello: 'off' })
    expect(spy).not.toHaveBeenCalled()
    setVerbose(true)
    vlog('gemini', { hello: 'on' })
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })

  it('caps the ring at 500 entries (oldest dropped)', () => {
    for (let i = 0; i < 600; i++) vlog('pipeline', { i })
    const entries = dumpRecentEvents({ count: 9999 })
    expect(entries).toHaveLength(500)
    // The first kept entry should be i=100 (entries 0-99 evicted).
    expect((entries[0].payload as { i: number }).i).toBe(100)
    expect((entries[entries.length - 1].payload as { i: number }).i).toBe(599)
  })
})

describe('verboseLog — dumpRecentEvents filtering', () => {
  it('returns the latest `count` entries when no filter given', () => {
    for (let i = 0; i < 20; i++) vlog('pipeline', { i })
    const last5 = dumpRecentEvents({ count: 5 })
    expect(last5).toHaveLength(5)
    expect((last5[0].payload as { i: number }).i).toBe(15)
    expect((last5[4].payload as { i: number }).i).toBe(19)
  })

  it('filters by category when `cat` is provided', () => {
    vlog('pipeline', { i: 1 })
    vlog('gemini', { i: 2 })
    vlog('pipeline', { i: 3 })
    vlog('routing', { i: 4 })
    const onlyPipeline = dumpRecentEvents({ cat: 'pipeline' })
    expect(onlyPipeline).toHaveLength(2)
    expect(onlyPipeline.every((e) => e.cat === 'pipeline')).toBe(true)
  })

  it('combines count + cat (filter first, then take last N)', () => {
    for (let i = 0; i < 10; i++) {
      vlog('pipeline', { i })
      vlog('gemini', { i })
    }
    const filtered = dumpRecentEvents({ cat: 'gemini', count: 3 })
    expect(filtered).toHaveLength(3)
    expect((filtered[0].payload as { i: number }).i).toBe(7)
    expect((filtered[2].payload as { i: number }).i).toBe(9)
  })
})

describe('verboseLog — flag persistence + change notifications', () => {
  it('setVerbose persists to localStorage', () => {
    setVerbose(true)
    expect(window.localStorage.getItem('sbts:verbose')).toBe('1')
    expect(isVerbose()).toBe(true)
    setVerbose(false)
    expect(window.localStorage.getItem('sbts:verbose')).toBeNull()
    expect(isVerbose()).toBe(false)
  })

  it('setVerbose fires the VERBOSE_CHANGED_EVENT', () => {
    const handler = vi.fn()
    window.addEventListener(VERBOSE_CHANGED_EVENT, handler)
    setVerbose(true)
    expect(handler).toHaveBeenCalledTimes(1)
    setVerbose(false)
    expect(handler).toHaveBeenCalledTimes(2)
    window.removeEventListener(VERBOSE_CHANGED_EVENT, handler)
  })
})

describe('verboseLog — window.__tusk DevTools handle', () => {
  it('installs all expected helpers on window.__tusk', () => {
    const tusk = (window as unknown as {
      __tusk?: Record<string, unknown>
    }).__tusk
    expect(tusk).toBeDefined()
    for (const fn of [
      'setVerbose', 'isVerbose',
      'setTerminalForwarding', 'isTerminalForwarding',
      'setFileLogging', 'isFileLogging',
      'dumpRecentEvents', 'recentFromServer', 'clearLog',
      'sanitizeForForwarding',
    ]) {
      expect(typeof tusk?.[fn]).toBe('function')
    }
  })

  it('window.__tusk.dumpRecentEvents reads the same ring buffer as the module-level dump', () => {
    vlog('routing', { event: 'putRouting' })
    const moduleSide = dumpRecentEvents()
    const windowSide = (window as unknown as {
      __tusk: { dumpRecentEvents: typeof dumpRecentEvents }
    }).__tusk.dumpRecentEvents()
    expect(windowSide).toEqual(moduleSide)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Phase-3 additions: forwarder + sanitizer + new flag behaviour.
// ─────────────────────────────────────────────────────────────────────────────

import {
  isFileLogging,
  isTerminalForwarding,
  sanitizeForForwarding,
  setFileLogging,
  setTerminalForwarding,
  TERMINAL_FORWARDING_CHANGED_EVENT,
  FILE_LOGGING_CHANGED_EVENT,
} from './verboseLog'

describe('verboseLog — sanitizer (defense in depth)', () => {
  it('redacts the documented sensitive field names', () => {
    const sanitized = sanitizeForForwarding({
      event: 'chunk_started',
      // Both values are clearly fake fixtures — the sanitizer redacts by
      // field NAME (apiKey / key), not by value shape, so any string works
      // here. Avoid Google-API-key-shaped placeholders (e.g. starting
      // with `AIza`) so gitleaks doesn't flag this fixture on the public
      // release push.
      apiKey: 'fixture-value-redacted-by-field-name',
      key: 'should-be-redacted',
      prompt: 'long prompt text…',
      userPrompt: 'user side',
      cacheablePrefix: 'system + kb',
      systemPrompt: 'you are a bard',
      rawTranscript: 'whole session',
      groundedTranscript: 'cleaned session',
      model: 'gemini-2.5-pro',
    }) as Record<string, unknown>
    expect(sanitized.apiKey).toBe('[REDACTED]')
    expect(sanitized.key).toBe('[REDACTED]')
    expect(sanitized.prompt).toBe('[REDACTED]')
    expect(sanitized.userPrompt).toBe('[REDACTED]')
    expect(sanitized.cacheablePrefix).toBe('[REDACTED]')
    expect(sanitized.systemPrompt).toBe('[REDACTED]')
    expect(sanitized.rawTranscript).toBe('[REDACTED]')
    expect(sanitized.groundedTranscript).toBe('[REDACTED]')
    // Non-sensitive fields untouched.
    expect(sanitized.event).toBe('chunk_started')
    expect(sanitized.model).toBe('gemini-2.5-pro')
  })

  it('preserves length as <field>_chars: N', () => {
    const sanitized = sanitizeForForwarding({
      userPrompt: 'x'.repeat(500),
    }) as Record<string, unknown>
    expect(sanitized.userPrompt_chars).toBe(500)
  })

  it('recurses into nested objects', () => {
    const sanitized = sanitizeForForwarding({
      req: { apiKey: 'secret', model: 'gemini-2.5-pro' },
      log: 'fine',
    }) as Record<string, unknown>
    const req = sanitized.req as Record<string, unknown>
    expect(req.apiKey).toBe('[REDACTED]')
    expect(req.model).toBe('gemini-2.5-pro')
    expect(sanitized.log).toBe('fine')
  })

  it('walks into arrays', () => {
    const sanitized = sanitizeForForwarding({
      attempts: [{ apiKey: 'a' }, { apiKey: 'b' }],
    }) as Record<string, unknown>
    const attempts = sanitized.attempts as Array<Record<string, unknown>>
    expect(attempts[0].apiKey).toBe('[REDACTED]')
    expect(attempts[1].apiKey).toBe('[REDACTED]')
  })

  it('passes through primitives unchanged', () => {
    expect(sanitizeForForwarding(42)).toBe(42)
    expect(sanitizeForForwarding('hi')).toBe('hi')
    expect(sanitizeForForwarding(null)).toBe(null)
    expect(sanitizeForForwarding(undefined)).toBeUndefined()
    expect(sanitizeForForwarding(true)).toBe(true)
  })
})

describe('verboseLog — terminal / file flag persistence', () => {
  beforeEach(() => {
    window.localStorage.removeItem('sbts:diagnostics-terminal')
    window.localStorage.removeItem('sbts:diagnostics-file')
  })

  it('isTerminalForwarding defaults to false', () => {
    expect(isTerminalForwarding()).toBe(false)
  })

  it('isFileLogging defaults to false', () => {
    expect(isFileLogging()).toBe(false)
  })

  it('setTerminalForwarding persists to localStorage and emits the change event', async () => {
    const handler = vi.fn()
    window.addEventListener(TERMINAL_FORWARDING_CHANGED_EVENT, handler)
    // Stub fetch to prevent actual network calls.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    await setTerminalForwarding(true)
    expect(window.localStorage.getItem('sbts:diagnostics-terminal')).toBe('1')
    expect(handler).toHaveBeenCalled()
    await setTerminalForwarding(false)
    expect(window.localStorage.getItem('sbts:diagnostics-terminal')).toBeNull()
    window.removeEventListener(TERMINAL_FORWARDING_CHANGED_EVENT, handler)
    vi.unstubAllGlobals()
  })

  it('setFileLogging persists + emits its own change event', async () => {
    const handler = vi.fn()
    window.addEventListener(FILE_LOGGING_CHANGED_EVENT, handler)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    await setFileLogging(true)
    expect(window.localStorage.getItem('sbts:diagnostics-file')).toBe('1')
    expect(handler).toHaveBeenCalled()
    window.removeEventListener(FILE_LOGGING_CHANGED_EVENT, handler)
    vi.unstubAllGlobals()
  })

  it('setTerminalForwarding POSTs the new state to /api/diagnostics/config', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await setTerminalForwarding(true)
    expect(fetchMock).toHaveBeenCalled()
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>
    expect(calls[0][0]).toBe('/api/diagnostics/config')
    const init = calls[0][1]
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ terminal: true })
    vi.unstubAllGlobals()
  })
})

describe('verboseLog — forwarder batching', () => {
  beforeEach(() => {
    clearLog()
    window.localStorage.removeItem('sbts:diagnostics-terminal')
    window.localStorage.removeItem('sbts:diagnostics-file')
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('does NOT POST when both forwarding flags are off', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vlog('pipeline', { i: 1 })
    vlog('pipeline', { i: 2 })
    vi.advanceTimersByTime(500)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('debounces rapid events into a single POST when terminal forwarding is on', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    window.localStorage.setItem('sbts:diagnostics-terminal', '1')
    vlog('pipeline', { i: 1 })
    vlog('pipeline', { i: 2 })
    vlog('pipeline', { i: 3 })
    // Before the debounce window elapses — no POST yet.
    expect(fetchMock).not.toHaveBeenCalled()
    vi.advanceTimersByTime(300)
    // Now a single POST with all three entries.
    await vi.runAllTimersAsync()
    const allCalls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>
    const logCalls = allCalls.filter((c) => c[0] === '/api/diagnostics/log')
    expect(logCalls.length).toBeGreaterThanOrEqual(1)
    const body = JSON.parse(logCalls[0][1].body as string)
    expect(body.entries).toHaveLength(3)
  })

  it('sanitizes payloads before forwarding (no raw keys ship to /log)', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    window.localStorage.setItem('sbts:diagnostics-terminal', '1')
    vlog('gemini', { event: 'gen', apiKey: 'AIzaSyABCDEF', userPrompt: 'secret content' })
    vi.advanceTimersByTime(300)
    await vi.runAllTimersAsync()
    const allCalls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>
    const logCalls = allCalls.filter((c) => c[0] === '/api/diagnostics/log')
    const body = JSON.parse(logCalls[0][1].body as string)
    const sentPayload = body.entries[0].payload as Record<string, unknown>
    expect(sentPayload.apiKey).toBe('[REDACTED]')
    expect(sentPayload.userPrompt).toBe('[REDACTED]')
    expect(sentPayload.userPrompt_chars).toBe('secret content'.length)
    // Non-sensitive fields preserved.
    expect(sentPayload.event).toBe('gen')
  })
})
