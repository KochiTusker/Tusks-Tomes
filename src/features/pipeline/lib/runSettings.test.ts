// Guards the contract of the shared run-settings read.
//
// The fallback is the part worth pinning. A run that cannot reach the settings
// endpoint must behave like a fresh install — every optional feature off — and
// must not throw, because the alternative is a run that fails at the point the
// user pressed the button rather than one that runs with defaults.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchRunSettings } from './runSettings'

const ALL_OFF = {
  disableThinkingOnGrounding: false,
  phase1AliasHints: false,
  reassembleQuotes: false,
  retrieveVaultKb: false,
  perPhaseThinking: {},
  devTestMode: { enabled: false, maxChars: 24000 },
}

function respondWith(body: unknown, ok = true) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok, json: async () => body })),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchRunSettings', () => {
  it('reads the settings the pipeline acts on', async () => {
    respondWith({
      retrieveVaultKb: true,
      reassembleQuotes: true,
      perPhaseThinking: { phase4: true },
      devTestMode: { enabled: true, maxChars: 5000 },
    })

    const s = await fetchRunSettings()
    expect(s.retrieveVaultKb).toBe(true)
    expect(s.reassembleQuotes).toBe(true)
    expect(s.perPhaseThinking).toEqual({ phase4: true })
    expect(s.devTestMode).toEqual({ enabled: true, maxChars: 5000 })
  })

  it('treats anything but a literal true as off', async () => {
    // The server is the schema authority, but a stale or hand-edited
    // settings.json can carry a truthy non-boolean. Coerce rather than trust.
    respondWith({ retrieveVaultKb: 'yes', reassembleQuotes: 1 })

    const s = await fetchRunSettings()
    expect(s.retrieveVaultKb).toBe(false)
    expect(s.reassembleQuotes).toBe(false)
  })

  it('falls back to everything off when the request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      }),
    )

    await expect(fetchRunSettings()).resolves.toEqual(ALL_OFF)
  })

  it('falls back to everything off on a non-ok response', async () => {
    respondWith({ retrieveVaultKb: true }, false)

    await expect(fetchRunSettings()).resolves.toEqual(ALL_OFF)
  })

  it('supplies the default dev-mode char cap when the field is absent', async () => {
    respondWith({})

    const s = await fetchRunSettings()
    expect(s.devTestMode).toEqual({ enabled: false, maxChars: 24000 })
  })
})
