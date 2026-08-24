// Browser-side AI persona generator. Calls the user's active LLM with a
// structured-JSON prompt and produces a draft persona that the editor then
// previews for review. The call is one-shot; failure surfaces as a thrown
// Error which the calling component renders as a toast.

import { ensureProvidersInitialized, getActiveProvider } from '@/lib/providers'
import { getModelForTier } from '@/lib/providers/settings'
import { expandTemplate, TEMPLATE_PLACEHOLDER_VOICE } from './templates'
import type { PersonaPrompts } from './types'

export type AIGeneratedPersona = {
  name: string
  description: string
  voice: string
  prompts: PersonaPrompts
}

const SYSTEM_PROMPT = `You are designing a "narrator persona" for a tool that retells Dungeons & Dragons sessions in different voices. Your output describes a *voice* — a way of speaking — that will be inserted into a strict structural prompt. You are NOT writing the structural rules; those already exist. You are only writing the voice.

Return STRICT JSON with this shape and nothing else:
{
  "name": "<short display name, max 60 chars>",
  "description": "<one-line description, max 240 chars>",
  "voice": "<3-7 sentences of voice direction: diction, perspective, signature phrases, what the narrator notices and exaggerates. End with a sentence reminding the model that this is a colouring layer over the structural rules and does not authorise inventing events.>"
}

No markdown fences. No commentary. JSON only.`

function stripJsonFence(s: string): string {
  return s
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
}

function safeJson<T = unknown>(text: string): T | null {
  try {
    return JSON.parse(text) as T
  } catch {
    // Tolerate models that wrap JSON in prose. Find first { ... last }.
    const first = text.indexOf('{')
    const last = text.lastIndexOf('}')
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(text.slice(first, last + 1)) as T
      } catch {
        return null
      }
    }
    return null
  }
}

/** Generate a draft persona from a user description. Returns the parsed
 *  draft including all five expanded prompts. Throws on provider error
 *  or unparseable response. */
export async function generatePersonaDraft(description: string, signal?: AbortSignal): Promise<AIGeneratedPersona> {
  await ensureProvidersInitialized()
  const provider = getActiveProvider()
  const model = getModelForTier('pro')

  const userPrompt = `Design a narrator persona for the following request:

"${description.trim()}"

Remember: JSON only. The "voice" field describes how the narrator speaks — diction, perspective, signature flourishes — and ends with a one-sentence reminder that voice is a colouring layer that cannot authorise inventing events.`

  const res = await provider.generate(
    {
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      model,
      maxOutputTokens: 1200,
      temperature: 0.8,
      responseFormat: 'json',
      safetyMode: 'permissive',
    },
    { signal, contextLabel: 'Persona generation' },
  )

  const parsed = safeJson<{ name?: string; description?: string; voice?: string }>(stripJsonFence(res.text))
  if (!parsed) {
    throw new Error('Could not parse persona JSON from the model response. Try a more specific description, or paste a persona manually.')
  }
  const name = (parsed.name ?? '').toString().trim().slice(0, 60) || 'Untitled persona'
  const desc = (parsed.description ?? '').toString().trim().slice(0, 240)
  const voice = (parsed.voice ?? '').toString().trim() || TEMPLATE_PLACEHOLDER_VOICE
  return {
    name,
    description: desc,
    voice,
    prompts: expandTemplate(voice),
  }
}
