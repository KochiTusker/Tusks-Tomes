import { useEffect, useRef, type RefObject } from 'react'
import { toast } from 'sonner'
import { saveChronicle, updateChronicle } from '@/features/library'
import { getRouting } from '@/features/routing'
import type { RefinementState } from '@/features/pipeline/lib/types'
import type { RefinementActions } from './useRefinementState'

export function useChronicleAutoSave({
  state,
  actions,
  stateRef,
  campaign,
  sessionNumber,
}: {
  state: RefinementState
  actions: RefinementActions
  stateRef: RefObject<RefinementState>
  campaign: string
  sessionNumber: number
}): void {
  // Auto-save a finished run to the Saved Chronicles library (server disk
  // store) so it can never be lost to a reload / dev-server restart /
  // browser-cache clear. Saves once on completion, then UPDATEs the same
  // record when extras / condensed are generated afterwards (tracked via
  // state.savedChronicleId). reset() clears savedChronicleId, so the next
  // run gets its own entry and the previous one stays on disk (auto-keep
  // both). Best-effort — a save failure surfaces a toast but never blocks.
  const chronicleSavingRef = useRef(false)
  useEffect(() => {
    if (state.status !== 'done') return
    if (!state.chronicle.trim()) return
    if (chronicleSavingRef.current) return
    let cancelled = false
    chronicleSavingRef.current = true
    void (async () => {
      try {
        const existingId = stateRef.current.savedChronicleId
        if (existingId) {
          await updateChronicle(existingId, {
            chronicle: state.chronicle,
            extras: state.extras ?? undefined,
            condensed: state.condensed ?? undefined,
            groundedTranscript: state.groundedTranscript || undefined,
            refusals: stateRef.current.refusals ?? undefined,
            dmQuestions: stateRef.current.dmQuestions ?? undefined,
            dmAnswers: stateRef.current.dmAnswers ?? undefined,
          })
        } else {
          let provider: string | undefined
          try {
            provider = (await getRouting()).lastSelectedProvider ?? undefined
          } catch {
            /* metadata only — fine to omit */
          }
          const saved = await saveChronicle({
            campaign,
            sessionNumber,
            provider,
            chronicle: state.chronicle,
            extras: state.extras ?? undefined,
            condensed: state.condensed ?? undefined,
            groundedTranscript: state.groundedTranscript || undefined,
            refusals: stateRef.current.refusals ?? undefined,
            dmQuestions: stateRef.current.dmQuestions ?? undefined,
            dmAnswers: stateRef.current.dmAnswers ?? undefined,
          })
          if (!cancelled) {
            actions.setSavedChronicleId(saved.id)
            toast.success('Chronicle saved to your library (Tome of Lore → Saved Chronicles).')
          }
        }
      } catch (err) {
        toast.error(`Couldn't auto-save the chronicle to your library: ${(err as Error).message}`)
      } finally {
        chronicleSavingRef.current = false
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status, state.chronicle, state.extras, state.condensed])
}
