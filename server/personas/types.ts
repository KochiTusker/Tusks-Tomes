// Server-side mirror of `src/lib/personas/types.ts`. Both halves must stay
// in sync — the client validates for editor UX, the server validates for
// API safety, and the on-disk shape (`personas.json`) lives between them.

export type PromptSlot =
  | 'phase3Cloud'
  | 'phase3Local'
  | 'phase5Local'
  | 'phase6Cloud'
  | 'phase6Local'

export const PROMPT_SLOTS: PromptSlot[] = [
  'phase3Cloud',
  'phase3Local',
  'phase5Local',
  'phase6Cloud',
  'phase6Local',
]

export type PersonaPrompts = Record<PromptSlot, string>

export type Persona = {
  id: string
  name: string
  description: string
  preset?: boolean
  updatedAt: string
  prompts: PersonaPrompts
}

export type PersonasDocument = {
  selectedId: string | null
  personas: Persona[]
}

export const REQUIRED_PLACEHOLDER: Record<PromptSlot, string> = {
  phase3Cloud: 'groundedChunk',
  phase3Local: 'groundedChunk',
  phase5Local: 'chronicleChunk',
  phase6Cloud: 'chronicle',
  phase6Local: 'chronicle',
}
