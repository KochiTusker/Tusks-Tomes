import { useEffect, useRef, type RefObject } from 'react'
import { toast } from 'sonner'
import { CHRONICLE_LIBRARY_EVENT, getChronicle, saveChronicle, updateChronicle } from '@/features/library'
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
  //
  // The chronicle text can also be edited from Saved Chronicles, so the run
  // sends its chronicle only when the run itself changed it since the last
  // save. A run that is already saved when the page loads counts its current
  // text as saved; resending it would write the older run copy over an edit.
  const chronicleSavingRef = useRef(false)
  const lastSavedChronicleRef = useRef<string | null>(state.savedChronicleId ? state.chronicle : null)
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
          const chronicleChanged = state.chronicle !== lastSavedChronicleRef.current
          await updateChronicle(existingId, {
            ...(chronicleChanged ? { chronicle: state.chronicle } : {}),
            extras: state.extras ?? undefined,
            condensed: state.condensed ?? undefined,
            groundedTranscript: state.groundedTranscript || undefined,
            refusals: stateRef.current.refusals ?? undefined,
            dmQuestions: stateRef.current.dmQuestions ?? undefined,
            dmAnswers: stateRef.current.dmAnswers ?? undefined,
          })
          lastSavedChronicleRef.current = state.chronicle
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
          lastSavedChronicleRef.current = state.chronicle
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

  // An edit made in Saved Chronicles to this run's own entry is taken into
  // the run, so the result view, its Markdown export and any later save all
  // carry the edited text. Skipped while a save is in flight: the server copy
  // may be about to change, and the save's own change event re-checks.
  // `actions` is a fresh object every render; the callback inside it is stable.
  const { completePhase3 } = actions
  useEffect(() => {
    let disposed = false
    async function syncFromLibrary() {
      const id = stateRef.current.savedChronicleId
      if (!id || chronicleSavingRef.current) return
      try {
        const record = await getChronicle(id)
        const text = record.chronicle ?? ''
        if (disposed || chronicleSavingRef.current || !text.trim()) return
        if (text === lastSavedChronicleRef.current || text === stateRef.current.chronicle) return
        lastSavedChronicleRef.current = text
        completePhase3(text)
      } catch {
        // The entry was deleted or the server is unreachable; nothing to take in.
      }
    }
    const onChange = () => void syncFromLibrary()
    window.addEventListener(CHRONICLE_LIBRARY_EVENT, onChange)
    return () => {
      disposed = true
      window.removeEventListener(CHRONICLE_LIBRARY_EVENT, onChange)
    }
  }, [completePhase3, stateRef])
}
