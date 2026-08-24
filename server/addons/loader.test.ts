import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddonDefinition } from './registry'
import type { AddonsConfig } from './loader'

const REGISTRY: AddonDefinition[] = []
let CONFIG: AddonsConfig = {}

vi.mock('./registry.js', () => ({
  get ADDON_REGISTRY() {
    return REGISTRY
  },
}))

// Tests must not touch the real {configDir}/addons.json. Mock the appData
// helpers so reads/writes operate on an in-memory object.
vi.mock('../appData.js', () => ({
  addonsFile: () => '/test/addons.json',
  readJson: vi.fn(async () => CONFIG),
  writeJson: vi.fn(async (_path: string, value: unknown) => {
    CONFIG = value as AddonsConfig
  }),
}))

type InstallAddon = Extract<AddonDefinition, { kind: 'install' }>

/** Install-kind fixture — the kind with a lifecycle, which is what these
 *  loader tests exercise (isReady gating, configEnabled gating). */
function makeAddon(overrides: Partial<InstallAddon> & { name: string }): AddonDefinition {
  return {
    kind: 'install',
    name: overrides.name,
    displayName: overrides.displayName ?? overrides.name,
    description: overrides.description ?? '',
    wip: overrides.wip ?? false,
    isReady: overrides.isReady ?? (async () => true),
    install: overrides.install ?? (async () => 0),
    uninstall: overrides.uninstall ?? (async () => {}),
    registerRoutes: overrides.registerRoutes ?? (() => {}),
  }
}

/** Builtin fixture — no lifecycle at all. */
function makeBuiltin(
  name: string,
  registerRoutes: AddonDefinition['registerRoutes'] = () => {},
): AddonDefinition {
  return {
    kind: 'builtin',
    name,
    displayName: name,
    description: '',
    wip: false,
    registerRoutes,
  }
}

describe('loadAddons', () => {
  beforeEach(() => {
    REGISTRY.length = 0
    CONFIG = {}
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('mounts routes and lists ready add-ons', async () => {
    const registerRoutes = vi.fn()
    REGISTRY.push(makeAddon({ name: 'healthy', registerRoutes }))
    const { loadAddons, isAddonLoaded } = await import('./loader')

    const fakeApp = {} as Parameters<typeof loadAddons>[0]
    const active = await loadAddons(fakeApp)

    expect(active).toEqual(['healthy'])
    expect(registerRoutes).toHaveBeenCalledWith(fakeApp)
    expect(isAddonLoaded('healthy')).toBe(true)
    expect(isAddonLoaded('unknown')).toBe(false)
  })

  it('skips add-ons whose isReady returns false', async () => {
    REGISTRY.push(makeAddon({ name: 'not-ready', isReady: async () => false }))
    const { loadAddons, isAddonLoaded } = await import('./loader')

    const active = await loadAddons({} as Parameters<typeof loadAddons>[0])

    expect(active).toEqual([])
    expect(isAddonLoaded('not-ready')).toBe(false)
  })

  it('does not throw when isReady throws, and continues with healthy add-ons', async () => {
    const healthyRegister = vi.fn()
    REGISTRY.push(
      makeAddon({
        name: 'bad-isready',
        isReady: async () => { throw new Error('isReady boom') },
      }),
      makeAddon({ name: 'healthy', registerRoutes: healthyRegister }),
    )
    const { loadAddons, isAddonLoaded } = await import('./loader')

    const active = await loadAddons({} as Parameters<typeof loadAddons>[0])

    expect(active).toEqual(['healthy'])
    expect(healthyRegister).toHaveBeenCalled()
    expect(isAddonLoaded('bad-isready')).toBe(false)
    expect(isAddonLoaded('healthy')).toBe(true)
  })

  it('does not throw when registerRoutes throws, and skips the broken add-on', async () => {
    const healthyRegister = vi.fn()
    REGISTRY.push(
      makeAddon({
        name: 'bad-register',
        registerRoutes: () => { throw new Error('register boom') },
      }),
      makeAddon({ name: 'healthy', registerRoutes: healthyRegister }),
    )
    const { loadAddons, isAddonLoaded } = await import('./loader')

    const active = await loadAddons({} as Parameters<typeof loadAddons>[0])

    expect(active).toEqual(['healthy'])
    expect(healthyRegister).toHaveBeenCalled()
    expect(isAddonLoaded('bad-register')).toBe(false)
  })

  it('clears previously-loaded add-ons when called again', async () => {
    REGISTRY.push(makeAddon({ name: 'first' }))
    const { loadAddons, isAddonLoaded } = await import('./loader')

    await loadAddons({} as Parameters<typeof loadAddons>[0])
    expect(isAddonLoaded('first')).toBe(true)

    REGISTRY.length = 0
    REGISTRY.push(makeAddon({ name: 'second' }))
    await loadAddons({} as Parameters<typeof loadAddons>[0])

    expect(isAddonLoaded('first')).toBe(false)
    expect(isAddonLoaded('second')).toBe(true)
  })

  it('skips an add-on when the user has toggled it off via addons.json', async () => {
    const register = vi.fn()
    REGISTRY.push(makeAddon({ name: 'toggled-off', registerRoutes: register }))
    CONFIG = { 'toggled-off': { configEnabled: false } }
    const { loadAddons, isAddonLoaded } = await import('./loader')

    const active = await loadAddons({} as Parameters<typeof loadAddons>[0])

    expect(active).toEqual([])
    expect(register).not.toHaveBeenCalled()
    expect(isAddonLoaded('toggled-off')).toBe(false)
  })

  it('mounts a builtin unconditionally — even when addons.json disables it', async () => {
    const register = vi.fn()
    REGISTRY.push(makeBuiltin('always-on', register))
    // A stale toggle from the add-on era must be ignored, not honoured:
    // builtins have no lifecycle, so there is nothing the toggle could mean.
    CONFIG = { 'always-on': { configEnabled: false } }
    const { loadAddons, isAddonLoaded } = await import('./loader')

    const active = await loadAddons({} as Parameters<typeof loadAddons>[0])

    expect(active).toEqual(['always-on'])
    expect(register).toHaveBeenCalled()
    expect(isAddonLoaded('always-on')).toBe(true)
  })

  it('a builtin that throws in registerRoutes is skipped without masking others', async () => {
    const healthyRegister = vi.fn()
    REGISTRY.push(
      makeBuiltin('bad-builtin', () => {
        throw new Error('route mount exploded')
      }),
      makeBuiltin('healthy-builtin', healthyRegister),
    )
    const { loadAddons, isAddonLoaded } = await import('./loader')

    const active = await loadAddons({} as Parameters<typeof loadAddons>[0])

    expect(active).toEqual(['healthy-builtin'])
    expect(healthyRegister).toHaveBeenCalled()
    expect(isAddonLoaded('bad-builtin')).toBe(false)
  })

  it('treats an unseen name as configEnabled by default', async () => {
    REGISTRY.push(makeAddon({ name: 'unseen' }))
    CONFIG = {} // no entry at all
    const { loadAddons, isAddonLoaded } = await import('./loader')

    await loadAddons({} as Parameters<typeof loadAddons>[0])
    expect(isAddonLoaded('unseen')).toBe(true)
  })

  it('treats an entry with configEnabled: true as enabled', async () => {
    REGISTRY.push(makeAddon({ name: 'on' }))
    CONFIG = { on: { configEnabled: true } }
    const { loadAddons, isAddonLoaded } = await import('./loader')

    await loadAddons({} as Parameters<typeof loadAddons>[0])
    expect(isAddonLoaded('on')).toBe(true)
  })

  // v1.1.0 — corrupted addons.json must NOT silently enable every add-on.
  // Pre-fix bug: a malformed JSON triggered the empty-config fallback,
  // which combined with the unseen-name-defaults-to-enabled rule meant
  // EVERY add-on was treated as enabled. Now: corrupted shape flips the
  // conservative-disabled fallback (zero add-ons loaded) and the
  // corruption signal is exposed via getAddonsConfigCorruption() so
  // the UI can render a clear startup warning.
  it('skips ALL add-ons when addons.json contains a malformed (array) shape', async () => {
    const register = vi.fn()
    REGISTRY.push(makeAddon({ name: 'should-not-load', registerRoutes: register }))
    // Force the mocked readJson to return a top-level array — invalid per
    // the AddonsConfig schema.
    CONFIG = [{ name: 'audio-addon' }] as unknown as AddonsConfig

    const { loadAddons, isAddonLoaded, getAddonsConfigCorruption } = await import('./loader')
    const active = await loadAddons({} as Parameters<typeof loadAddons>[0])

    expect(active).toEqual([])
    expect(register).not.toHaveBeenCalled()
    expect(isAddonLoaded('should-not-load')).toBe(false)
    const corruption = getAddonsConfigCorruption()
    expect(corruption.corrupted).toBe(true)
    expect(corruption.reason).toMatch(/schema/i)
  })

  it('skips ALL add-ons when addons.json has a non-boolean configEnabled value', async () => {
    REGISTRY.push(makeAddon({ name: 'should-not-load' }))
    // Simulates a hand-edit / partial-write that wrote a string instead of bool.
    CONFIG = { 'audio-addon': { configEnabled: 'yes' } } as unknown as AddonsConfig

    const { loadAddons, getAddonsConfigCorruption } = await import('./loader')
    const active = await loadAddons({} as Parameters<typeof loadAddons>[0])

    expect(active).toEqual([])
    expect(getAddonsConfigCorruption().corrupted).toBe(true)
  })

  it('clears the corruption signal on a subsequent clean read', async () => {
    REGISTRY.push(makeAddon({ name: 'cleaner' }))
    // Round 1: corrupt.
    CONFIG = 'malformed' as unknown as AddonsConfig
    const { loadAddons, getAddonsConfigCorruption } = await import('./loader')
    await loadAddons({} as Parameters<typeof loadAddons>[0])
    expect(getAddonsConfigCorruption().corrupted).toBe(true)

    // Round 2: clean.
    CONFIG = { cleaner: { configEnabled: true } }
    await loadAddons({} as Parameters<typeof loadAddons>[0])
    expect(getAddonsConfigCorruption().corrupted).toBe(false)
  })
})

describe('validateAddonsConfig — happy path', () => {
  it('accepts an empty object', async () => {
    const { validateAddonsConfig } = await import('./loader')
    expect(validateAddonsConfig({})).toEqual({})
  })

  it('accepts a single add-on entry with configEnabled true', async () => {
    const { validateAddonsConfig } = await import('./loader')
    const cfg = { 'audio-addon': { configEnabled: true } }
    expect(validateAddonsConfig(cfg)).toEqual(cfg)
  })

  it('accepts a single add-on entry with configEnabled false', async () => {
    const { validateAddonsConfig } = await import('./loader')
    expect(validateAddonsConfig({ 'local-llm-addon': { configEnabled: false } })).toEqual({
      'local-llm-addon': { configEnabled: false },
    })
  })

  it('accepts an entry whose value is an empty object (configEnabled omitted)', async () => {
    const { validateAddonsConfig } = await import('./loader')
    expect(validateAddonsConfig({ 'audio-addon': {} })).toEqual({ 'audio-addon': {} })
  })

  it('accepts multiple add-ons with mixed states', async () => {
    const { validateAddonsConfig } = await import('./loader')
    const cfg = {
      'audio-addon': { configEnabled: true },
      'local-llm-addon': { configEnabled: false },
      'personas-addon': {},
    }
    expect(validateAddonsConfig(cfg)).toEqual(cfg)
  })
})

describe('validateAddonsConfig — rejects malformed shapes', () => {
  it('returns null for a top-level array', async () => {
    const { validateAddonsConfig } = await import('./loader')
    expect(validateAddonsConfig([{ name: 'audio-addon' }])).toBeNull()
  })

  it('returns null for null input', async () => {
    const { validateAddonsConfig } = await import('./loader')
    expect(validateAddonsConfig(null)).toBeNull()
  })

  it('returns null for a string', async () => {
    const { validateAddonsConfig } = await import('./loader')
    expect(validateAddonsConfig('audio-addon=true')).toBeNull()
  })

  it('returns null for a number', async () => {
    const { validateAddonsConfig } = await import('./loader')
    expect(validateAddonsConfig(42)).toBeNull()
  })

  it('returns null when an entry value is itself an array', async () => {
    const { validateAddonsConfig } = await import('./loader')
    expect(validateAddonsConfig({ 'audio-addon': [] })).toBeNull()
  })

  it('returns null when an entry value is a string', async () => {
    const { validateAddonsConfig } = await import('./loader')
    expect(validateAddonsConfig({ 'audio-addon': 'enabled' })).toBeNull()
  })

  it('returns null when configEnabled is a non-boolean value', async () => {
    const { validateAddonsConfig } = await import('./loader')
    expect(validateAddonsConfig({ 'audio-addon': { configEnabled: 'true' } })).toBeNull()
    expect(validateAddonsConfig({ 'audio-addon': { configEnabled: 1 } })).toBeNull()
  })
})
