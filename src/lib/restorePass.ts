// Layer-2 explicit-content failsafe: a post-hoc Gemini "restore" pass.
//
// When a Claude Code chronicle is suspected of having sanitised mature
// content, this reconciles it against the raw grounded transcript using
// Gemini (permissive, BLOCK_NONE) and returns a corrected chronicle — plus a
// re-extraction of the extras (quotes / jests / gore) straight from the
// transcript. Single Gemini call each: Gemini's large context holds the whole
// transcript, so we sidestep the transcript↔chronicle chunk-alignment problem.
//
// Results are returned for the UI to present for review (Replace / Discard) —
// never auto-applied — which also covers the case where a very long chronicle
// would exceed the output cap and come back truncated.

import { MAX_OUTPUT_TOKENS } from './constants'
import { getCloudProvider } from './providers'
import { phase4Extras, restoreChronicleParts } from './prompts'
import { normalizeQuotes } from './quotes'
import type { ExtrasOutput } from '@/types'

const RESTORE_MODEL = 'gemini-2.5-pro'

/** True iff a Gemini key is configured (the restore pass requires it). */
export function geminiAvailableForRestore(): boolean {
  const gem = getCloudProvider('gemini', { geminiTier: 'auto' })
  return (gem as { hasKey?: () => boolean }).hasKey?.() ?? false
}

export async function runChronicleRestore(args: {
  groundedTranscript: string
  chronicle: string
  signal?: AbortSignal
}): Promise<string> {
  const gem = getCloudProvider('gemini', { geminiTier: 'auto' })
  const parts = restoreChronicleParts({
    transcript: args.groundedTranscript,
    chronicle: args.chronicle,
  })
  const res = await gem.generate(
    {
      systemPrompt: parts.systemPrompt,
      userPrompt: parts.userPrompt,
      model: RESTORE_MODEL,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      safetyMode: 'permissive',
      responseFormat: 'text',
    },
    { signal: args.signal, contextLabel: 'Restore — chronicle' },
  )
  return res.text
}

export async function runExtrasRestore(args: {
  groundedTranscript: string
  signal?: AbortSignal
}): Promise<ExtrasOutput | null> {
  const gem = getCloudProvider('gemini', { geminiTier: 'auto' })
  // Re-extract from the whole transcript in one pass (Gemini's large context).
  const userPrompt = phase4Extras({
    groundedChunk: args.groundedTranscript,
    dmAnswers: {},
    index: 0,
    total: 1,
  })
  const res = await gem.generate(
    {
      systemPrompt: '',
      userPrompt,
      model: RESTORE_MODEL,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      safetyMode: 'permissive',
      responseFormat: 'json',
    },
    { signal: args.signal, contextLabel: 'Restore — extras' },
  )
  return parseExtras(res.text)
}

/** Tolerant JSON-object parse → ExtrasOutput. Returns null if unusable. */
export function parseExtras(raw: string): ExtrasOutput | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const p = parsed as Record<string, unknown>
  const strArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  return { jests: strArray(p.jests), gore: strArray(p.gore), quotes: normalizeQuotes(p.quotes) }
}
