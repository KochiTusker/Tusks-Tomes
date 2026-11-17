// Shared harness for the UI characterisation suite (src/App.snapshot*.test.tsx).
//
// Renders the app exactly as src/main.tsx does (AppErrorBoundary > AddonProvider
// > App), against a fetch stub that answers every /api/* request with fixed
// fixtures. A request with no fixture is recorded as unmatched and answered
// 404; each test asserts the unmatched list is empty, so a refactor that adds
// a request without a fixture, or the reverse, is caught.

import { afterAll, vi } from 'vitest'
import { act } from '@testing-library/react'
import { buildRoutes, type Route, type ScenarioOptions } from './fixtures'
import { toastLog } from './sonnerMock'
import { serialize } from './serialize'

// The snapshots were recorded with en-GB formatting (09/03/2026). Under another
// default locale, en-US for one (3/9/2026), an unpadded month runs straight into
// the text before it ("Session 3" + "3/9/2026"), and the date mask in
// serialize.ts swallows the digit. Pin the default locale so every machine
// renders the same text; a call that names a locale still gets that locale.
const GOLDEN_LOCALE = 'en-GB'
const restoreLocale: Array<() => void> = []
type LocaleMethod = (this: unknown, locales?: Intl.LocalesArgument, ...rest: unknown[]) => string
function pinDefaultLocale(proto: object, name: string): void {
  const target = proto as Record<string, LocaleMethod>
  const original = target[name]
  target[name] = function (this: unknown, locales?: Intl.LocalesArgument, ...rest: unknown[]) {
    return original.call(this, locales ?? GOLDEN_LOCALE, ...rest)
  }
  restoreLocale.push(() => { target[name] = original })
}
pinDefaultLocale(Date.prototype, 'toLocaleString')
pinDefaultLocale(Date.prototype, 'toLocaleDateString')
pinDefaultLocale(Date.prototype, 'toLocaleTimeString')
pinDefaultLocale(Number.prototype, 'toLocaleString')
const OriginalDateTimeFormat = Intl.DateTimeFormat
const PinnedDateTimeFormat = function (locales?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
  return new OriginalDateTimeFormat(locales ?? GOLDEN_LOCALE, options)
} as unknown as typeof Intl.DateTimeFormat
Object.defineProperty(PinnedDateTimeFormat, 'prototype', { value: OriginalDateTimeFormat.prototype })
Object.defineProperty(PinnedDateTimeFormat, 'supportedLocalesOf', { value: OriginalDateTimeFormat.supportedLocalesOf })
Intl.DateTimeFormat = PinnedDateTimeFormat
restoreLocale.push(() => { Intl.DateTimeFormat = OriginalDateTimeFormat })
afterAll(() => { for (const restore of restoreLocale.reverse()) restore() })

export type FetchCall = { method: string; path: string; body: unknown }

export type Scenario = {
  opts: ScenarioOptions
  routes: Record<string, Route>
  calls: FetchCall[]
  unmatched: string[]
  consoleErrors: string[]
  inflight: { n: number }
  /** Routes in the fixture table that no request has used yet. */
  unusedRoutes(): string[]
  /** Requests made since the last take(), as sorted unique "METHOD path". */
  take(): string[]
}

let uuidCounter = 0

function installBrowserGaps(): void {
  window.matchMedia = ((q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  class IO {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return []
    }
  }
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO
  ;(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = IO
  Element.prototype.scrollTo = (() => {}) as typeof Element.prototype.scrollTo
  Element.prototype.scrollIntoView = (() => {}) as typeof Element.prototype.scrollIntoView
  window.scrollTo = (() => {}) as typeof window.scrollTo
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
      this.setAttribute('open', '')
    }
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
      this.removeAttribute('open')
    }
  }
  window.confirm = () => true
}

/** Deterministic Math.random / crypto.randomUUID / Date. */
function freezeNondeterminism(): void {
  let seed = 1234567
  vi.spyOn(Math, 'random').mockImplementation(() => {
    seed = (seed * 1664525 + 1013904223) % 4294967296
    return seed / 4294967296
  })
  uuidCounter = 0
  vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => {
    uuidCounter += 1
    return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, '0')}` as `${string}-${string}-${string}-${string}-${string}`
  })
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-02-03T12:00:00.000Z'))
}

export function installScenario(opts: ScenarioOptions): Scenario {
  installBrowserGaps()
  freezeNondeterminism()
  localStorage.clear()
  toastLog.length = 0
  const routes = buildRoutes(opts)
  const calls: FetchCall[] = []
  const unmatched: string[] = []
  const consoleErrors: string[] = []
  const inflight = { n: 0 }
  let taken = 0

  for (const level of ['error', 'warn'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      const text = args
        .map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' ')
        .slice(0, 300)
      consoleErrors.push(`${level}: ${text}`)
    })
  }

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw =
      typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    const url = new URL(raw, 'http://localhost')
    const method = (init?.method ?? 'GET').toUpperCase()
    let body: unknown = undefined
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body)
      } catch {
        body = init.body
      }
    }
    calls.push({ method, path: url.pathname, body })
    const route = routes[`${method} ${url.pathname}`]
    if (!route) {
      unmatched.push(`${method} ${url.pathname}`)
      return new Response(JSON.stringify({ error: 'no fixture' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    inflight.n += 1
    try {
      const status = route.status ?? 200
      if (status === 204 || route.body === null) return new Response(null, { status })
      const payload =
        typeof route.body === 'function'
          ? (route.body as (r: { url: URL; method: string; body: unknown }) => unknown)({ url, method, body })
          : route.body
      if (typeof payload === 'string') {
        return new Response(payload, { status, headers: { 'Content-Type': 'text/plain' } })
      }
      return new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    } finally {
      inflight.n -= 1
    }
  }) as unknown as typeof fetch

  return {
    opts,
    routes,
    calls,
    unmatched,
    consoleErrors,
    inflight,
    unusedRoutes() {
      const used = new Set(calls.map((c) => `${c.method} ${c.path}`))
      return Object.keys(routes).filter((k) => !used.has(k)).sort()
    },
    take() {
      const fresh = calls.slice(taken).map((c) => `${c.method} ${c.path}`)
      taken = calls.length
      return [...new Set(fresh)].sort()
    },
  }
}

/** Let effects, fetches and the state updates they cause finish. Loops until
 *  no new request has appeared for two consecutive ticks. */
export async function settle(scenario: Scenario): Promise<void> {
  let stable = 0
  let last = -1
  for (let i = 0; i < 60 && stable < 3; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 15))
    })
    if (scenario.calls.length === last && scenario.inflight.n === 0) stable += 1
    else stable = 0
    last = scenario.calls.length
  }
}

/** Render the app as src/main.tsx does: StrictMode > AppErrorBoundary >
 *  AddonProvider > App, with providers initialised eagerly. Modules are reset
 *  first so per-module caches (personas, lore documents, catalogue...) start
 *  empty for every scenario. */
export async function mountApp(scenario: Scenario) {
  vi.resetModules()
  const React = await import('react')
  const rtl = await import('@testing-library/react')
  const userEvent = (await import('@testing-library/user-event')).default
  const { default: App } = await import('@/App')
  const { AppErrorBoundary } = await import('@/platform/components/AppErrorBoundary')
  const { AddonProvider } = await import('@/platform/contexts/AddonContext')
  const { ensureProvidersInitialized } = await import('@/features/providers/lib/providers')
  void ensureProvidersInitialized()
  const user = userEvent.setup()
  const utils = rtl.render(
    <React.StrictMode>
      <AppErrorBoundary>
        <AddonProvider>
          <App />
        </AddonProvider>
      </AppErrorBoundary>
    </React.StrictMode>,
  )
  await settle(scenario)
  return { user, rtl, ...utils }
}

export function snap(el: Element | null, label?: string): string {
  if (!el) return `${label ?? ''}<missing>`
  return serialize(el)
}

export function toastsSeen(): string {
  return toastLog.length ? toastLog.join('\n') : '(none)'
}
