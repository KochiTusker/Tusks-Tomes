// Targeted repair of UNREPAIRED Claude Code refusals. Re-processes ONE refused
// chunk on a working provider (paid Gemini by default), reusing the exact phase
// prompt builders so the output matches the rest of the run. Pure-ish: the
// runner does the provider call + parse and returns a typed outcome; the caller
// (ChronicleView/RefinementTool) applies the splice/merge to its state via the
// `splice*`/`merge*` helpers below, then persists.
//
// See src/lib/refusalDetection.ts (RefusalRecord) and the manifest plumbing in
// the pipeline for how refusals are recorded in the first place.

import type { RefusalRecord } from './refusalDetection'
import { detectRefusal } from './refusalDetection'
import { getCloudProvider, type GeminiTier } from './providers'
import type { GenerateRequest, LLMProvider } from './providers/llm'
import { MAX_OUTPUT_TOKENS } from './constants'
import { chunkText } from './chunker'
import { tryParseJson } from './jsonExtract'
import {
  phase1GroundParts,
  phase2Audit,
  phase3ChronicleParts,
  phase4Extras,
  phase6CondenseParts,
} from './prompts'
import { proportionalChunkTarget } from './wordCount'
import { appendNovelQuotes, normalizeQuotes } from './quotes'
import type { CondenseOutput, DMAnswers, DMQuestion, ExtrasOutput } from '@/types'

/** Everything a repair might need from the finished run. The caller (which has
 *  the live run state OR a SavedChronicle) assembles this. `rawTranscript` is
 *  only needed to repair Phase 2 (audit pairs raw with grounded); the rest of
 *  the phases work from `groundedTranscript`/`chronicle`/`sourceSpan`. */
export type RepairContext = {
  groundedTranscript: string
  rawTranscript: string
  chronicle: string
  dmQuestions: DMQuestion[]
  dmAnswers: DMAnswers
  /** Pre-built KB concatenation (caller builds from KB docs). */
  kbConcat: string
  campaign?: string
  sessionNumber?: number
  /** Phase 6 only — desired condensed length. */
  targetWordCount?: number
}

export type RepairOptions = {
  /** Which Gemini key tier to use. Defaults to 'paid' (the whole point of the
   *  repair flow is to use a working paid key). */
  geminiTier?: GeminiTier
  /** Model override. Defaults to gemini-2.5-pro for prose phases, flash for
   *  the JSON phases. */
  model?: string
  signal?: AbortSignal
}

export type RepairOutcome =
  | { ok: true; kind: 'prose'; text: string }
  | { ok: true; kind: 'questions'; questions: DMQuestion[] }
  | { ok: true; kind: 'extras'; extras: ExtrasOutput }
  | { ok: true; kind: 'condense'; condensed: CondenseOutput }
  | { ok: false; reason: string; stillRefused?: boolean }

const PROSE_PHASES = new Set(['phase1_ground', 'phase3_chronicle'])

/** Reconstruct the Phase 3 priorTail (the rolling 2000-char window of narrative
 *  the original loop fed each chunk — see pipeline runPhase3) from the chronicle
 *  text BEFORE the marker. Falls back to the chronicle tail when the marker
 *  isn't found, so a repair still gets continuity context. */
export function priorTailBeforeMarker(chronicle: string, marker: string): string {
  const idx = marker ? chronicle.indexOf(marker) : -1
  const before = idx >= 0 ? chronicle.slice(0, idx) : chronicle
  return before.slice(-2000)
}

function defaultModel(phase: string, override?: string): string {
  if (override) return override
  return PROSE_PHASES.has(phase) ? 'gemini-2.5-pro' : 'gemini-2.5-flash'
}

async function generateOnce(
  provider: LLMProvider,
  req: GenerateRequest,
  opts: RepairOptions,
  label: string,
): Promise<string> {
  const res = await provider.generate(req, { signal: opts.signal, contextLabel: label })
  return res.text ?? ''
}

/** Re-process a single refused chunk. Returns the typed output to splice/merge,
 *  or {ok:false} with a human reason (e.g. missing key, still-refused, non-JSON)
 *  — repairs NEVER silently no-op, that was the original bug. */
export async function repairRefusal(
  rec: RefusalRecord,
  ctx: RepairContext,
  opts: RepairOptions = {},
): Promise<RepairOutcome> {
  const tier = opts.geminiTier ?? 'paid'
  const provider = getCloudProvider('gemini', { geminiTier: tier })
  const hasKey = (provider as { hasKey?: () => boolean }).hasKey?.() ?? false
  if (!hasKey) {
    return {
      ok: false,
      reason: `No ${tier} Gemini key configured. Add one in Settings → API Keys, then retry.`,
    }
  }

  const model = defaultModel(rec.phase, opts.model)
  const total = rec.totalChunks || 1
  const i = rec.chunkIndex
  const baseReq = {
    model,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    safetyMode: 'permissive' as const,
    systemPrompt: '',
  }
  const label = `Repair ${rec.phase} chunk ${i + 1}/${total} [gemini ${tier}]`

  try {
    if (rec.phase === 'phase3_chronicle') {
      const parts = phase3ChronicleParts({
        groundedChunk: rec.sourceSpan,
        dmAnswers: ctx.dmAnswers,
        dmQuestions: ctx.dmQuestions,
        index: i,
        total,
        priorTail: priorTailBeforeMarker(ctx.chronicle, rec.marker),
      })
      const text = await generateOnce(
        provider,
        { ...baseReq, cacheablePrefix: parts.cacheablePrefix, userPrompt: parts.userPrompt },
        opts,
        label,
      )
      if (detectRefusal(text, parts.userPrompt.length).refused) {
        return { ok: false, reason: 'Gemini also returned a refusal/empty for this chunk.', stillRefused: true }
      }
      return { ok: true, kind: 'prose', text: text.trim() }
    }

    if (rec.phase === 'phase1_ground') {
      const parts = phase1GroundParts({
        chunk: rec.sourceSpan,
        kbConcat: ctx.kbConcat,
        index: i,
        total,
      })
      const text = await generateOnce(
        provider,
        { ...baseReq, cacheablePrefix: parts.cacheablePrefix, userPrompt: parts.userPrompt },
        opts,
        label,
      )
      if (detectRefusal(text, parts.userPrompt.length).refused) {
        return { ok: false, reason: 'Gemini also returned a refusal/empty for this chunk.', stillRefused: true }
      }
      return { ok: true, kind: 'prose', text: text.trim() }
    }

    if (rec.phase === 'phase2_audit') {
      // Audit pairs raw with grounded. The grounded span is stored; re-derive
      // the raw span by re-chunking the raw transcript at the recorded size
      // (chunkText is deterministic → same index = same span).
      const rawChunk =
        rec.chunkSizeChars != null
          ? (chunkText(ctx.rawTranscript, rec.chunkSizeChars)[i] ?? rec.sourceSpan)
          : rec.sourceSpan
      const userPrompt = phase2Audit({ rawChunk, groundedChunk: rec.sourceSpan, index: i, total })
      const text = await generateOnce(provider, { ...baseReq, userPrompt }, opts, label)
      const parsed = tryParseJson<DMQuestion[]>(text, '[')
      if (!Array.isArray(parsed)) {
        return { ok: false, reason: 'Gemini returned non-JSON for the audit chunk.' }
      }
      const questions = parsed
        .filter((q) => q && typeof q === 'object' && q.question)
        .map((q, j) => ({
          id: q.id || `q-repair-${i + 1}-${j + 1}`,
          question: q.question,
          context: q.context,
        }))
      return { ok: true, kind: 'questions', questions }
    }

    if (rec.phase === 'phase4_extras') {
      const userPrompt = phase4Extras({ groundedChunk: rec.sourceSpan, dmAnswers: ctx.dmAnswers, index: i, total })
      const text = await generateOnce(provider, { ...baseReq, userPrompt }, opts, label)
      const parsed = tryParseJson<ExtrasOutput>(text, '{')
      if (!parsed) return { ok: false, reason: 'Gemini returned non-JSON for the extras chunk.' }
      return {
        ok: true,
        kind: 'extras',
        extras: {
          jests: Array.isArray(parsed.jests) ? parsed.jests.filter((j): j is string => Boolean(j)) : [],
          gore: Array.isArray(parsed.gore) ? parsed.gore.filter((g): g is string => Boolean(g)) : [],
          quotes: normalizeQuotes(parsed.quotes),
        },
      }
    }

    if (rec.phase === 'phase6_condense') {
      // The span is one chunk of the full chronicle. Target only its
      // proportional share of the whole condensed length, mirroring the
      // per-chunk split runPhase6 applies — otherwise re-condensing one span
      // to the whole target would overshoot.
      const chunkTargetWordCount = proportionalChunkTarget(
        ctx.targetWordCount,
        rec.sourceSpan.length,
        ctx.chronicle.length,
      )
      const parts = phase6CondenseParts({
        chronicle: rec.sourceSpan,
        campaign: ctx.campaign ?? '',
        sessionNumber: ctx.sessionNumber ?? 0,
        kbConcat: ctx.kbConcat,
        dmAnswers: ctx.dmAnswers,
        targetWordCount: ctx.targetWordCount,
        chunkTargetWordCount,
      })
      const text = await generateOnce(
        provider,
        { ...baseReq, cacheablePrefix: parts.cacheablePrefix, userPrompt: parts.userPrompt },
        opts,
        label,
      )
      const parsed = tryParseJson<CondenseOutput>(text, '{')
      if (!parsed) return { ok: false, reason: 'Gemini returned non-JSON for the condense chunk.' }
      return {
        ok: true,
        kind: 'condense',
        condensed: {
          narrative: typeof parsed.narrative === 'string' ? parsed.narrative : '',
          bulletPoints: Array.isArray(parsed.bulletPoints)
            ? parsed.bulletPoints.filter((b): b is string => typeof b === 'string')
            : [],
        },
      }
    }

    return { ok: false, reason: `Repair is not supported for phase "${rec.phase}".` }
  } catch (err) {
    return { ok: false, reason: (err as Error)?.message ?? String(err) }
  }
}

// ───────────────────── pure apply helpers ─────────────────────
// The UI calls these to fold a successful outcome into its state, then persists.

/** Splice repaired prose into a document by replacing the anchor (Phase 3's
 *  marker, or Phase 1's passthrough source span). Returns the new document and
 *  whether the anchor was found (false → the UI should warn rather than
 *  silently lose the repair). */
export function spliceProse(doc: string, anchor: string, replacement: string): { doc: string; found: boolean } {
  if (!anchor || !doc.includes(anchor)) return { doc, found: false }
  return { doc: doc.replace(anchor, replacement), found: true }
}

/** Merge repaired audit questions into the existing set, deduped by normalised
 *  question text — matches the pipeline's Phase 2 dedup. */
export function mergeQuestions(existing: DMQuestion[], incoming: DMQuestion[]): DMQuestion[] {
  const seen = new Set(existing.map((q) => q.question.trim().toLowerCase()))
  const novel = incoming.filter((q) => !seen.has(q.question.trim().toLowerCase()))
  return [...existing, ...novel]
}

/** Merge repaired extras into the existing set, deduped like the pipeline
 *  (jest/gore exact-string, quotes by speaker+line — per exchange turn too). */
export function mergeExtras(existing: ExtrasOutput, incoming: ExtrasOutput): ExtrasOutput {
  const seenJests = new Set(existing.jests)
  const seenGore = new Set(existing.gore)
  return {
    jests: [...existing.jests, ...incoming.jests.filter((j) => !seenJests.has(j))],
    gore: [...existing.gore, ...incoming.gore.filter((g) => !seenGore.has(g))],
    quotes: appendNovelQuotes(existing.quotes, incoming.quotes),
  }
}
