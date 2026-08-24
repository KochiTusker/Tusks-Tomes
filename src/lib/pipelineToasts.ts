// Shared toast helpers for pipeline pre-processing events emitted by both
// RefinementTool and CaptionRepair (identical messages for cleanup and
// pre-grounding phases).
import { toast } from 'sonner'
import type { CleanupReport } from './transcriptCleanup'
import type { PreGroundReport } from './preGround'

export function showCleanupToast(r: CleanupReport): void {
  const bits: string[] = []
  if (r.markersStripped)
    bits.push(`${r.markersStripped} marker${r.markersStripped === 1 ? '' : 's'} stripped`)
  if (r.fillersCollapsed)
    bits.push(`${r.fillersCollapsed} filler run${r.fillersCollapsed === 1 ? '' : 's'} collapsed`)
  if (r.whitespaceNormalized) bits.push('whitespace normalized')
  if (!bits.length) return
  toast.message('Transcript cleanup complete', { description: bits.join(' · '), duration: 5000 })
}

export function showPreGroundToast(r: PreGroundReport): void {
  const summary = r.perRule
    .slice(0, 3)
    .map((p) => `${p.from}→${p.to} ×${p.count}`)
    .join(', ')
  toast.success(
    `Pre-corrected ${r.totalReplacements} term${r.totalReplacements === 1 ? '' : 's'} before AI`,
    {
      description: summary + (r.perRule.length > 3 ? `, +${r.perRule.length - 3} more rules` : ''),
      duration: 6000,
    }
  )
}
