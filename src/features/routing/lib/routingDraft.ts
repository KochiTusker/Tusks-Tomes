import type { RoutingDocument } from '@/features/routing/lib/routing'

/** What the routing editor parks when it unmounts with unsaved edits. */
export type RoutingDraft = {
  /** JSON of the committed document the edits were made against. */
  base: string
  routing: RoutingDocument
}

/**
 * Whether a parked draft should be offered back on top of the committed
 * document as it stands now.
 *
 * `restore` only when the draft was edited against exactly this document and
 * differs from it. A draft made against an older document is discarded:
 * routing.json has other writers — the setup wizard, a fallback flip, a
 * resumed session — and restoring over their work would revert it at the next
 * Save. Anything malformed, an older shape or a stray value, is discarded too,
 * so the key cannot stick.
 */
export function decideDraftRestore(
  draft: unknown,
  committedJson: string,
): 'restore' | 'discard' | 'none' {
  if (draft === null || draft === undefined) return 'none'
  if (typeof draft !== 'object') return 'discard'
  const d = draft as Partial<RoutingDraft>
  if (!d.routing || typeof d.base !== 'string') return 'discard'
  if (d.base !== committedJson) return 'discard'
  return JSON.stringify(d.routing) === committedJson ? 'none' : 'restore'
}
