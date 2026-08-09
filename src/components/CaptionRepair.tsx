import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  AlertTriangle,
  Copy,
  Download,
  FileWarning,
  Loader2,
  Play,
  RotateCcw,
  Upload,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { useLocalStorage } from '@/hooks/useLocalStorage'
import { useLoreDocuments } from '@/hooks/useLoreDocuments'
import { formatDuration, useEta } from '@/hooks/useEta'
import { showCleanupToast, showPreGroundToast } from '@/lib/pipelineToasts'
import { LS_SBV_REPAIR } from '@/lib/constants'
import { hasApiKey } from '@/lib/gemini'
import {
  formatSbv,
  isSbv as detectSbv,
  parseSbv,
  parseSbvWithStats,
  type SbvCue,
} from '@/lib/sbv'
import { groundSbvCues, packCueChunks, type SbvGroundEvent } from '@/lib/sbvGround'
import {
  initialSbvRepairState,
  type SbvRepairState,
} from '@/types'

function fmtDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

function downloadFile(filename: string, contents: string, mime: string) {
  const blob = new Blob([contents], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function diffCues(
  original: SbvCue[],
  corrected: SbvCue[]
): Array<{ index: number; cue: SbvCue; before: string; after: string }> {
  const out: Array<{ index: number; cue: SbvCue; before: string; after: string }> = []
  const n = Math.min(original.length, corrected.length)
  for (let i = 0; i < n; i++) {
    const before = original[i].text.replace(/\s*\n\s*/g, ' ').trim()
    const after = corrected[i].text.replace(/\s*\n\s*/g, ' ').trim()
    if (before !== after) {
      out.push({ index: i, cue: corrected[i], before, after })
    }
  }
  return out
}

export function CaptionRepair() {
  const [state, setState] = useLocalStorage<SbvRepairState>(
    LS_SBV_REPAIR,
    initialSbvRepairState
  )
  const { documents: kb } = useLoreDocuments()
  const [running, setRunning] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const apiKeyMissing = !hasApiKey()

  useEffect(() => () => abortRef.current?.abort(), [])

  const patch = useCallback(
    (p: Partial<SbvRepairState>) =>
      setState((prev) => ({ ...prev, ...p, updatedAt: new Date().toISOString() })),
    [setState]
  )

  const reset = useCallback(() => {
    abortRef.current?.abort()
    setState({ ...initialSbvRepairState, updatedAt: new Date().toISOString() })
  }, [setState])

  const cancel = useCallback(() => abortRef.current?.abort(), [])

  // ----- File handling -----

  const onFile = useCallback(
    async (file: File) => {
      try {
        const raw = await file.text()
        if (!detectSbv(raw)) {
          toast.error('That file does not look like an SBV (no timestamp lines found).')
          return
        }
        const { cues, malformedLineCount } = parseSbvWithStats(raw)
        if (!cues.length) {
          toast.error('Parsed 0 cues from that file.')
          return
        }
        if (malformedLineCount > 0) {
          // Surface partial-parse health so a user with a half-broken SBV
          // doesn't silently process a fraction of their content. Common
          // cause: SBV exported with extra blank lines or non-standard
          // timestamp formats (e.g., milliseconds dropped by a converter).
          toast.warning(
            `Loaded ${cues.length} cues, but skipped ${malformedLineCount} ` +
              `malformed timestamp line${malformedLineCount === 1 ? '' : 's'}. ` +
              'The file may be partially corrupted — verify the chunks below cover the full session.',
            { duration: 12_000 },
          )
        }
        patch({
          fileName: file.name,
          originalCues: cues,
          cues,
          status: 'idle',
          currentChunkIndex: 0,
          totalChunks: packCueChunks(cues).length,
          countdownMs: 0,
          totalChanged: 0,
          lastError: undefined,
        })
        toast.success(`Loaded ${cues.length} cues from "${file.name}".`)
      } catch (err) {
        toast.error(`Failed to read file: ${(err as Error).message}`)
      }
    },
    [patch]
  )

  // ----- Pipeline -----

  const handleEvent = useCallback(
    (e: SbvGroundEvent) => {
      switch (e.type) {
        case 'start':
          patch({
            status: 'running',
            currentChunkIndex: 0,
            totalChunks: e.totalChunks,
            countdownMs: 0,
          })
          break
        case 'chunk_done':
          patch({
            cues: e.cuesUpdated,
            currentChunkIndex: e.chunkIndex + 1,
            totalChunks: e.totalChunks,
            totalChanged: e.totalChangedSoFar,
            countdownMs: 0,
          })
          break
        case 'countdown':
          patch({ countdownMs: e.msRemaining })
          break
        case 'cleanup':
          showCleanupToast(e.report)
          break
        case 'pre_ground':
          showPreGroundToast(e.report)
          break
        case 'complete':
          patch({
            cues: e.cues,
            status: 'done',
            totalChanged: e.totalChanged,
            countdownMs: 0,
          })
          break
      }
    },
    [patch]
  )

  const run = useCallback(async () => {
    if (apiKeyMissing) {
      toast.error('No Gemini API key set. Add VITE_GEMINI_API_KEY to .env and restart.')
      return
    }
    if (!state.originalCues.length) {
      toast.error('Upload an SBV file first.')
      return
    }
    setRunning(true)
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      await groundSbvCues({
        cues: state.originalCues,
        kb,
        callbacks: { onEvent: handleEvent, signal: ctrl.signal },
      })
      toast.success('Caption repair complete.')
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        toast.info('Repair cancelled.')
        patch({ status: 'idle', countdownMs: 0 })
      } else {
        console.error(err)
        const msg = (err as Error).message
        patch({ status: 'error', lastError: msg })
        toast.error(`Repair failed: ${msg.slice(0, 200)}`)
      }
    } finally {
      setRunning(false)
      abortRef.current = null
    }
  }, [apiKeyMissing, state.originalCues, kb, handleEvent, patch])

  // ----- Derived -----

  const totalDurationMs = useMemo(
    () => (state.originalCues.length ? state.originalCues[state.originalCues.length - 1].endMs : 0),
    [state.originalCues]
  )

  const changedCues = useMemo(
    () => diffCues(state.originalCues, state.cues),
    [state.originalCues, state.cues]
  )

  const downloadCorrected = () => {
    const out = formatSbv(state.cues)
    const base = state.fileName.replace(/\.sbv$/i, '') || 'captions'
    downloadFile(`${base}-corrected.sbv`, out, 'text/plain')
  }

  const isWaiting = state.countdownMs > 0
  const seconds = Math.ceil(state.countdownMs / 1000)
  const { etaMs, percent: pct, elapsedMs } = useEta({
    currentIndex: state.currentChunkIndex,
    totalChunks: state.totalChunks,
    phaseKey: 'sbv_repair',
    active: state.status === 'running',
  })

  // ----- Render -----

  if (apiKeyMissing) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-5 w-5" />
            Gemini API key missing
          </CardTitle>
          <CardDescription>
            Add <code>PAID_GEMINI_API_KEY</code> to <code>.env</code> (preferred —
            required for Gemini 3.x) and restart.
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Caption Repair</CardTitle>
          <CardDescription>
            Upload a YouTube <code>.sbv</code> auto-caption file. Each cue is corrected
            against your Knowledge Base — names fixed, censored expletives restored,
            mature content preserved verbatim. Timestamps stay byte-for-byte identical
            so you can re-upload to YouTube directly. Knowledge Base: {kb.length} doc
            {kb.length === 1 ? '' : 's'}.
            <br />
            <span className="text-xs">
              For mistranscriptions you've noticed yourself, edit{' '}
              <code>src/data/corrections.ts</code> — they'll be applied
              deterministically before any AI call.
            </span>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* File picker */}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              onClick={() => inputRef.current?.click()}
              disabled={running}
            >
              <Upload className="mr-2 h-4 w-4" />
              {state.fileName ? 'Replace file' : 'Choose .sbv file'}
            </Button>
            <input
              ref={inputRef}
              type="file"
              accept=".sbv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) onFile(f)
                e.target.value = ''
              }}
            />
            {state.fileName && (
              <span className="text-sm text-muted-foreground truncate">
                <strong className="text-foreground">{state.fileName}</strong>
                {' · '}
                {state.originalCues.length.toLocaleString()} cues
                {' · '}
                {fmtDuration(totalDurationMs)}
                {' · '}
                {state.totalChunks} chunk{state.totalChunks === 1 ? '' : 's'}
              </span>
            )}
          </div>

          {state.originalCues.length > 0 && kb.length === 0 && (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              <FileWarning className="mt-0.5 h-4 w-4 text-amber-500" />
              <div>
                Knowledge Base is empty. The model can still restore profanity and fix
                obvious phonetic errors, but it can't ground D&D names without lore docs.
                Add some in the <strong>Tome of Lore</strong> tab for best accuracy.
              </div>
            </div>
          )}

          {/* Action buttons */}
          {state.originalCues.length > 0 && state.status !== 'running' && (
            <div className="flex flex-wrap gap-2">
              {state.status !== 'done' && (
                <Button
                  data-slot="primary-cta"
                  onClick={run}
                  size="lg"
                  className="font-display tracking-wider uppercase"
                >
                  <Play className="mr-2 h-4 w-4" />
                  Repair captions
                </Button>
              )}
              {state.status === 'done' && (
                <Button
                  data-slot="primary-cta"
                  onClick={downloadCorrected}
                  size="lg"
                  className="font-display tracking-wider uppercase"
                >
                  <Download className="mr-2 h-4 w-4" />
                  Download corrected .sbv
                </Button>
              )}
              <Button variant="outline" onClick={reset}>
                <RotateCcw className="mr-1 h-4 w-4" />
                Reset
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Progress card */}
      {state.status === 'running' && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
                Repairing captions
              </CardTitle>
              {running && (
                <Button variant="ghost" size="sm" onClick={cancel}>
                  <X className="mr-1 h-4 w-4" />
                  Cancel
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span>
                  Chunk {Math.min(state.currentChunkIndex + (isWaiting ? 0 : 1), state.totalChunks)} of {state.totalChunks}
                  {' · '}
                  <span className="font-mono">{pct.toFixed(0)}%</span>
                  {state.totalChanged > 0 &&
                    ` · ${state.totalChanged} cue${state.totalChanged === 1 ? '' : 's'} corrected so far`}
                </span>
                {isWaiting ? (
                  <span className="font-mono text-amber-500">
                    cooling down · {seconds}s until next call
                  </span>
                ) : (
                  <span className="text-muted-foreground">awaiting model…</span>
                )}
              </div>
              <Progress value={pct} />
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Elapsed: {formatDuration(elapsedMs)}</span>
                <span>
                  {etaMs === null
                    ? 'ETA: estimating…'
                    : `ETA: ~${formatDuration(etaMs)} remaining`}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Error card */}
      {state.status === 'error' && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              Repair error
            </CardTitle>
            <CardDescription>
              The pipeline stopped. Diagnostic below — safe to paste into Claude Code.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="relative">
              <Button
                variant="outline"
                size="sm"
                className="absolute right-2 top-2 z-10"
                onClick={async () => {
                  await navigator.clipboard.writeText(state.lastError ?? '')
                  toast.success('Error copied to clipboard')
                }}
              >
                <Copy className="mr-1 h-4 w-4" />
                Copy
              </Button>
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/50 p-4 pr-24 font-mono text-xs leading-relaxed">
                {state.lastError ?? 'Unknown error.'}
              </pre>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={run}>
                <Play className="mr-1 h-4 w-4" />
                Retry
              </Button>
              <Button variant="outline" onClick={reset}>
                <RotateCcw className="mr-1 h-4 w-4" />
                Reset
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Diff card — visible during run (live updates) and after completion */}
      {state.originalCues.length > 0 &&
        (state.status === 'done' || state.status === 'running') && (
          <Card>
            <CardHeader>
              <CardTitle>
                {changedCues.length} of {state.originalCues.length} cues corrected
              </CardTitle>
              <CardDescription>
                {state.status === 'done'
                  ? 'Review the changes below, then download the corrected .sbv.'
                  : 'Live preview — updates after each chunk completes.'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {changedCues.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No changes yet.
                </p>
              ) : (
                <ul className="space-y-3 max-h-[28rem] overflow-y-auto pr-2">
                  {changedCues.map((c) => (
                    <li
                      key={c.index}
                      className="rounded-md border border-border/70 bg-card/50 p-3 text-sm"
                    >
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <span className="font-mono text-xs text-muted-foreground">
                          [{c.index + 1}] {c.cue.startStr} → {c.cue.endStr}
                        </span>
                      </div>
                      <div className="space-y-1">
                        <div className="text-destructive/90 line-through decoration-destructive/40">
                          {c.before}
                        </div>
                        <div className="text-[oklch(0.85_0.13_140)]">
                          {c.after}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        )}
    </div>
  )
}
