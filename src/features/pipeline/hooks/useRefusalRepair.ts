import { useCallback, type RefObject } from 'react'
import { toast } from 'sonner'
import type { GeminiTier } from '@/features/providers'
import { updateChronicle } from '@/features/library'
import { buildKbConcat } from '@/features/pipeline/lib/pipeline'
import {
  repairRefusal,
  spliceProse,
  mergeQuestions,
  mergeExtras,
  type RepairContext,
} from '@/features/pipeline/lib/repair'
import type { RefusalRecord } from '@/features/pipeline/lib/refusalDetection'
import type { KBDocument, RefinementState } from '@/features/pipeline/lib/types'
import type { RefinementActions } from './useRefinementState'

export function useRefusalRepair({
  actions,
  kb,
  stateRef,
}: {
  actions: RefinementActions
  kb: KBDocument[]
  stateRef: RefObject<RefinementState>
}): (rec: RefusalRecord, opts: { geminiTier: GeminiTier }) => Promise<{ ok: boolean; reason?: string }> {
  /** Re-process ONE unrepaired Claude Code refusal on a chosen Gemini tier and
   *  fold the result back into the run state + Saved Chronicle. Returns
   *  {ok:false, reason} on any failure so the panel can surface it (never a
   *  silent no-op — the original bug). */
  const handleRepairRefusal = useCallback(
    async (
      rec: RefusalRecord,
      opts: { geminiTier: GeminiTier },
    ): Promise<{ ok: boolean; reason?: string }> => {
      const s = stateRef.current
      const ctx: RepairContext = {
        groundedTranscript: s.groundedTranscript,
        rawTranscript: s.rawTranscript,
        chronicle: s.chronicle,
        dmQuestions: s.dmQuestions,
        dmAnswers: s.dmAnswers,
        kbConcat: buildKbConcat(kb),
        campaign: s.campaign,
        sessionNumber: s.sessionNumber,
        targetWordCount: undefined,
      }
      const outcome = await repairRefusal(rec, ctx, { geminiTier: opts.geminiTier })
      if (!outcome.ok) return { ok: false, reason: outcome.reason }

      // Compute the NEW field values into locals first (stateRef.current won't
      // reflect actions.* until after the next render), apply via actions, AND
      // persist the locals so the library write isn't stale.
      let nextChronicle = s.chronicle
      let nextGrounded = s.groundedTranscript
      let nextDmQuestions = s.dmQuestions
      let nextExtras = s.extras
      let nextCondensed = s.condensed

      if (outcome.kind === 'prose') {
        if (rec.phase === 'phase3_chronicle') {
          const { doc, found } = spliceProse(s.chronicle, rec.marker, outcome.text)
          if (!found) {
            return {
              ok: false,
              reason: 'Repaired text generated, but the marker was no longer in the chronicle (was it edited?).',
            }
          }
          nextChronicle = doc
          actions.completePhase3(doc)
        } else if (rec.phase === 'phase1_ground') {
          const { doc, found } = spliceProse(s.groundedTranscript, rec.sourceSpan, outcome.text)
          if (!found) {
            return {
              ok: false,
              reason: 'Re-grounded text generated, but the original span was no longer in the grounded transcript.',
            }
          }
          nextGrounded = doc
          actions.completePhase1(doc)
        }
      } else if (outcome.kind === 'questions') {
        nextDmQuestions = mergeQuestions(s.dmQuestions, outcome.questions)
        actions.setDMQuestions(nextDmQuestions)
      } else if (outcome.kind === 'extras') {
        const base = s.extras ?? { jests: [], gore: [], quotes: [] }
        nextExtras = mergeExtras(base, outcome.extras)
        actions.completePhase4(nextExtras)
      } else if (outcome.kind === 'condense') {
        nextCondensed = s.condensed
          ? {
              narrative: [s.condensed.narrative, outcome.condensed.narrative].filter(Boolean).join('\n\n'),
              bulletPoints: [...s.condensed.bulletPoints, ...outcome.condensed.bulletPoints],
            }
          : outcome.condensed
        actions.completePhase6(nextCondensed)
      }

      // Flip this refusal to repaired in the persisted manifest. Read the
      // freshest manifest (handleRepairRefusal is awaited sequentially, incl.
      // inside "Repair all", so stateRef is current at each call).
      const nextRefusals = (stateRef.current.refusals ?? []).map((r) =>
        r.id === rec.id ? { ...r, repaired: true } : r,
      )
      actions.setRefusals(nextRefusals)

      // Persist the updated outputs + manifest to the Saved Chronicle.
      const savedId = s.savedChronicleId
      if (savedId) {
        try {
          await updateChronicle(savedId, {
            chronicle: nextChronicle,
            extras: nextExtras ?? undefined,
            condensed: nextCondensed ?? undefined,
            groundedTranscript: nextGrounded || undefined,
            refusals: nextRefusals,
            dmQuestions: nextDmQuestions ?? undefined,
            dmAnswers: s.dmAnswers ?? undefined,
          })
        } catch (err) {
          // The in-memory repair succeeded; only the library write failed.
          // Surface it but don't claim the whole repair failed.
          toast.warning(`Repaired, but couldn't update the saved library copy: ${(err as Error).message}`)
        }
      }
      return { ok: true }
    },
    [actions, kb],
  )
  return handleRepairRefusal
}
