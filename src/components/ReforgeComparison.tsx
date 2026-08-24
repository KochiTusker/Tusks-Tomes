// Old-vs-new comparison for a reforge result. Renders the pre-reforge outputs
// (the "original") beside the freshly-reforged outputs so the user can judge
// the difference directly — most importantly whether the condensed length now
// matches what they asked for, plus how the extras counts changed.
//
// The original side is only populated when reforging a saved library record
// (or iterating on a prior reforge); a bare paste has nothing to compare to,
// in which case ReforgePanel doesn't mount this at all.

import { useState } from 'react'
import { ChevronDown, ChevronRight, GitCompare } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { countWords } from '@/lib/wordCount'
import { quoteToPlainText } from '@/lib/quotes'
import type { CondenseOutput, ExtrasOutput } from '@/types'

type Side = {
  chronicle: string
  extras: ExtrasOutput | null
  condensed: CondenseOutput | null
}

type Props = {
  original: Side
  reforged: Side
}

function delta(before: number, after: number): string {
  const d = after - before
  if (d === 0) return '±0'
  return d > 0 ? `+${d.toLocaleString()}` : d.toLocaleString()
}

function StatRow({ label, before, after }: { label: string; before: number; after: number }) {
  return (
    <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-2 py-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono tabular-nums">{before.toLocaleString()}</span>
      <span className="text-muted-foreground">→</span>
      <span className="font-mono tabular-nums">
        {after.toLocaleString()}{' '}
        <span className={after - before > 0 ? 'text-emerald-600 dark:text-emerald-400' : after - before < 0 ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}>
          ({delta(before, after)})
        </span>
      </span>
    </div>
  )
}

function TextCompare({ title, before, after }: { title: string; before: string; after: string }) {
  return (
    <div>
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</div>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded border border-border p-2">
          <div className="mb-1 text-xs text-muted-foreground">Original · {countWords(before).toLocaleString()} words</div>
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{before.trim() || '—'}</p>
        </div>
        <div className="rounded border border-emerald-500/40 p-2">
          <div className="mb-1 text-xs text-emerald-700 dark:text-emerald-300">Reforged · {countWords(after).toLocaleString()} words</div>
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{after.trim() || '—'}</p>
        </div>
      </div>
    </div>
  )
}

function ListCompare({ title, before, after }: { title: string; before: string[]; after: string[] }) {
  if (!before.length && !after.length) return null
  return (
    <div>
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title} — {before.length} → {after.length}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <ul className="list-disc space-y-0.5 rounded border border-border p-2 pl-6 text-sm">
          {before.length ? before.map((b, i) => <li key={i}>{b}</li>) : <li className="list-none text-muted-foreground">—</li>}
        </ul>
        <ul className="list-disc space-y-0.5 rounded border border-emerald-500/40 p-2 pl-6 text-sm">
          {after.length ? after.map((a, i) => <li key={i}>{a}</li>) : <li className="list-none text-muted-foreground">—</li>}
        </ul>
      </div>
    </div>
  )
}

export function ReforgeComparison({ original, reforged }: Props) {
  const [open, setOpen] = useState(true)

  const oCond = original.condensed
  const rCond = reforged.condensed
  const oExtras = original.extras
  const rExtras = reforged.extras

  return (
    <Card>
      <CardHeader className="cursor-pointer py-3" onClick={() => setOpen((o) => !o)}>
        <CardTitle className="flex items-center gap-2 text-base">
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          <GitCompare className="h-4 w-4" /> Compare original vs reforged
        </CardTitle>
      </CardHeader>
      {open && (
        <CardContent className="space-y-4">
          {/* At-a-glance numbers. */}
          <div className="rounded-md border border-border p-3">
            <div className="mb-1 grid grid-cols-[1fr_auto_auto_auto] gap-2 text-xs font-semibold text-muted-foreground">
              <span>Metric</span>
              <span>Original</span>
              <span />
              <span>Reforged</span>
            </div>
            <StatRow label="Chronicle (words)" before={countWords(original.chronicle)} after={countWords(reforged.chronicle)} />
            <StatRow label="Condensed narrative (words)" before={countWords(oCond?.narrative ?? '')} after={countWords(rCond?.narrative ?? '')} />
            <StatRow label="Recap bullets" before={oCond?.bulletPoints.length ?? 0} after={rCond?.bulletPoints.length ?? 0} />
            <StatRow label="Jests" before={oExtras?.jests.length ?? 0} after={rExtras?.jests.length ?? 0} />
            <StatRow label="Gore" before={oExtras?.gore.length ?? 0} after={rExtras?.gore.length ?? 0} />
            <StatRow label="Quotes" before={oExtras?.quotes.length ?? 0} after={rExtras?.quotes.length ?? 0} />
          </div>

          {(oCond?.narrative || rCond?.narrative) && (
            <TextCompare title="Condensed narrative" before={oCond?.narrative ?? ''} after={rCond?.narrative ?? ''} />
          )}
          {(oCond?.bulletPoints.length || rCond?.bulletPoints.length) && (
            <ListCompare title="Catch-up recap" before={oCond?.bulletPoints ?? []} after={rCond?.bulletPoints ?? []} />
          )}
          {(oExtras?.jests.length || rExtras?.jests.length) ? (
            <ListCompare title="Jests" before={oExtras?.jests ?? []} after={rExtras?.jests ?? []} />
          ) : null}
          {(oExtras?.gore.length || rExtras?.gore.length) ? (
            <ListCompare title="Gore" before={oExtras?.gore ?? []} after={rExtras?.gore ?? []} />
          ) : null}
          {(oExtras?.quotes.length || rExtras?.quotes.length) ? (
            <ListCompare
              title="Quotes"
              before={(oExtras?.quotes ?? []).map(quoteToPlainText)}
              after={(rExtras?.quotes ?? []).map(quoteToPlainText)}
            />
          ) : null}
        </CardContent>
      )}
    </Card>
  )
}
