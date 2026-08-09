// CRUD for {configDir}/personas.json. Backs the personas-addon Settings UI
// and the Chronicle-tab dropdown. The locked bard prompts (the default)
// live in `src/lib/prompts.ts` and never enter this JSON — `selectedId:
// null` means "use bard".
//
// AI persona generation runs on the client (the active provider lives in
// the browser); the server only validates and persists what's POSTed back.

import express, { type Router } from 'express'
import { randomBytes } from 'node:crypto'
import { personasFile, readJson, writeJson } from '../appData.js'
import { PROMPT_SLOTS } from '../personas/types.js'
import type { Persona, PersonaPrompts, PersonasDocument } from '../personas/types.js'
import { validatePersona } from '../personas/validate.js'
import { buildSeedDocument } from '../personas/seed.js'

const MAX_PERSONAS = 50

async function loadDocument(): Promise<PersonasDocument> {
  const seed = buildSeedDocument()
  const doc = await readJson<PersonasDocument>(personasFile(), seed)
  // Sanitise: tolerate hand-edited or partially-corrupt files by dropping
  // unknown fields and patching missing required ones rather than crashing.
  return sanitiseDocument(doc, seed)
}

function sanitiseDocument(doc: Partial<PersonasDocument>, fallback: PersonasDocument): PersonasDocument {
  const personas = Array.isArray(doc?.personas)
    ? (doc.personas as Persona[]).filter((p) => p && typeof p.id === 'string').map(sanitisePersona)
    : fallback.personas
  const selectedId = typeof doc?.selectedId === 'string' && personas.some((p) => p.id === doc.selectedId)
    ? doc.selectedId
    : null
  return { selectedId, personas }
}

function sanitisePersona(p: Persona): Persona {
  const prompts = (p.prompts ?? {}) as Partial<PersonaPrompts>
  const cleanedPrompts: PersonaPrompts = {
    phase3Cloud: String(prompts.phase3Cloud ?? ''),
    phase3Local: String(prompts.phase3Local ?? ''),
    phase5Local: String(prompts.phase5Local ?? ''),
    phase6Cloud: String(prompts.phase6Cloud ?? ''),
    phase6Local: String(prompts.phase6Local ?? ''),
  }
  return {
    id: String(p.id),
    name: String(p.name ?? '').trim() || 'Unnamed Persona',
    description: String(p.description ?? '').trim(),
    preset: p.preset === true ? true : undefined,
    updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : new Date().toISOString(),
    prompts: cleanedPrompts,
  }
}

function newId(): string {
  return `persona-${randomBytes(6).toString('hex')}`
}

function pickPromptFields(body: unknown): Partial<PersonaPrompts> {
  if (!body || typeof body !== 'object') return {}
  const src = body as Record<string, unknown>
  const out: Partial<PersonaPrompts> = {}
  for (const slot of PROMPT_SLOTS) {
    const v = src[slot]
    if (typeof v === 'string') out[slot] = v
  }
  return out
}

function sendValidation(res: express.Response, errors: ReturnType<typeof validatePersona>): void {
  res.status(400).json({ error: 'validation_failed', issues: errors })
}

export function personasRouter(): Router {
  const router = express.Router()
  router.use(express.json({ limit: '2mb' }))

  router.get('/', async (_req, res) => {
    try {
      const doc = await loadDocument()
      res.json(doc)
    } catch (err) {
      console.error('[api/personas GET] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // Change the active persona (or clear it to fall back to bard).
  router.put('/selected', async (req, res) => {
    try {
      const body = req.body as { selectedId?: string | null }
      const doc = await loadDocument()
      const next = body?.selectedId ?? null
      if (next !== null && !doc.personas.some((p) => p.id === next)) {
        return res.status(404).json({ error: `Unknown persona id: ${next}` })
      }
      doc.selectedId = next
      await writeJson(personasFile(), doc)
      res.json(doc)
    } catch (err) {
      console.error('[api/personas PUT /selected] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // Create a new persona. Server assigns the id and updatedAt — clients
  // shouldn't supply them. `preset` cannot be set via this endpoint; it's
  // reserved for the seeded presets.
  router.post('/', async (req, res) => {
    try {
      const body = req.body as Partial<Persona>
      const draft: Persona = {
        id: newId(),
        name: String(body?.name ?? '').trim(),
        description: String(body?.description ?? '').trim(),
        updatedAt: new Date().toISOString(),
        prompts: {
          phase3Cloud: '',
          phase3Local: '',
          phase5Local: '',
          phase6Cloud: '',
          phase6Local: '',
          ...pickPromptFields(body?.prompts),
        },
      }
      const errors = validatePersona(draft)
      if (errors.length) return sendValidation(res, errors)

      const doc = await loadDocument()
      if (doc.personas.length >= MAX_PERSONAS) {
        return res.status(400).json({ error: `Maximum ${MAX_PERSONAS} personas.` })
      }
      doc.personas.push(draft)
      await writeJson(personasFile(), doc)
      res.json({ persona: draft, document: doc })
    } catch (err) {
      console.error('[api/personas POST] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // Replace an existing persona. Preserves preset flag and id, refreshes
  // updatedAt server-side.
  router.put('/:id', async (req, res) => {
    try {
      const doc = await loadDocument()
      const idx = doc.personas.findIndex((p) => p.id === req.params.id)
      if (idx < 0) return res.status(404).json({ error: `Unknown persona id: ${req.params.id}` })
      const existing = doc.personas[idx]
      const body = req.body as Partial<Persona>

      const updated: Persona = {
        ...existing,
        name: String(body?.name ?? existing.name).trim(),
        description: String(body?.description ?? existing.description).trim(),
        prompts: { ...existing.prompts, ...pickPromptFields(body?.prompts) },
        updatedAt: new Date().toISOString(),
      }
      const errors = validatePersona(updated)
      if (errors.length) return sendValidation(res, errors)
      doc.personas[idx] = updated
      await writeJson(personasFile(), doc)
      res.json({ persona: updated, document: doc })
    } catch (err) {
      console.error('[api/personas PUT /:id] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.delete('/:id', async (req, res) => {
    try {
      const doc = await loadDocument()
      const idx = doc.personas.findIndex((p) => p.id === req.params.id)
      if (idx < 0) return res.status(404).json({ error: `Unknown persona id: ${req.params.id}` })
      doc.personas.splice(idx, 1)
      if (doc.selectedId === req.params.id) doc.selectedId = null
      await writeJson(personasFile(), doc)
      res.json(doc)
    } catch (err) {
      console.error('[api/personas DELETE /:id] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  return router
}
