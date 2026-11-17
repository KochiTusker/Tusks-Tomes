// CRUD for {configDir}/personas.json. Backs the personas-addon Settings UI
// and the Chronicle-tab dropdown. The locked bard prompts (the default)
// live in `src/features/pipeline/lib/prompts.ts` and never enter this JSON — `selectedId:
// null` means "use bard".
//
// AI persona generation runs on the client (the active provider lives in
// the browser); the server only validates and persists what's POSTed back.

import express, { type Express, type Response, type Router } from 'express'
import { randomBytes } from 'node:crypto'
import { personasFile, readJson, writeJson } from '../../../platform/appData.js'
import { PROMPT_SLOTS } from '../../../../shared/personas/types.js'
import type { Persona, PersonaPrompts, PersonasDocument } from '../../../../shared/personas/types.js'
import { validatePersona } from '../services/validate.js'
import { buildSeedDocument } from '../services/seed.js'
import { asyncRoute } from '../../../platform/asyncRoute.js'

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

/** Where a persona sits in the document, or -1 after answering 404 for an unknown id. */
function personaIndex(doc: PersonasDocument, id: string, res: Response): number {
  const idx = doc.personas.findIndex((p) => p.id === id)
  if (idx < 0) res.status(404).json({ error: `Unknown persona id: ${id}` })
  return idx
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

  router.get('/', asyncRoute('api/personas GET', async (_req, res) => {
    const doc = await loadDocument()
    res.json(doc)
  }))

  // Change the active persona (or clear it to fall back to bard).
  router.put('/selected', asyncRoute('api/personas PUT /selected', async (req, res) => {
    const body = req.body as { selectedId?: string | null }
    const doc = await loadDocument()
    const next = body?.selectedId ?? null
    if (next !== null && !doc.personas.some((p) => p.id === next)) {
      return res.status(404).json({ error: `Unknown persona id: ${next}` })
    }
    doc.selectedId = next
    await writeJson(personasFile(), doc)
    res.json(doc)
  }))

  // Create a new persona. Server assigns the id and updatedAt — clients
  // shouldn't supply them. `preset` cannot be set via this endpoint; it's
  // reserved for the seeded presets.
  router.post('/', asyncRoute('api/personas POST', async (req, res) => {
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
  }))

  // Replace an existing persona. Preserves preset flag and id, refreshes
  // updatedAt server-side.
  router.put('/:id', asyncRoute('api/personas PUT /:id', async (req, res) => {
    const doc = await loadDocument()
    const idx = personaIndex(doc, req.params.id, res)
    if (idx < 0) return
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
  }))

  router.delete('/:id', asyncRoute('api/personas DELETE /:id', async (req, res) => {
    const doc = await loadDocument()
    const idx = personaIndex(doc, req.params.id, res)
    if (idx < 0) return
    doc.personas.splice(idx, 1)
    if (doc.selectedId === req.params.id) doc.selectedId = null
    await writeJson(personasFile(), doc)
    res.json(doc)
  }))

  return router
}

/** Mounts the personas routes. The router seeds the six presets on first read,
 *  so personas.json never needs to exist, and nothing deletes it. */
export function registerPersonasRoutes(app: Express): void {
  app.use('/api/personas', personasRouter())
}
