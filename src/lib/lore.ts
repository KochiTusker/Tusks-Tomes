// React-side client for /api/lore — Tusks-Lore sibling detection +
// chronicle .docx export.

import type { ExtrasOutput, CondenseOutput } from '@/types'

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
  const res = await fetch('/api/lore/status')
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`GET /api/lore/status failed: HTTP ${res.status}. ${body.slice(0, 200)}`)
  }
  return (await res.json()) as LoreStatus
}

export async function createLoreFolder(): Promise<LoreStatus> {
  const res = await fetch('/api/lore/create', { method: 'POST' })
  if (!res.ok) {
    let message = `HTTP ${res.status}`
    try {
      const body = (await res.json()) as { error?: string }
      if (body.error) message = body.error
    } catch { /* ignore */ }
    throw new Error(message)
  }
  return (await res.json()) as LoreStatus
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
  const res = await fetch('/api/lore/save-chronicle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })
  if (!res.ok) {
    let message = `HTTP ${res.status}`
    try {
      const body = (await res.json()) as { error?: string }
      if (body.error) message = body.error
    } catch { /* ignore */ }
    throw new Error(message)
  }
  return (await res.json()) as LoreSaveResult
}
