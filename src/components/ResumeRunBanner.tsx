// Banner shown above the Chronicle tab when one or more paused runs are
// on disk. Click "Resume" to pick up at the exact chunk the prior session
// stopped on — handy after a Gemini free-tier daily quota refills overnight.
//
// The banner self-loads on mount and auto-hides when the list is empty.

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { PlayCircle, Trash2, History } from 'lucide-react'
import { deleteRun, listRuns } from '@/lib/runStorage'
import { CHECKPOINT_SCHEMA_VERSION, type RunCheckpointSummary } from '@/lib/runCheckpoint'

const PHASE_LABEL: Record<number, string> = {
  1: 'Phase 1 — Grounding',
  2: 'Phase 2 — Audit',
  3: 'Phase 3 — Chronicle',
  4: 'Phase 4 — Extras',
  6: 'Phase 6 — Condense',
}

function fmtRelative(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const minutes = Math.floor((Date.now() - d.getTime()) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

type Props = {
  onResume: (runId: string) => void
}

export function ResumeRunBanner({ onResume }: Props) {
  const [runs, setRuns] = useState<RunCheckpointSummary[]>([])
  const [loading, setLoading] = useState(true)

  const reload = async () => {
    try {
      const r = await listRuns()
      setRuns(r)
    } catch (err) {
      console.warn('[ResumeRunBanner] listRuns failed:', err)
      setRuns([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void reload()
  }, [])

  if (loading || runs.length === 0) return null

  const handleDelete = async (runId: string) => {
    try {
      await deleteRun(runId)
      toast.success('Checkpoint deleted.')
      await reload()
    } catch (err) {
      toast.error(`Delete failed: ${(err as Error).message}`)
    }
  }

  return (
    <Card className="border-violet-500/40 bg-violet-500/5">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <History className="h-4 w-4 text-violet-500" />
          {runs.length === 1 ? '1 paused run' : `${runs.length} paused runs`} on disk
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {runs.map((run) => {
          const incompatible = run.schemaVersion !== CHECKPOINT_SCHEMA_VERSION
          const phaseLabel = PHASE_LABEL[run.progress.phase] ?? `Phase ${run.progress.phase}`
          return (
            <div
              key={run.runId}
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-violet-500/20 bg-background/60 p-3"
            >
              <div className="min-w-0 flex-1">
                <div className="font-medium">
                  {run.campaign || 'Untitled campaign'} — Session {run.sessionNumber}
                </div>
                <div className="text-xs text-muted-foreground">
                  Paused {fmtRelative(run.pausedAt)} · {phaseLabel} · chunk{' '}
                  {run.progress.chunkIndex + 1}/{run.progress.totalChunks}
                  {run.pausedReason === 'quota' ? ' · quota hit' : ''}
                </div>
                {incompatible && (
                  <p className="mt-1 text-xs text-amber-600">
                    Saved by an older version of Tomes (schema v{run.schemaVersion}). Cannot resume —
                    export the partial output instead, then delete.
                  </p>
                )}
              </div>
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="default"
                  disabled={incompatible}
                  onClick={() => onResume(run.runId)}
                >
                  <PlayCircle className="mr-1 h-4 w-4" />
                  Resume
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void handleDelete(run.runId)}
                  title="Discard this checkpoint"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
