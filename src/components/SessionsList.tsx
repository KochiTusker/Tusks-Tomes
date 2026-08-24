import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Download, Eraser, FileAudio, Play, RefreshCw, SendToBack, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  deleteSession,
  downloadSbv,
  getTranscribeStatus,
  listSessions,
  sbvDownloadUrl,
  startTranscribe,
  type SessionManifest,
  type TranscribeProgress,
} from '@/lib/sessionsClient'
import { deleteSessionAudio } from '@/lib/multitrackUpload'

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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function processingLabel(
  manifest: SessionManifest,
  progress: TranscribeProgress | null | undefined
): string {
  if (progress?.state === 'running') {
    const pct = progress.utterancesTotal
      ? Math.round((progress.utterancesDone / progress.utterancesTotal) * 100)
      : 0
    return `Transcribing ${pct}% (${progress.utterancesDone}/${progress.utterancesTotal})`
  }
  if (progress?.state === 'error') return 'Failed'
  if (manifest.processing.sbvPath) return 'Processed'
  return 'Recorded'
}

export type SessionsListProps = {
  onSendToRefinement?: (sbv: string, filename: string) => void
}

export function SessionsList({ onSendToRefinement }: SessionsListProps) {
  const [sessions, setSessions] = useState<SessionManifest[] | null>(null)
  const [progress, setProgress] = useState<ProgressMap>({})

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
              const label = processingLabel(manifest, job)
              const processed = !!manifest.processing.sbvPath
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
                        {job?.errors.length ? (
                          <span className="ml-2 text-destructive">
                            {job.errors.length} error
                            {job.errors.length === 1 ? '' : 's'}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
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
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
