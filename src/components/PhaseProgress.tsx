import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Button } from '@/components/ui/button'
import { Download, Loader2, X } from 'lucide-react'
import { formatDuration, useEta } from '@/hooks/useEta'
import type { PhaseId } from '@/types'
import { PhaseRail, type RailLiveState } from './PhaseRail'
import type { RunSession } from '@/lib/sessions'

const PHASE_LABEL: Record<PhaseId, string> = {
  phase1_ground: 'Phase 1 — Grounding transcript against Knowledge Base',
  phase2_audit: 'Phase 2 — Auditing for clarification questions',
  phase3_chronicle: 'Phase 3 — Generating chronicle',
  phase5_polish: 'Phase 5 — Polishing chronicle (final review)',
  phase4_extras: 'Phase 4 — Extracting jests, gore, and quotes',
  phase6_condense: 'Phase 6 — Condensing chronicle and building recap',
}

// Display order — Phase 5 polish runs between 3 and 4 in the pipeline so
// extras come from the polished chronicle, not the rough chunked output.
// Phase 6 (Condense) is optional and runs on demand after Phase 4.
const PHASE_ORDER: PhaseId[] = [
  'phase1_ground',
  'phase2_audit',
  'phase3_chronicle',
  'phase5_polish',
  'phase4_extras',
  'phase6_condense',
]

type Props = {
  phase: PhaseId
  currentChunkIndex: number
  totalChunks: number
  countdownMs: number
  partial: string
  /** The run's resolved session — when present, the same phase rail shown
   *  on the idle Chronicle tab renders here, lit. Configuration and
   *  progress are one object. */
  session?: RunSession | null
  railLive?: RailLiveState
  onCancel?: () => void
  /** Optional — when provided, renders a Markdown export button so the
   *  user can grab whatever output the pipeline has produced so far. */
  onExportPartial?: () => void
  /** Optional active-tier badge. Renders as a small pill next to the phase
   *  step counter so the user can see which key the chunk loop is
   *  dispatching to in real time — closes the gap that previously made a
   *  Free→Paid switch invisible until the next quota dialog re-opened. */
  activeProviderLabel?: string
}

export function PhaseProgress({
  phase,
  currentChunkIndex,
  totalChunks,
  countdownMs,
  partial,
  onCancel,
  onExportPartial,
  activeProviderLabel,
  session,
  railLive,
}: Props) {
  const isWaiting = countdownMs > 0
  const seconds = Math.ceil(countdownMs / 1000)
  const phaseStep = PHASE_ORDER.indexOf(phase) + 1

  const { etaMs, percent, elapsedMs } = useEta({
    currentIndex: currentChunkIndex,
    totalChunks,
    phaseKey: phase,
    active: true,
  })

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            {PHASE_LABEL[phase]}
          </CardTitle>
          <div className="flex items-center gap-1">
            {onExportPartial && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onExportPartial}
                title="Download what we have so far as Markdown"
              >
                <Download className="mr-1 h-4 w-4" />
                Export partial
              </Button>
            )}
            {onCancel && (
              <Button
                variant="destructive"
                size="sm"
                onClick={onCancel}
                title="Stop the pipeline immediately. Progress so far is preserved as a checkpoint you can resume."
              >
                <X className="mr-1 h-4 w-4" />
                Halt pipeline
              </Button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>Phase {phaseStep} of {PHASE_ORDER.length}</span>
          {activeProviderLabel && (
            <span
              className="rounded border border-border bg-muted/60 px-2 py-0.5 font-mono text-[10px] text-foreground/80"
              title="The key currently sending this phase's calls. Updates immediately if you switch tiers mid-run."
            >
              {activeProviderLabel}
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {session && <PhaseRail session={session} live={railLive} />}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span>
              Chunk {Math.min(currentChunkIndex + (isWaiting ? 0 : 1), totalChunks)} of{' '}
              {totalChunks}
              {' · '}
              <span className="font-mono">{percent.toFixed(0)}%</span>
            </span>
            {isWaiting ? (
              <span className="font-mono text-amber-600">
                cooling down · {seconds}s until next call
              </span>
            ) : (
              <span className="text-muted-foreground">awaiting model…</span>
            )}
          </div>
          <Progress value={percent} />
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Elapsed: {formatDuration(elapsedMs)}</span>
            <span>
              {etaMs === null
                ? 'ETA: estimating…'
                : `ETA: ~${formatDuration(etaMs)} remaining in this phase`}
            </span>
          </div>
        </div>

        {partial && (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">
              Latest output (tail)
            </p>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/50 p-3 text-xs">
              {partial.slice(-1500)}
            </pre>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
