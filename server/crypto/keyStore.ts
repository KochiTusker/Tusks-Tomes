// Encrypted API key storage (ROADMAP Step 6).
//
// Algorithm: AES-256-GCM. Key derivation: scrypt over a stable machine
// identity (hostname + username + platform) salted by a per-machine random
// value stored alongside the ciphertext. This is OBFUSCATION, not high-grade
// cryptography — the keys are recoverable on the same machine. A future
// step could layer a user-supplied master password on top.

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { ensureDir, providersFile, saltFile } from '../appData.js'
import path from 'node:path'

export type ProviderKey =
  | 'gemini'
  | 'geminiFallback'
  // JSON-encoded `{ baseUrl, username?, password?, bearerToken? }`. Stored as
  // a single keystore slot so the password / token sits behind the same
  // machine-bound encryption as the cloud API keys.
  | 'unsloth'
  | 'openrouter'

export type KeyBundle = Partial<Record<ProviderKey, string>>

type EncryptedDocument = {
  version: 1
  iv: string
  authTag: string
  ciphertext: string
}

async function readSalt(): Promise<Buffer> {
  const file = saltFile()
  try {
    return await fs.readFile(file)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    await ensureDir(path.dirname(file))
    const fresh = randomBytes(16)
    await fs.writeFile(file, fresh)
    return fresh
  }
}

async function deriveKey(): Promise<Buffer> {
  const salt = await readSalt()
  const identity = `${os.hostname()}::${os.userInfo().username}::${os.platform()}`
  return scryptSync(identity, salt, 32)
}

async function readDocument(): Promise<EncryptedDocument | null> {
  try {
    const buf = await fs.readFile(providersFile(), 'utf8')
    return JSON.parse(buf) as EncryptedDocument
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

async function writeDocument(doc: EncryptedDocument): Promise<void> {
  const file = providersFile()
  await ensureDir(path.dirname(file))
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  await fs.writeFile(tmp, JSON.stringify(doc, null, 2))
  await fs.rename(tmp, file)
}

async function encrypt(plain: KeyBundle): Promise<EncryptedDocument> {
  const key = await deriveKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const json = Buffer.from(JSON.stringify(plain), 'utf8')
  const ciphertext = Buffer.concat([cipher.update(json), cipher.final()])
  const authTag = cipher.getAuthTag()
  return {
    version: 1,
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
}

async function decrypt(doc: EncryptedDocument): Promise<KeyBundle> {
  const key = await deriveKey()
  const iv = Buffer.from(doc.iv, 'base64')
  const authTag = Buffer.from(doc.authTag, 'base64')
  const ciphertext = Buffer.from(doc.ciphertext, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return JSON.parse(plain.toString('utf8')) as KeyBundle
}

// One-time .env migration: if no providers.enc exists yet and the caller's
// process has env vars for any provider, seed the bundle from them so the
// upgrade is invisible. Called automatically on first `loadKeys()`.
function seedFromEnv(): KeyBundle {
  const env = process.env
  const seed: KeyBundle = {}
  if (env.PAID_GEMINI_API_KEY) seed.gemini = env.PAID_GEMINI_API_KEY
  if (env.VITE_GEMINI_API_KEY && env.VITE_GEMINI_API_KEY !== env.PAID_GEMINI_API_KEY) {
    if (!seed.gemini) seed.gemini = env.VITE_GEMINI_API_KEY
    else seed.geminiFallback = env.VITE_GEMINI_API_KEY
  }
  if (env.OPENROUTER_API_KEY) seed.openrouter = env.OPENROUTER_API_KEY
  return seed
}

let cache: KeyBundle | null = null

// Promise-chain mutex for write paths. setKey / clearKey are
// read-modify-write under an atomic rename, so two concurrent calls
// could either race on the rename (EPERM on Windows) or last-writer-
// wins on the in-memory cache. Chaining via `writeChain = writeChain.then(...)`
// serialises all writes in arrival order. Reads (loadKeys) intentionally
// don't take the lock — they're idempotent against the on-disk doc.
let writeChain: Promise<unknown> = Promise.resolve()
function serializeWrite<T>(body: () => Promise<T>): Promise<T> {
  const next = writeChain.then(body, body)
  // Detach this run's failure from the chain so a single failed write
  // doesn't poison subsequent calls. The chain only needs to enforce
  // ordering, not success propagation.
  writeChain = next.catch(() => undefined)
  return next
}

export async function loadKeys(): Promise<KeyBundle> {
  if (cache) return cache
  const doc = await readDocument()
  if (!doc) {
    const seed = seedFromEnv()
    if (Object.keys(seed).length > 0) {
      console.warn(
        '[keystore] No providers.enc found — seeding from environment variables. Going forward, manage keys via the Settings tab.'
      )
      await writeDocument(await encrypt(seed))
      cache = seed
      return seed
    }
    cache = {}
    return cache
  }
  cache = await decrypt(doc)
  return cache
}

export async function saveKeys(bundle: KeyBundle): Promise<void> {
  return serializeWrite(async () => {
    const doc = await encrypt(bundle)
    await writeDocument(doc)
    cache = { ...bundle }
  })
}

export async function setKey(name: ProviderKey, value: string): Promise<void> {
  return serializeWrite(async () => {
    // Re-read the *current* cache inside the mutex so concurrent setKey
    // calls see each other's updates instead of overwriting.
    const bundle = cache ?? (await loadKeys())
    const next = { ...bundle, [name]: value }
    const doc = await encrypt(next)
    await writeDocument(doc)
    cache = { ...next }
  })
}

export async function clearKey(name: ProviderKey): Promise<void> {
  return serializeWrite(async () => {
    const bundle = cache ?? (await loadKeys())
    const next = { ...bundle }
    delete next[name]
    const doc = await encrypt(next)
    await writeDocument(doc)
    cache = { ...next }
  })
}

/** Read-only summary safe to expose over HTTP. */
export async function summarize(): Promise<{
  configured: ProviderKey[]
  hasFallback: { gemini: boolean }
}> {
  const bundle = await loadKeys()
  const configured = (Object.keys(bundle) as ProviderKey[]).filter((k) => !!bundle[k])
  return {
    configured,
    hasFallback: { gemini: !!bundle.geminiFallback },
  }
}
