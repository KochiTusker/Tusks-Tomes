import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getGlossary, putGlossary } from '@/features/corrections/lib/glossary'
import { getSpeakers, putSpeakers } from '@/features/corrections/lib/speakers'
import { deletePersona, getPersonas, setSelectedPersona } from '@/features/personas/lib/personas'
import { getSystemInfo } from '@/features/maintenance/lib/system'

// The text a person sees when one of these documents fails to load or save.
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response('nope', { status: 503 })))
})
afterEach(() => vi.unstubAllGlobals())

describe('document client error text', () => {
  it('reads', async () => {
    await expect(getGlossary()).rejects.toThrow(/^GET \/api\/glossary failed: HTTP 503$/)
    await expect(getSpeakers()).rejects.toThrow(/^GET \/api\/speakers failed: HTTP 503$/)
    await expect(getPersonas()).rejects.toThrow(/^GET \/api\/personas failed: HTTP 503$/)
    await expect(getSystemInfo()).rejects.toThrow(/^GET \/api\/system\/info failed: HTTP 503$/)
  })

  it('writes', async () => {
    await expect(putGlossary({ version: 1, safeReplacements: [], contextualHints: [] })).rejects.toThrow(
      /^PUT \/api\/glossary failed: HTTP 503\. nope$/,
    )
    await expect(putSpeakers({ version: 1, speakers: [] })).rejects.toThrow(
      /^PUT \/api\/speakers failed: HTTP 503\. nope$/,
    )
    await expect(setSelectedPersona(null)).rejects.toThrow(
      /^PUT \/api\/personas\/selected failed: HTTP 503\. nope$/,
    )
    await expect(deletePersona('abc')).rejects.toThrow(/^DELETE \/api\/personas failed: HTTP 503\. nope$/)
  })
})
