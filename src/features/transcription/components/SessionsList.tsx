import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  ChevronDown,
  ChevronUp,
  Download,
  Eraser,
  FileAudio,
  Play,
  RefreshCw,
  SendToBack,
  Trash2,
} from 'lucide-react'
import { Button } from '@/platform/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/platform/ui/card'
import {
  deleteSession,
  downloadSbv,
  getTranscribeStatus,
  listSessions,
  sbvDownloadUrl,
  startTranscribe,
  type SessionManifest,
  type TranscribeProgress,
} from '@/features/transcription/lib/sessionsClient'
import { deleteSessionAudio } from '@/features/transcription/lib/multitrackUpload'
import { LiveTranscript } from './LiveTranscript'
import { formatBytes } from '@shared/lib/format'
import { splitErrorLines } from '@/features/transcription/lib/transcriptionLiveness'

type ProgressMap = Record<string, TranscribeProgress | null>

function fmtDuration(manifest: SessionManifest): string {
  if (!manifest.endedAt) return 'in progress'
  const ms = Date.parse(manifest.endedAt) - Date.parse(manifest.startedAt)
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  const totalSec = Math.round(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

function utteranceCount(manifest: SessionManifest): number {
  return manifest.participants.reduce((acc, p) => acc + p.utterances.length, 0)
}

/** "1h 12m", "4h 03m", "12m", "40s" — audio time as a person reads it. */
export function fmtAudioMs(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m`
  return `${s}s`
}

/**
 * One line that says where a session is. Prefers the audio figures when
 * the server reports them — utterances run from a second to twenty
 * minutes, so "12 of 40 tracks" says little about how long is left, while
 * "1h 12m of 4h 03m audio" says it exactly. Older servers omit those
 * fields and get the utterance percentage they always had.
 */
export function processingLabel(
  manifest: SessionManifest,
  progress: TranscribeProgress | null | undefined
): string {
  const runState = progress?.runState
  if (runState === 'interrupted') return 'Interrupted — the server stopped mid-run'
  if (runState === 'failed' || progress?.state === 'error') return 'Failed'
  if (progress?.state === 'running') {
    if (runState === 'loading_model') return 'Loading the speech model…'
    if (runState === 'finalising') return 'Finalising the transcript…'
    const { processedAudioMs, totalAudioMs, utterancesDone, utterancesTotal } = progress
    if (
      typeof processedAudioMs === 'number' &&
      typeof totalAudioMs === 'number' &&
      totalAudioMs > 0
    ) {
      return (
        `Transcribing · ${fmtAudioMs(processedAudioMs)} of ${fmtAudioMs(totalAudioMs)} audio ` +
        `(${utterancesDone} of ${utterancesTotal} tracks)`
      )
    }
    const pct = utterancesTotal ? Math.round((utterancesDone / utterancesTotal) * 100) : 0
    return `Transcribing ${pct}% (${utterancesDone}/${utterancesTotal})`
  }
  if (manifest.processing.sbvPath) return 'Processed'
  return 'Recorded'
}

/**
 * Whether a row can show its transcript inline. True for a run in
 * progress (the transcript is filling in), a processed session (it is
 * final), and a session with audio on disk that never finished — the
 * partial transcript from before an interruption is still worth reading,
 * and the same view carries the speaker mapping.
 */
function canViewTranscript(
  manifest: SessionManifest,
  progress: TranscribeProgress | null | undefined
): boolean {
  if (progress?.state === 'running') return true
  if (manifest.processing.sbvPath) return true
  return utteranceCount(manifest) > 0 && !manifest.processing.transcribedAt
}

export type SessionsListProps = {
  onSendToRefinement?: (sbv: string, filename: string) => void
}

export function SessionsList({ onSendToRefinement }: SessionsListProps) {
  const [sessions, setSessions] = useState<SessionManifest[] | null>(null)
  const [progress, setProgress] = useState<ProgressMap>({})
  /** The one row whose transcript is open inline. One at a time: each
   *  open LiveTranscript polls the server every 2 s, and one long
   *  transcript already fills the screen. */
  const [openTranscriptId, setOpenTranscriptId] = useState<string | null>(null)

  async function refresh() {
    try {
      const list = await listSessions()
      setSessions(list)
      // Hydrate in-progress jobs. Skip sessions that are already Processed
      // (manifest.processing.transcribedAt is set) — those will always 404
      // because the server's in-memory job map only tracks active runs, and
      // each 404 lands in the browser console as a noisy fetch error.
      const candidates = list.filter((m) => !m.processing.transcribedAt)
      const progressEntries = await Promise.all(
        candidates.map(async (m) => [m.sessionId, await getTranscribeStatus(m.sessionId)] as const)
      )
      const next: ProgressMap = {}
      for (const [id, p] of progressEntries) next[id] = p ?? null
      setProgress(next)
    } catch (err) {
      toast.error(`Failed to load sessions: ${(err as Error).message}`)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  // Poll status for any running jobs.
  useEffect(() => {
    const running = Object.entries(progress).filter(([, p]) => p?.state === 'running')
    if (running.length === 0) return
    const timer = setInterval(async () => {
      const next: ProgressMap = { ...progress }
      let anyChanged = false
      for (const [id] of running) {
        const status = await getTranscribeStatus(id).catch(() => null)
        if (status && status !== next[id]) {
          next[id] = status
          anyChanged = true
          if (status.state === 'done' || status.state === 'error') {
            void refresh() // pick up updated manifest.processing
          }
        }
      }
      if (anyChanged) setProgress(next)
    }, 2000)
    return () => clearInterval(timer)
  }, [progress])

  async function onProcess(id: string) {
    try {
      const job = await startTranscribe(id)
      setProgress((p) => ({ ...p, [id]: job }))
      toast.info('Transcription started.')
    } catch (err) {
      toast.error(`Process failed: ${(err as Error).message}`)
    }
  }

  async function onDelete(id: string) {
    if (!confirm('Delete this session (audio + manifest)? This cannot be undone.')) return
    try {
      await deleteSession(id)
      await refresh()
      toast.success('Session deleted.')
    } catch (err) {
      toast.error(`Delete failed: ${(err as Error).message}`)
    }
  }

  async function onDeleteAudio(id: string) {
    if (
      !confirm(
        'Delete the audio files for this session? The transcript (session.sbv) and per-utterance JSONs stay on disk so you can still send the chronicle to Refinement, but the original audio can\'t be recovered (you\'d have to re-upload the Craig zip).'
      )
    )
      return
    try {
      const { bytesFreed } = await deleteSessionAudio(id)
      await refresh()
      toast.success(`Audio deleted — freed ${formatBytes(bytesFreed)}.`)
    } catch (err) {
      toast.error(`Audio delete failed: ${(err as Error).message}`)
    }
  }

  async function onSendToRefinementClick(manifest: SessionManifest) {
    try {
      const sbv = await downloadSbv(manifest.sessionId)
      onSendToRefinement?.(sbv, `session-${manifest.sessionId.slice(0, 8)}.sbv`)
      toast.success('SBV loaded into Refinement.')
    } catch (err) {
      toast.error(`Hand-off failed: ${(err as Error).message}`)
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle className="flex items-center gap-2">
            <FileAudio className="h-5 w-5" />
            Uploaded sessions
          </CardTitle>
          <CardDescription>
            Multitrack uploads on disk. Click Process to transcribe with
            Whisper and emit a speaker-tagged SBV, then send it into the
            refinement flow.
          </CardDescription>
        </div>
        <Button variant="ghost" size="sm" onClick={refresh}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Refresh
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {sessions === null ? (
          <p className="text-sm text-muted-foreground">Loading sessions…</p>
        ) : sessions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No sessions yet — upload a Craig zip or per-speaker audio files
            above, and the transcribed session will appear here.
          </p>
        ) : (
          <ul className="space-y-2">
            {sessions.map((manifest) => {
              const job = progress[manifest.sessionId]
              const jobErrors = splitErrorLines(job?.errors).errors
              const label = processingLabel(manifest, job)
              const processed = !!manifest.processing.sbvPath
              const viewable = canViewTranscript(manifest, job)
              const transcriptOpen = openTranscriptId === manifest.sessionId
              return (
                <li
                  key={manifest.sessionId}
                  className="space-y-2 rounded-md border border-border p-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="text-sm">
                      <div className="font-medium">
                        {manifest.voiceChannelName || 'voice channel'}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {new Date(manifest.startedAt).toLocaleString()} ·{' '}
                        {manifest.participants.length} participant
                        {manifest.participants.length === 1 ? '' : 's'} ·{' '}
                        {utteranceCount(manifest)} utterance
                        {utteranceCount(manifest) === 1 ? '' : 's'} · {fmtDuration(manifest)}
                      </div>
                      <div className="mt-1 text-xs">
                        <span className="rounded bg-muted px-2 py-0.5">{label}</span>
                        {jobErrors.length ? (
                          <span className="ml-2 text-destructive">
                            {jobErrors.length} error
                            {jobErrors.length === 1 ? '' : 's'}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {viewable && (
                        <Button
                          variant="outline"
                          size="sm"
                          aria-expanded={transcriptOpen}
                          onClick={() =>
                            setOpenTranscriptId(transcriptOpen ? null : manifest.sessionId)
                          }
                        >
                          {transcriptOpen ? (
                            <ChevronUp className="mr-2 h-4 w-4" />
                          ) : (
                            <ChevronDown className="mr-2 h-4 w-4" />
                          )}
                          {transcriptOpen ? 'Hide transcript' : 'View transcript'}
                        </Button>
                      )}
                      {!processed && (
                        <Button
                          size="sm"
                          onClick={() => onProcess(manifest.sessionId)}
                          disabled={job?.state === 'running'}
                        >
                          <Play className="mr-2 h-4 w-4" />
                          {job?.state === 'running' ? 'Running…' : 'Process'}
                        </Button>
                      )}
                      {processed && (
                        <a
                          href={sbvDownloadUrl(manifest.sessionId)}
                          download={`session-${manifest.sessionId.slice(0, 8)}.sbv`}
                        >
                          <Button variant="outline" size="sm">
                            <Download className="mr-2 h-4 w-4" />
                            Download SBV
                          </Button>
                        </a>
                      )}
                      {processed && onSendToRefinement && (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => onSendToRefinementClick(manifest)}
                        >
                          <SendToBack className="mr-2 h-4 w-4" />
                          Send to Refinement
                        </Button>
                      )}
                      {processed && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => onDeleteAudio(manifest.sessionId)}
                          aria-label="Delete audio (keep transcript)"
                          title="Delete audio (keep transcript)"
                        >
                          <Eraser className="h-4 w-4" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => onDelete(manifest.sessionId)}
                        aria-label="Delete session"
                        title="Delete entire session"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                  {/* The same view the Upload panel shows while Whisper
                      runs, reached from the list so a session outlives
                      the panel that created it: a reload, a restart, or
                      simply a job started from this row. */}
                  {transcriptOpen && (
                    <div className="border-t border-border pt-3">
                      <LiveTranscript
                        sessionId={manifest.sessionId}
                        onSendToRefinement={(sbv) =>
                          onSendToRefinement?.(sbv, `session-${manifest.sessionId.slice(0, 8)}.sbv`)
                        }
                      />
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
