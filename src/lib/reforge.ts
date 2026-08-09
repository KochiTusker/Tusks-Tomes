// Chronicle Reforge — re-run the downstream pipeline phases (optionally the
// chronicle, then extras + condense) on a chosen provider (Gemini) for an
// existing/re-uploaded chronicle. Pure orchestration: it sequences the existing
// phase runners with explicit provider + persona config and applies no new
// generation logic of its own.
//
// Why this exists: Claude Code often produces a solid chronicle but refuses or
// underperforms on the later phases (extras: dark/explicit extraction; condense).
// Reforge lets the user keep the good chronicle (or regenerate it to fix the
// player action-vs-dialogue problem) and redo the downstream work on Gemini,
// which the user finds better at quotes/jests/gore and condensing.

import { runPhase3, runPhase4, runPhase6, type PipelineCallbacks } from './pipeline'
import type { GeminiTier } from './providers'
import type { CloudProvider } from './profiles'
import { computeCondenseTarget, countWords } from './wordCount'
import type {
  CondenseOutput,
  DMAnswers,
  DMQuestion,
  ExtrasOutput,
  KBDocument,
} from '@/types'

export type ReforgeInput = {
  chronicle: string
  /** Phase 1 output. Enables transcript-source extras AND chronicle regen.
   *  Absent for a paste/upload of a bare chronicle. */
  groundedTranscript?: string
  dmQuestions: DMQuestion[]
  dmAnswers: DMAnswers
  kb: KBDocument[]
  campaign: string
  sessionNumber: number
}

export type ReforgeConfig = {
  /** false = keep input.chronicle; true = regenerate it on the provider
   *  (requires groundedTranscript). */
  regenerateChronicle: boolean
  doExtras: boolean
  doCondense: boolean
  /** 'transcript' (richer, costlier — needs groundedTranscript) vs 'chronicle'
   *  (cheaper, lossier — extracts from the prose). */
  extrasSource: 'transcript' | 'chronicle'
  /** Provider to reforge on. Defaults to 'gemini' (the historical behaviour).
   *  The model picker can route to Claude / OpenAI / Gemini. */
  provider?: CloudProvider
  /** Only meaningful when `provider === 'gemini'`. */
  geminiTier: GeminiTier
  /** Explicit model id chosen in the picker. When omitted, the provider's
   *  default 'pro'-tier model is used. The model also drives chunk sizing, so
   *  a fast-tier id (Flash-Lite / Haiku / -mini / -nano) automatically picks
   *  the smaller chunk row. */
  model?: string
  /** Persona templates for the voiced phases. Extras (Phase 4) is voice-neutral
   *  and takes no persona. */
  personaTemplates?: {
    phase3?: { cloud?: string; local?: string }
    phase6?: { cloud?: string; local?: string }
  }
  /** Condense Slider percentage (preferred). runReforge computes the target
   *  word count against the *resolved* chronicle (new if regenerated, else
   *  kept) so the target tracks the chronicle that's actually condensed. */
  condensePercentage?: number
  /** Explicit condense target word count — fallback when condensePercentage
   *  is absent (e.g. legacy callers). */
  targetWordCount?: number
}

export type ReforgeResult = {
  chronicle: string
  extras?: ExtrasOutput
  condensed?: CondenseOutput
  /** True when the chronicle in the result was freshly regenerated (vs kept). */
  chronicleRegenerated: boolean
}

/** Validate a config against the available inputs. Returns a human reason when
 *  the combination is impossible (UI also disables these, but guard anyway). */
export function validateReforge(input: ReforgeInput, config: ReforgeConfig): string | null {
  if (!config.doExtras && !config.doCondense && !config.regenerateChronicle) {
    return 'Nothing selected — choose at least one of: regenerate chronicle, extras, or condense.'
  }
  const hasTranscript = !!input.groundedTranscript?.trim()
  if (config.regenerateChronicle && !hasTranscript) {
    return 'Regenerating the chronicle needs the grounded transcript, which isn’t available for this source.'
  }
  if (config.doExtras && config.extrasSource === 'transcript' && !hasTranscript) {
    return 'Extras from the transcript need the grounded transcript. Switch the extras source to the chronicle, or use a source that has a transcript.'
  }
  if (!input.chronicle.trim() && !config.regenerateChronicle) {
    return 'No chronicle provided to work from.'
  }
  return null
}

/** Re-run the chosen downstream phases on the configured provider. Throws on a
 *  gating violation (call validateReforge first) or on a phase failure. */
export async function runReforge(
  input: ReforgeInput,
  config: ReforgeConfig,
  callbacks: PipelineCallbacks,
): Promise<ReforgeResult> {
  const reason = validateReforge(input, config)
  if (reason) throw new Error(reason)

  const provider: CloudProvider = config.provider ?? 'gemini'
  const common = {
    cloudProvider: provider,
    geminiTier: config.geminiTier,
    model: config.model,
  }

  // 1) Chronicle — regenerate or keep.
  let chronicle = input.chronicle
  let chronicleRegenerated = false
  if (config.regenerateChronicle) {
    chronicle = await runPhase3({
      groundedTranscript: input.groundedTranscript!,
      dmQuestions: input.dmQuestions,
      dmAnswers: input.dmAnswers,
      kb: input.kb,
      callbacks,
      ...common,
      personaTemplates: config.personaTemplates?.phase3,
    })
    chronicleRegenerated = true
  }

  // 2) Extras — from the grounded transcript (richer) or the chronicle (cheaper).
  let extras: ExtrasOutput | undefined
  if (config.doExtras) {
    const fromChronicle = config.extrasSource === 'chronicle'
    extras = await runPhase4({
      groundedTranscript: fromChronicle ? chronicle : input.groundedTranscript!,
      dmAnswers: input.dmAnswers,
      callbacks,
      ...common,
      extrasSourceKind: fromChronicle ? 'chronicle' : 'transcript',
    })
  }

  // 3) Condense — always from the (new or kept) chronicle. Resolve the target
  //    against THIS chronicle: when the chronicle was regenerated, its length
  //    differs from the original, so a percentage-of-chronicle target must be
  //    computed here rather than carried from the original run.
  let condensed: CondenseOutput | undefined
  if (config.doCondense) {
    const targetWordCount =
      config.condensePercentage && config.condensePercentage > 0
        ? computeCondenseTarget(countWords(chronicle), config.condensePercentage)
        : config.targetWordCount
    condensed = await runPhase6({
      chronicle,
      kb: input.kb,
      dmAnswers: input.dmAnswers,
      campaign: input.campaign,
      sessionNumber: input.sessionNumber,
      callbacks,
      ...common,
      personaTemplates: config.personaTemplates?.phase6,
      targetWordCount,
    })
  }

  return { chronicle, extras, condensed, chronicleRegenerated }
}
