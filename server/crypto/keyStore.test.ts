// Encrypted key-store regression. The keystore's design promises three
// security-relevant properties:
//
//   1. Round-trip: setKey/loadKeys preserves the bundle.
//   2. Tamper-fail-closed: a flipped bit in authTag / ciphertext makes
//      decrypt throw — silently returning empty / garbage would defeat
//      the AES-GCM authenticator.
//   3. Wrong-machine-fail-closed: a document encrypted with one
//      identity (hostname + username + platform) cannot be decrypted
//      under a different identity. THIS is the entire reason for the
//      machine-binding salt — without this guarantee, a copied
//      providers.enc is portable, defeating the obfuscation.
//
// Each test redirects appData's `providersFile()` and `saltFile()` to
// a temp dir per test (via vi.doMock) and resets the keystore module
// between tests so the singleton cache doesn't leak.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

let WORK: string

beforeEach(async () => {
  WORK = await fs.mkdtemp(path.join(tmpdir(), 'keystore-test-'))
  vi.resetModules()
  vi.doMock('../appData.js', async () => {
    const actual = await vi.importActual<typeof import('../appData')>('../appData.js')
    return {
      ...actual,
      providersFile: () => path.join(WORK, 'providers.enc'),
      saltFile: () => path.join(WORK, 'salt'),
      configDir: () => WORK,
      ensureDir: async (p: string) => fs.mkdir(p, { recursive: true }),
    }
  })
  // Clear env-seed inputs so the keystore doesn't migrate from process
  // env into our temp WORK dir on the first loadKeys() call.
  delete process.env.PAID_GEMINI_API_KEY
  delete process.env.VITE_GEMINI_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.OPENAI_API_KEY
})

afterEach(async () => {
  vi.doUnmock('../appData.js')
  vi.resetModules()
  await fs.rm(WORK, { recursive: true, force: true })
})

describe('keystore — round-trip', () => {
  it('setKey then loadKeys returns the same value', async () => {
    const { setKey, loadKeys } = await import('./keyStore.js')
    await setKey('gemini', 'sk-' + 'test-gemini-' + '1234567890')
    const out = await loadKeys()
    expect(out.gemini).toBe('sk-' + 'test-gemini-' + '1234567890')
  })

  it('multiple keys survive round-trip', async () => {
    const { setKey, loadKeys } = await import('./keyStore.js')
    await setKey('gemini', 'g')
    await setKey('claude', 'c')
    await setKey('openai', 'o')
    const out = await loadKeys()
    expect(out).toEqual({ gemini: 'g', claude: 'c', openai: 'o' })
  })

  it('clearKey removes a single entry', async () => {
    const { setKey, clearKey, loadKeys } = await import('./keyStore.js')
    await setKey('gemini', 'g')
    await setKey('claude', 'c')
    await clearKey('gemini')
    const out = await loadKeys()
    expect(out).toEqual({ claude: 'c' })
  })

  it('summarize returns configured keys without values', async () => {
    const { setKey, summarize } = await import('./keyStore.js')
    await setKey('gemini', 'g')
    await setKey('claude', 'c')
    const sum = await summarize()
    expect(sum.configured.sort()).toEqual(['claude', 'gemini'])
  })
})

describe('keystore — tamper-fail-closed', () => {
  it('a flipped bit in authTag makes loadKeys throw', async () => {
    const { setKey } = await import('./keyStore.js')
    await setKey('gemini', 'secret-12345')

    // Mutate the on-disk authTag.
    const file = path.join(WORK, 'providers.enc')
    const doc = JSON.parse(await fs.readFile(file, 'utf-8'))
    const tag = Buffer.from(doc.authTag, 'base64')
    tag[0] ^= 0x01 // flip one bit
    doc.authTag = tag.toString('base64')
    await fs.writeFile(file, JSON.stringify(doc))

    // Re-import to reset the module cache and force re-decrypt.
    vi.resetModules()
    vi.doMock('../appData.js', async () => {
      const actual = await vi.importActual<typeof import('../appData')>('../appData.js')
      return {
        ...actual,
        providersFile: () => file,
        saltFile: () => path.join(WORK, 'salt'),
        configDir: () => WORK,
        ensureDir: async (p: string) => fs.mkdir(p, { recursive: true }),
      }
    })
    const fresh = await import('./keyStore.js')
    await expect(fresh.loadKeys()).rejects.toBeTruthy()
  })

  it('a flipped bit in ciphertext makes loadKeys throw', async () => {
    const { setKey } = await import('./keyStore.js')
    await setKey('gemini', 'secret-12345')

    const file = path.join(WORK, 'providers.enc')
    const doc = JSON.parse(await fs.readFile(file, 'utf-8'))
    const ct = Buffer.from(doc.ciphertext, 'base64')
    ct[0] ^= 0x01
    doc.ciphertext = ct.toString('base64')
    await fs.writeFile(file, JSON.stringify(doc))

    vi.resetModules()
    vi.doMock('../appData.js', async () => {
      const actual = await vi.importActual<typeof import('../appData')>('../appData.js')
      return {
        ...actual,
        providersFile: () => file,
        saltFile: () => path.join(WORK, 'salt'),
        configDir: () => WORK,
        ensureDir: async (p: string) => fs.mkdir(p, { recursive: true }),
      }
    })
    const fresh = await import('./keyStore.js')
    await expect(fresh.loadKeys()).rejects.toBeTruthy()
  })
})

describe('keystore — wrong-machine-fail-closed', () => {
  // The machine-binding claim is the entire point of the salt + scrypt
  // identity derivation. We simulate "different machine" by rotating
  // the salt file between encrypt and decrypt. A real cross-machine
  // attack would also rotate hostname/username, but the salt rotation
  // alone changes the derived key and is sufficient to prove the
  // decrypt fails closed.
  it('a different salt makes loadKeys throw on the existing ciphertext', async () => {
    const { setKey } = await import('./keyStore.js')
    await setKey('gemini', 'secret-12345')

    // Rotate the salt to simulate a different machine.
    const saltPath = path.join(WORK, 'salt')
    const { randomBytes } = await import('node:crypto')
    await fs.writeFile(saltPath, randomBytes(16))

    vi.resetModules()
    vi.doMock('../appData.js', async () => {
      const actual = await vi.importActual<typeof import('../appData')>('../appData.js')
      return {
        ...actual,
        providersFile: () => path.join(WORK, 'providers.enc'),
        saltFile: () => saltPath,
        configDir: () => WORK,
        ensureDir: async (p: string) => fs.mkdir(p, { recursive: true }),
      }
    })
    const fresh = await import('./keyStore.js')
    await expect(fresh.loadKeys()).rejects.toBeTruthy()
  })
})

// ============================================================================
// Phase 3.8 — robustness under unusual on-disk states
// ============================================================================

describe('keystore — missing file', () => {
  it('loadKeys returns an empty bundle when providers.enc does not exist', async () => {
    // Fresh WORK dir from beforeEach — no providers.enc written.
    const { loadKeys } = await import('./keyStore.js')
    const out = await loadKeys()
    // Empty bundle. Specifically no throw — fresh install must succeed.
    expect(typeof out).toBe('object')
    expect(out.gemini).toBeUndefined()
    expect(out.claude).toBeUndefined()
  })

  it('summarize() works on an empty store (does not throw)', async () => {
    const { summarize } = await import('./keyStore.js')
    const sum = await summarize()
    expect(Array.isArray(sum.configured)).toBe(true)
  })

  it('clearKey on a non-existent key is idempotent', async () => {
    const { clearKey } = await import('./keyStore.js')
    await expect(clearKey('gemini')).resolves.not.toThrow()
  })
})

describe('keystore — corrupt JSON', () => {
  it('loadKeys rejects with a typed error when providers.enc is not JSON', async () => {
    const file = path.join(WORK, 'providers.enc')
    await fs.writeFile(file, 'this is not json at all')
    const { loadKeys } = await import('./keyStore.js')
    await expect(loadKeys()).rejects.toBeTruthy()
  })

  it('loadKeys rejects when authTag field is missing', async () => {
    const { setKey } = await import('./keyStore.js')
    await setKey('gemini', 'g')
    const file = path.join(WORK, 'providers.enc')
    const doc = JSON.parse(await fs.readFile(file, 'utf-8'))
    delete doc.authTag
    await fs.writeFile(file, JSON.stringify(doc))

    vi.resetModules()
    vi.doMock('../appData.js', async () => {
      const actual = await vi.importActual<typeof import('../appData')>('../appData.js')
      return {
        ...actual,
        providersFile: () => file,
        saltFile: () => path.join(WORK, 'salt'),
        configDir: () => WORK,
        ensureDir: async (p: string) => fs.mkdir(p, { recursive: true }),
      }
    })
    const fresh = await import('./keyStore.js')
    await expect(fresh.loadKeys()).rejects.toBeTruthy()
  })

  it('loadKeys rejects when ciphertext field is missing', async () => {
    const { setKey } = await import('./keyStore.js')
    await setKey('gemini', 'g')
    const file = path.join(WORK, 'providers.enc')
    const doc = JSON.parse(await fs.readFile(file, 'utf-8'))
    delete doc.ciphertext
    await fs.writeFile(file, JSON.stringify(doc))

    vi.resetModules()
    vi.doMock('../appData.js', async () => {
      const actual = await vi.importActual<typeof import('../appData')>('../appData.js')
      return {
        ...actual,
        providersFile: () => file,
        saltFile: () => path.join(WORK, 'salt'),
        configDir: () => WORK,
        ensureDir: async (p: string) => fs.mkdir(p, { recursive: true }),
      }
    })
    const fresh = await import('./keyStore.js')
    await expect(fresh.loadKeys()).rejects.toBeTruthy()
  })

  it('loadKeys rejects when iv field is missing', async () => {
    const { setKey } = await import('./keyStore.js')
    await setKey('gemini', 'g')
    const file = path.join(WORK, 'providers.enc')
    const doc = JSON.parse(await fs.readFile(file, 'utf-8'))
    delete doc.iv
    await fs.writeFile(file, JSON.stringify(doc))

    vi.resetModules()
    vi.doMock('../appData.js', async () => {
      const actual = await vi.importActual<typeof import('../appData')>('../appData.js')
      return {
        ...actual,
        providersFile: () => file,
        saltFile: () => path.join(WORK, 'salt'),
        configDir: () => WORK,
        ensureDir: async (p: string) => fs.mkdir(p, { recursive: true }),
      }
    })
    const fresh = await import('./keyStore.js')
    await expect(fresh.loadKeys()).rejects.toBeTruthy()
  })
})

describe('keystore — concurrent writes', () => {
  // Phase 6.6 fix: setKey / clearKey / saveKeys now share a Promise-
  // chain mutex (serializeWrite in keyStore.ts), so concurrent calls
  // serialise instead of racing on the atomic-rename. The previous
  // EPERM-on-Windows skip is now un-skipped.
  it('three concurrent setKey() calls all survive (no last-writer-wins clobber)', async () => {
    const { setKey, loadKeys } = await import('./keyStore.js')
    await setKey('gemini', 'g0')

    await Promise.all([
      setKey('gemini', 'g1'),
      setKey('claude', 'c1'),
      setKey('openai', 'o1'),
    ])

    const out = await loadKeys()
    expect(out.gemini).toBe('g1')
    expect(out.claude).toBe('c1')
    expect(out.openai).toBe('o1')
  })

  it('sequential setKey() calls survive', async () => {
    const { setKey, loadKeys } = await import('./keyStore.js')
    await setKey('gemini', 'g1')
    await setKey('claude', 'c1')
    await setKey('openai', 'o1')
    const out = await loadKeys()
    expect(out.gemini).toBe('g1')
    expect(out.claude).toBe('c1')
    expect(out.openai).toBe('o1')
  })

  // Phase 8: pins the `.catch(() => undefined)` chain-detach behaviour
  // in serializeWrite. If a future "simplification" removes that, a
  // single failed setKey would leave a rejected promise in the chain
  // and subsequent setKey calls would never settle. This test proves
  // the chain recovers.
  it('a failing setKey does NOT poison the next setKey in the chain', async () => {
    const { setKey, loadKeys } = await import('./keyStore.js')

    // Seed.
    await setKey('gemini', 'g0')

    // Make the next encrypt fail by mocking writeFile in node:fs.
    // We do this by temporarily replacing fs.promises.writeFile.
    const { promises: realFs } = await import('node:fs')
    const original = realFs.writeFile.bind(realFs)
    let calls = 0
    realFs.writeFile = (async (...args: Parameters<typeof realFs.writeFile>) => {
      calls += 1
      if (calls === 1) throw new Error('synthetic write failure')
      return original(...args)
    }) as typeof realFs.writeFile

    try {
      // First setKey throws synthetically.
      await expect(setKey('claude', 'c-fails')).rejects.toThrow(/synthetic/)
      // Second setKey must NOT be wedged by the previous rejection.
      // It MUST proceed and update the keystore.
      await setKey('openai', 'o-survives')
      const out = await loadKeys()
      expect(out.openai).toBe('o-survives')
      // gemini is still there from the seed.
      expect(out.gemini).toBe('g0')
      // claude is NOT there because its write failed.
      expect(out.claude).toBeUndefined()
    } finally {
      realFs.writeFile = original
    }
  })

  // Phase 8: setKey + clearKey share the same mutex; verify they
  // interleave correctly.
  it('setKey and clearKey serialise through the same mutex', async () => {
    const { setKey, clearKey, loadKeys } = await import('./keyStore.js')
    await setKey('gemini', 'g0')
    await setKey('claude', 'c0')

    await Promise.all([
      setKey('gemini', 'g1'),
      clearKey('gemini'),
      setKey('gemini', 'g2'),
    ])

    const out = await loadKeys()
    // Arrival order determines the final state. The mutex serialises
    // by submission order: g1 → cleared → g2 → final state has g2.
    // claude is unaffected.
    expect(out.gemini).toBe('g2')
    expect(out.claude).toBe('c0')
  })
})
