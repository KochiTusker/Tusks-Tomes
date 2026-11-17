// React-side client for /api/lore — Tusks-Lore sibling detection +
// chronicle .docx export.

import { apiJson } from '@/platform/apiClient'
import type { ExtrasOutput, CondenseOutput } from '@/features/pipeline'

export type LoreStatus = {
  found: boolean
  loreRoot?: string
  sessionsDir?: string
  sessionsCount?: number
  writable?: boolean
  source: 'env' | 'sibling' | 'none'
  notes?: string[]
  /** Where "Create Tusk's Lore" would put the folder if clicked. */
  defaultPath?: string
}

export async function getLoreStatus(): Promise<LoreStatus> {
  return apiJson<LoreStatus>('/api/lore/status', { errorMode: 'text', bodySlice: 200 })
}

export async function createLoreFolder(): Promise<LoreStatus> {
  return apiJson<LoreStatus>('/api/lore/create', { method: 'POST', errorMode: 'json' })
}

export type LoreSaveResult = {
  ok: true
  written: string
  relativeToLore: string
  mode: 'full' | 'condensed'
}

export async function saveChronicleToLore(args: {
  campaign: string
  sessionNumber: number
  chronicle: string
  extras: ExtrasOutput | null
  condensed: CondenseOutput | null
  mode: 'full' | 'condensed'
}): Promise<LoreSaveResult> {
  return apiJson<LoreSaveResult>('/api/lore/save-chronicle', {
    method: 'POST',
    body: args,
    errorMode: 'json',
  })
}
