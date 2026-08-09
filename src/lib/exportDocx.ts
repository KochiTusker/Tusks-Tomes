// Client helper for the formatted .docx download. POSTs the chronicle (plus
// extras / condensed) to /api/chronicle/docx and triggers a browser download
// of the returned Word document. The server reuses the same renderer as the
// Lore export, so the formatting matches — but this path needs no Lore folder
// and works on any run (including a reforge result).

import type { CondenseOutput, ExtrasOutput } from '@/types'

export type DocxExportArgs = {
  campaign: string
  sessionNumber: number
  chronicle: string
  extras: ExtrasOutput | null
  condensed: CondenseOutput | null
  /** 'full' = Chronicle + Condensed + Recap + extras; 'condensed' = condensed
   *  narrative + recap + extras only. */
  mode: 'full' | 'condensed'
}

/** Fetch the rendered .docx and save it via a transient object URL. Throws on
 *  a non-OK response so callers can surface a toast. */
export async function downloadChronicleDocx(args: DocxExportArgs): Promise<void> {
  const res = await fetch('/api/chronicle/docx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `Download failed (HTTP ${res.status})`)
  }

  const blob = await res.blob()
  const base = `${(args.campaign || 'campaign').replace(/[^\w-]+/g, '_')}-session-${args.sessionNumber}${args.mode === 'condensed' ? '-condensed' : ''}`
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${base}.docx`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
