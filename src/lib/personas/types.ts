// Shared persona types used by both the server (`server/api/personas.ts`,
// `server/addons/registry.ts`) and the client (`src/lib/personas.ts`,
// `src/components/PersonasManager.tsx`).
//
// Bard is *not* a Persona — it lives in `src/lib/prompts.ts` as the locked
// default that ships with the core install. Only add-on personas (preset
// clones + user-authored) inhabit this type.

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
  /** Marks the seeded presets (Arnold, Homer, etc.). Built-ins are still
   *  editable and deletable — the flag is only used for UI labelling. */
  preset?: boolean
  /** ISO timestamp of last edit; used by the UI for "Updated …" labels. */
  updatedAt: string
  prompts: PersonaPrompts
}

export type PersonasDocument = {
  selectedId: string | null
  personas: Persona[]
}

/** Runtime variables the persona prompt templates can reference. Keys must
 *  match the `{placeholder}` tokens accepted by `renderPersonaPrompt`. */
export type PromptVars = {
  groundedChunk?: string
  chronicleChunk?: string
  chronicle?: string
  kbConcat?: string
  qaBlock?: string
  answersBlock?: string
  priorTail?: string
  chunkIndex?: number
  chunkTotal?: number
  campaign?: string
  sessionNumber?: number
}

/** The runtime placeholder a slot MUST reference for the pipeline to feed
 *  data into it. A persona that strips its slot's required placeholder is
 *  rejected by the validator. */
export const REQUIRED_PLACEHOLDER: Record<PromptSlot, keyof PromptVars> = {
  phase3Cloud: 'groundedChunk',
  phase3Local: 'groundedChunk',
  phase5Local: 'chronicleChunk',
  phase6Cloud: 'chronicle',
  phase6Local: 'chronicle',
}
