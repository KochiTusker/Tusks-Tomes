import { PROMPT_SLOTS, REQUIRED_PLACEHOLDER } from './types.js'
import type { Persona, PersonaPrompts, PromptSlot } from './types.js'

const MAX_NAME = 60
const MAX_DESCRIPTION = 240
const MIN_PROMPT_LENGTH = 80

export type ValidationError = {
  slot?: PromptSlot
  field?: 'name' | 'description'
  message: string
}

function extractPlaceholders(template: string): Set<string> {
  const out = new Set<string>()
  const re = /\{(\w+)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(template))) out.add(m[1])
  return out
}

export function validatePersona(p: Partial<Persona>): ValidationError[] {
  const errors: ValidationError[] = []
  const name = (p.name ?? '').trim()
  if (!name) errors.push({ field: 'name', message: 'Name is required.' })
  else if (name.length > MAX_NAME) errors.push({ field: 'name', message: `Name must be ${MAX_NAME} characters or fewer.` })

  const description = (p.description ?? '').trim()
  if (description.length > MAX_DESCRIPTION) {
    errors.push({ field: 'description', message: `Description must be ${MAX_DESCRIPTION} characters or fewer.` })
  }

  const prompts = (p.prompts ?? {}) as Partial<PersonaPrompts>
  for (const slot of PROMPT_SLOTS) {
    const text = (prompts[slot] ?? '').trim()
    if (!text) {
      errors.push({ slot, message: `${slot} prompt is required.` })
      continue
    }
    if (text.length < MIN_PROMPT_LENGTH) {
      errors.push({ slot, message: `${slot} prompt is too short to be a working prompt.` })
    }
    const placeholders = extractPlaceholders(text)
    const required = REQUIRED_PLACEHOLDER[slot]
    if (!placeholders.has(required)) {
      errors.push({
        slot,
        message: `${slot} prompt must include the {${required}} placeholder so the pipeline can feed in the chunk text.`,
      })
    }
  }
  return errors
}
