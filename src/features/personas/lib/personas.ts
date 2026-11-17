// React-side client for /api/personas. Caches the document in memory so the
// Chronicle-tab picker, the Settings card, and the pipeline don't all hit
// the server independently. Notifies subscribers when the cache changes.

import { createDocClient, writeFailure } from '@/platform/docClient'
import type { Persona, PersonaPrompts, PersonasDocument } from './personas/types'

const EMPTY: PersonasDocument = { selectedId: null, personas: [] }

const client = createDocClient<PersonasDocument>({
  path: '/api/personas',
  normalise: (doc) => ({
    selectedId: doc.selectedId ?? null,
    personas: Array.isArray(doc.personas) ? doc.personas : [],
  }),
})
const emit = client.emit

export const getPersonas = client.get

export function peekPersonas(): PersonasDocument {
  return client.peek() ?? EMPTY
}

export const subscribePersonas = client.subscribe

/** Find the currently selected persona, or null when bard is active. */
export function findSelectedPersona(doc: PersonasDocument): Persona | null {
  if (!doc.selectedId) return null
  return doc.personas.find((p) => p.id === doc.selectedId) ?? null
}

export async function setSelectedPersona(id: string | null): Promise<PersonasDocument> {
  const res = await fetch('/api/personas/selected', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ selectedId: id }),
  })
  if (!res.ok) throw await writeFailure('PUT', '/api/personas/selected', res)
  const doc = (await res.json()) as PersonasDocument
  emit(doc)
  return doc
}

export type PersonaDraft = {
  name: string
  description: string
  prompts: PersonaPrompts
}

type PersonaValidationFailure = {
  error: 'validation_failed'
  issues: Array<{ slot?: string; field?: string; message: string }>
}

export class PersonaValidationError extends Error {
  issues: PersonaValidationFailure['issues']
  constructor(failure: PersonaValidationFailure) {
    super(failure.issues.map((i) => `${i.slot ?? i.field ?? ''}: ${i.message}`).join('\n'))
    this.name = 'PersonaValidationError'
    this.issues = failure.issues
  }
}

async function unwrap<T>(res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T
  const body = await res.text().catch(() => '')
  try {
    const parsed = JSON.parse(body) as PersonaValidationFailure
    if (parsed?.error === 'validation_failed' && Array.isArray(parsed.issues)) {
      throw new PersonaValidationError(parsed)
    }
  } catch (err) {
    if (err instanceof PersonaValidationError) throw err
  }
  throw new Error(`${res.url} failed: HTTP ${res.status}. ${body.slice(0, 400)}`)
}

export async function createPersona(draft: PersonaDraft): Promise<{ persona: Persona; document: PersonasDocument }> {
  const res = await fetch('/api/personas', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(draft),
  })
  const out = await unwrap<{ persona: Persona; document: PersonasDocument }>(res)
  emit(out.document)
  return out
}

export async function updatePersona(id: string, draft: PersonaDraft): Promise<{ persona: Persona; document: PersonasDocument }> {
  const res = await fetch(`/api/personas/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(draft),
  })
  const out = await unwrap<{ persona: Persona; document: PersonasDocument }>(res)
  emit(out.document)
  return out
}

export async function deletePersona(id: string): Promise<PersonasDocument> {
  const res = await fetch(`/api/personas/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!res.ok) throw await writeFailure('DELETE', '/api/personas', res)
  const doc = (await res.json()) as PersonasDocument
  emit(doc)
  return doc
}
