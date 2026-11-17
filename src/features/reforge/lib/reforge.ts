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

import {
  runPhase3,
  runPhase4,
  runPhase6,
  type PipelineCallbacks,
  tryParseJson,
} from '@/features/pipeline'
import type { AliasIndex } from '@/features/lore'
import type { GeminiTier, CloudProvider } from '@/features/providers'
import { computeCondenseTarget, countWords } from '../../../platform/lib/wordCount'
import type {
  CondenseOutput,
  DMAnswers,
  DMQuestion,
  ExtrasOutput,
  KBDocument,
} from '@/features/pipeline'

export type ReforgeInput = {
  chronicle: string
  /** Phase 1 output. Enables transcript-source extras AND chronicle regen.
   *  Absent for a paste/upload of a bare chronicle. */
  groundedTranscript?: string
  dmQuestions: DMQuestion[]
  dmAnswers: DMAnswers
  kb: KBDocument[]
  /** settings.retrieveVaultKb. Phases 3 and 6 are handed the whole vault
   *  otherwise, and on a large one that is not a slow reforge but an
   *  impossible one — the lore alone can exceed the model's context window.
   *  Optional so a caller with no settings to hand still gets the historical
   *  behaviour rather than a compile error. */
  retrieveVaultKb?: boolean
  /** Lore alias index, for vault-agnostic retrieval. Optional: retrieval
   *  falls back to note-title matching when absent, which is weaker but not
   *  wrong. */
  aliasIndex?: AliasIndex | null
  campaign: string
  sessionNumber: number
}

/** The phases a reforge can re-run. Phases 1 and 2 are excluded by design:
 *  reforge starts from an already-grounded transcript, so re-running them would
 *  mean regrounding text that is already the input. */
export type ReforgePhase = 'phase3' | 'phase4' | 'phase6'

/** Where one phase runs. Mirrors the fields runPhaseN reads for routing. */
export type PhaseRoute = {
  provider: CloudProvider
  /** Only meaningful when provider === 'gemini'. */
  geminiTier: GeminiTier
  model?: string
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
  /**
   * Per-phase routing override.
   *
   * Reforge originally ran every selected phase on one model, which the grades
   * now say is the wrong default: the best chronicle model and the best extras
   * model measured are not the same model, and on extras the ranking inverts
   * outright. Running one model across all three phases guarantees at least one
   * of them is not the one that won its phase.
   *
   * Absent entries fall back to the top-level provider/geminiTier/model, so a
   * caller that supplies nothing behaves exactly as before.
   */
  phaseModels?: Partial<Record<ReforgePhase, PhaseRoute>>
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

/**
 * What a reforge has finished so far, reported as it runs so that a run which
 * stops — a provider out of credits on the last chunk, a cancel — does not
 * take the finished work with it. Passed back as `resumeFrom`, it lets the
 * same run carry on from where it stopped.
 */
export type ReforgeProgress = {
  /** The rewritten chronicle, once Phase 3 has finished. */
  chronicle?: string
  /** The extras, once Phase 4 has finished. */
  extras?: ExtrasOutput
  /** The phase that was running, and how far it got. */
  inFlight?: {
    phase: ReforgePhase
    /** Chunks before this index are finished; a resume starts here. */
    nextChunk: number
    totalChunks: number
    /** How the phase split its source. A resume must split it the same way
     *  or `nextChunk` points at different text. */
    chunkSizeChars?: number
    /** The phase's own running output: chronicle prose (Phase 3) or the
     *  extras JSON (Phase 4), exactly as its last chunk_done carried it. */
    partial: string
  }
}

export type ReforgeRunOptions = {
  /** Carry on from a stopped run of the SAME input and config. */
  resumeFrom?: ReforgeProgress
  /** Called whenever the finished work grows. */
  onProgress?: (progress: ReforgeProgress) => void
}

const REFORGE_PHASE_OF: Partial<Record<string, ReforgePhase>> = {
  phase3_chronicle: 'phase3',
  phase4_extras: 'phase4',
  phase6_condense: 'phase6',
}

/** Where a resume re-enters a phase part-way, or null to run it from the
 *  start. Condense always restarts: it is short, and the main pipeline does
 *  not resume it mid-phase either, so its per-chunk bookkeeping was never
 *  built to be handed back in. */
export function midPhaseResume(progress: ReforgeProgress | undefined, phase: 'phase3' | 'phase4') {
  const f = progress?.inFlight
  if (!f || f.phase !== phase || f.nextChunk <= 0 || !f.chunkSizeChars || !f.partial) return null
  return { startChunkIndex: f.nextChunk, chunkSizeChars: f.chunkSizeChars, partial: f.partial }
}

/** True when a stopped run left anything a resume would not redo. */
export function hasResumableWork(progress: ReforgeProgress | null | undefined): boolean {
  if (!progress) return false
  if (progress.chronicle !== undefined || progress.extras) return true
  return !!(midPhaseResume(progress, 'phase3') || midPhaseResume(progress, 'phase4'))
}

function parseExtras(partial: string): ExtrasOutput | null {
  const parsed = tryParseJson<Partial<ExtrasOutput>>(partial, '{')
  if (!parsed || !Array.isArray(parsed.jests) || !Array.isArray(parsed.gore) || !Array.isArray(parsed.quotes)) {
    return null
  }
  return { jests: parsed.jests, gore: parsed.gore, quotes: parsed.quotes }
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

/** How many of the selected phases a resume will not need to run at all. */
export function phasesAlreadyDone(config: ReforgeConfig, progress: ReforgeProgress | undefined): number {
  if (!progress) return 0
  return (
    (config.regenerateChronicle && progress.chronicle !== undefined ? 1 : 0) +
    (config.doExtras && progress.extras ? 1 : 0)
  )
}

/** Re-run the chosen downstream phases on the configured provider. Throws on a
 *  gating violation (call validateReforge first) or on a phase failure; by
 *  then `opts.onProgress` has been told everything that finished. */
export async function runReforge(
  input: ReforgeInput,
  config: ReforgeConfig,
  userCallbacks: PipelineCallbacks,
  opts: ReforgeRunOptions = {},
): Promise<ReforgeResult> {
  const reason = validateReforge(input, config)
  if (reason) throw new Error(reason)

  const resume = opts.resumeFrom
  const copy = (p: ReforgeProgress): ReforgeProgress => ({
    ...p,
    ...(p.inFlight ? { inFlight: { ...p.inFlight } } : {}),
  })
  // A resume starts out holding everything the stopped run kept, so failing
  // again early — before the resumed phase has even started — loses nothing.
  const progress: ReforgeProgress = resume ? copy(resume) : {}
  const report = () => opts.onProgress?.(copy(progress))
  const finishPhase = (phase: ReforgePhase, patch: Pick<ReforgeProgress, 'chronicle' | 'extras'>) => {
    Object.assign(progress, patch)
    if (progress.inFlight?.phase === phase) delete progress.inFlight
    report()
  }
  // Follow the phases' own events: phase_start says how the source was split,
  // each chunk_done carries the running output up to and including that chunk.
  const callbacks: PipelineCallbacks = {
    ...userCallbacks,
    onEvent: (e) => {
      const phase = 'phase' in e ? REFORGE_PHASE_OF[e.phase] : undefined
      if (phase && e.type === 'phase_start') {
        const start = e.startChunkIndex ?? 0
        // A resumed phase starts out holding what the stopped run finished, so
        // failing again before its first new chunk still loses nothing.
        const carried = resume?.inFlight?.phase === phase && start > 0 ? resume.inFlight.partial : ''
        progress.inFlight = {
          phase,
          nextChunk: start,
          totalChunks: e.totalChunks,
          chunkSizeChars: e.chunkSizeChars,
          partial: carried,
        }
        report()
      } else if (phase && e.type === 'chunk_done' && progress.inFlight?.phase === phase) {
        progress.inFlight.nextChunk = Math.max(progress.inFlight.nextChunk, e.index + 1)
        progress.inFlight.partial = e.partial
        report()
      }
      userCallbacks.onEvent(e)
    },
  }

  const provider: CloudProvider = config.provider ?? 'gemini'
  const common = {
    cloudProvider: provider,
    geminiTier: config.geminiTier,
    model: config.model,
  }
  /** Routing for one phase: its own override when the caller set one, else the
   *  single top-level choice. Resolved per phase rather than once, so a config
   *  that overrides only extras leaves the other two exactly as they were. */
  const routeFor = (phase: ReforgePhase) => {
    const o = config.phaseModels?.[phase]
    if (!o) return common
    return { cloudProvider: o.provider, geminiTier: o.geminiTier, model: o.model }
  }

  // 1) Chronicle — regenerate or keep.
  let chronicle = input.chronicle
  let chronicleRegenerated = false
  if (config.regenerateChronicle) {
    if (resume?.chronicle !== undefined) {
      chronicle = resume.chronicle
      finishPhase('phase3', { chronicle })
    } else {
      const at = midPhaseResume(resume, 'phase3')
      chronicle = await runPhase3({
        groundedTranscript: input.groundedTranscript!,
        dmQuestions: input.dmQuestions,
        dmAnswers: input.dmAnswers,
        kb: input.kb,
        callbacks,
        ...routeFor('phase3'),
        personaTemplates: config.personaTemplates?.phase3,
        retrieveVaultKb: input.retrieveVaultKb,
        aliasIndex: input.aliasIndex,
        ...(at
          ? { startChunkIndex: at.startChunkIndex, chunkSizeChars: at.chunkSizeChars, priorPartial: at.partial }
          : {}),
      })
      finishPhase('phase3', { chronicle })
    }
    chronicleRegenerated = true
  }

  // 2) Extras — from the grounded transcript (richer) or the chronicle (cheaper).
  let extras: ExtrasOutput | undefined
  if (config.doExtras) {
    if (resume?.extras) {
      extras = resume.extras
      finishPhase('phase4', { extras })
    } else {
      const fromChronicle = config.extrasSource === 'chronicle'
      const at = midPhaseResume(resume, 'phase4')
      const priorExtras = at ? parseExtras(at.partial) : null
      extras = await runPhase4({
        groundedTranscript: fromChronicle ? chronicle : input.groundedTranscript!,
        dmAnswers: input.dmAnswers,
        kb: input.kb,
        callbacks,
        ...routeFor('phase4'),
        extrasSourceKind: fromChronicle ? 'chronicle' : 'transcript',
        // Unreadable carried extras mean starting the phase over, never
        // resuming with a hole where the finished chunks were.
        ...(at && priorExtras
          ? { startChunkIndex: at.startChunkIndex, chunkSizeChars: at.chunkSizeChars, priorExtras }
          : {}),
      })
      finishPhase('phase4', { extras })
    }
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
      ...routeFor('phase6'),
      personaTemplates: config.personaTemplates?.phase6,
      retrieveVaultKb: input.retrieveVaultKb,
      aliasIndex: input.aliasIndex,
      targetWordCount,
    })
  }

  return { chronicle, extras, condensed, chronicleRegenerated }
}
