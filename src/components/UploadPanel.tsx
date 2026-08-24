// Multitrack audio upload panel. Two ways to feed it audio:
//
//   - All-at-once: drag every Craig zip in, hit "Upload & transcribe",
//     done. Best when your whole session fits in one upload round-trip.
//
//   - Staged batches: upload Part 1, click "Save batch", repeat with
//     Part 2 / 3 / …, then click "All audio uploaded — start
//     transcription". Best when:
//       * the full session is too big to upload in one shot,
//       * you recorded the session across multiple separate Craig
//         records (bot dropped, you re-invited it, etc.) and want
//         them stitched into one chronological SBV,
//       * you want a confirmation checkpoint between large uploads
//         before committing to a multi-hour Whisper run.
//
// Either way the on-disk output is identical: one session directory,
// one continuous timeline, one merged session.sbv with all speakers
// interleaved chronologically. Reuses LiveTranscript for the
// during/after-transcription view.

import { useCallback, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  FileAudio,
  Layers,
  Loader2,
  PackageOpen,
  Play,
  PlusCircle,
  Trash2,
  Upload,
  UploadCloud,
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import {
  appendMultitrack,
  cancelMultitrackUpload,
  previewSpeakerFromFilename,
  startMultitrackTranscription,
  uploadMultitrack,
  type ExtractResult,
} from '@/lib/multitrackUpload'
import { LiveTranscript } from './LiveTranscript'
import { LOAD_TRANSCRIPT_EVENT } from '@/App'
import { useAddons } from '@/contexts/AddonContext'

/**
 * UI phases:
 *
 *   idle              No files staged, no session yet.
 *   preview           Files staged in the table, ready to upload.
 *                     Same view used for first-batch AND any later batch.
 *   uploading         XHR in flight.
 *   committed         Batch finished; session exists on disk. Showing
 *                     "Add another batch" + "All audio uploaded" buttons.
 *   transcribing      Whisper is grinding. LiveTranscript takes over.
 *   ready             Manifest sbvPath is set. LiveTranscript shows
 *                     the "Use this transcript" button.
 */
type Phase = 'idle' | 'preview' | 'uploading' | 'committed' | 'transcribing' | 'ready'

type FileEntry = {
  /** Stable id so React can track rows through reordering. */
  id: string
  file: File
  /** Default display name parsed from the filename. Only meaningful for
   * loose audio files; for zips this is unused. */
  parsedName: string
  /** Editable override the user types into the preview table. Only for
   * loose audio files. */
  overrideName: string
}

/** A batch that has already been committed to disk. */
type CommittedBatch = {
  /** 1-based human label: "Part 1", "Part 2", …. */
  partNumber: number
  /** Display label: filenames joined, or "Loose files (N)". */
  summary: string
  /** Number of zips + loose files in the batch. */
  fileCount: number
  /** Number of distinct speakers extracted from this batch. */
  speakerCount: number
  /** Cumulative session duration AFTER this batch was applied. */
  cumulativeDurationMs: number
  /** Total bytes uploaded for this batch. */
  bytes: number
}

const AUDIO_EXT_RE = /\.(wav|flac|ogg|opus|mp3|m4a|aac)$/i

function isZip(file: File): boolean {
  return file.name.toLowerCase().endsWith('.zip')
}

export function UploadPanel() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [sessionLabel, setSessionLabel] = useState('')
  const [uploadFraction, setUploadFraction] = useState(0)
  const [bytesSent, setBytesSent] = useState(0)
  const [bytesTotal, setBytesTotal] = useState(0)
  const { isEnabled } = useAddons()
  /** The session we're building (null until the first batch commits). */
  const [sessionId, setSessionId] = useState<string | null>(null)
  /** Snapshot of the last batch's extraction result, used while staying
   * on the same page across batches. Cleared on full reset. */
  const [latestExtract, setLatestExtract] = useState<ExtractResult | null>(null)
  /** Every batch the user has committed so far. */
  const [committedBatches, setCommittedBatches] = useState<CommittedBatch[]>([])
  const [errorText, setErrorText] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const dropZoneActiveRef = useRef(false)
  const [dragOver, setDragOver] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const totalBytes = useMemo(
    () => entries.reduce((acc, e) => acc + e.file.size, 0),
    [entries]
  )
  const looseEntries = useMemo(() => entries.filter((e) => !isZip(e.file)), [entries])
  const cumulativeDurationMs = useMemo(
    () =>
      committedBatches.length > 0
        ? committedBatches[committedBatches.length - 1].cumulativeDurationMs
        : 0,
    [committedBatches]
  )
  const isAppendingMode = sessionId !== null && phase !== 'transcribing' && phase !== 'ready'

  const acceptFiles = useCallback((rawFiles: FileList | File[]) => {
    const incoming = Array.from(rawFiles)
    const accepted: FileEntry[] = []
    const rejected: string[] = []
    for (const file of incoming) {
      if (file.name.toLowerCase().endsWith('.zip')) {
        accepted.push({
          id: `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 8)}`,
          file,
          parsedName: '(zip — speakers parsed on upload)',
          overrideName: '',
        })
        continue
      }
      if (!AUDIO_EXT_RE.test(file.name)) {
        rejected.push(file.name)
        continue
      }
      const { displayName } = previewSpeakerFromFilename(file.name)
      accepted.push({
        id: `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 8)}`,
        file,
        parsedName: displayName,
        overrideName: '',
      })
    }
    if (rejected.length > 0) {
      toast.warning(
        `Skipped ${rejected.length} file${rejected.length === 1 ? '' : 's'} with unsupported extension: ${rejected.slice(0, 3).join(', ')}${rejected.length > 3 ? '…' : ''}`
      )
    }
    if (accepted.length === 0) return
    setEntries((prev) => [...prev, ...accepted])
    setPhase('preview')
    setErrorText(null)
  }, [])

  function onPickFiles(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files) acceptFiles(e.target.files)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDragOver(false)
    dropZoneActiveRef.current = false
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      acceptFiles(e.dataTransfer.files)
    }
  }

  function onDragOver(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    if (!dropZoneActiveRef.current) {
      dropZoneActiveRef.current = true
      setDragOver(true)
    }
  }
  function onDragLeave(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    dropZoneActiveRef.current = false
    setDragOver(false)
  }

  function removeEntry(id: string) {
    setEntries((prev) => {
      const next = prev.filter((e) => e.id !== id)
      // Only flip back to idle if there's no in-flight session AND no
      // committed batches — otherwise stay in preview/committed.
      if (next.length === 0 && committedBatches.length === 0) setPhase('idle')
      else if (next.length === 0 && committedBatches.length > 0) setPhase('committed')
      return next
    })
  }

  function moveEntry(id: string, direction: -1 | 1) {
    setEntries((prev) => {
      const idx = prev.findIndex((e) => e.id === id)
      if (idx === -1) return prev
      const target = idx + direction
      if (target < 0 || target >= prev.length) return prev
      const next = [...prev]
      const [moved] = next.splice(idx, 1)
      next.splice(target, 0, moved)
      return next
    })
  }

  function clearStagedFiles() {
    setEntries([])
    setErrorText(null)
    setUploadFraction(0)
    setBytesSent(0)
    setBytesTotal(0)
    setPhase(committedBatches.length > 0 ? 'committed' : 'idle')
  }

  function resetEverything() {
    setEntries([])
    setSessionId(null)
    setLatestExtract(null)
    setCommittedBatches([])
    setSessionLabel('')
    setErrorText(null)
    setUploadFraction(0)
    setBytesSent(0)
    setBytesTotal(0)
    setPhase('idle')
  }

  async function commitBatch() {
    if (entries.length === 0) return
    abortRef.current = new AbortController()
    setPhase('uploading')
    setUploadFraction(0)
    setBytesSent(0)
    setBytesTotal(totalBytes)
    setErrorText(null)

    const overrides: Record<string, string> = {}
    for (const entry of entries) {
      if (!isZip(entry.file) && entry.overrideName.trim()) {
        overrides[entry.file.name] = entry.overrideName.trim()
      }
    }
    const fileOrder = entries.map((e) => e.file.name)
    const files = entries.map((e) => e.file)
    const batchBytes = totalBytes
    const isFirstBatch = sessionId === null

    try {
      const result = isFirstBatch
        ? await uploadMultitrack({
            files,
            voiceChannelName: sessionLabel.trim() || undefined,
            displayNameOverrides: overrides,
            fileOrder,
            onProgress: (p) => {
              setUploadFraction(p.fraction)
              setBytesSent(p.loaded)
              setBytesTotal(p.total)
            },
            signal: abortRef.current.signal,
          })
        : await appendMultitrack({
            sessionId: sessionId!,
            files,
            displayNameOverrides: overrides,
            fileOrder,
            onProgress: (p) => {
              setUploadFraction(p.fraction)
              setBytesSent(p.loaded)
              setBytesTotal(p.total)
            },
            signal: abortRef.current.signal,
          })

      setSessionId(result.sessionId)
      setLatestExtract(result)
      const partNumber = committedBatches.length + 1
      const fileCount = files.length
      const speakerCount = new Set(result.tracks.map((t) => t.speakerId)).size
      const summary = summariseBatch(files)
      setCommittedBatches((prev) => [
        ...prev,
        {
          partNumber,
          summary,
          fileCount,
          speakerCount,
          cumulativeDurationMs: result.totalDurationMs,
          bytes: batchBytes,
        },
      ])
      setEntries([])
      setPhase('committed')
      toast.success(
        `Part ${partNumber} saved — ${fileCount} file${fileCount === 1 ? '' : 's'}, ${speakerCount} speaker${speakerCount === 1 ? '' : 's'}. Session is now ${formatDuration(result.totalDurationMs)} long.`
      )
    } catch (err) {
      const message = (err as Error).message
      if (message === 'Aborted') {
        toast.info('Upload cancelled.')
        setPhase(entries.length > 0 ? 'preview' : committedBatches.length > 0 ? 'committed' : 'idle')
      } else {
        setErrorText(message)
        toast.error(`Upload failed: ${message}`)
        setPhase('preview')
      }
    } finally {
      abortRef.current = null
    }
  }

  async function startTranscription() {
    if (!sessionId) return
    setPhase('transcribing')
    try {
      await startMultitrackTranscription(sessionId)
      const partCount = committedBatches.length
      toast.success(
        `Starting transcription on ${formatDuration(cumulativeDurationMs)} of audio across ${partCount} part${partCount === 1 ? '' : 's'}. Whisper running…`
      )
    } catch (err) {
      setErrorText((err as Error).message)
      toast.error(`Couldn't start transcription: ${(err as Error).message}`)
      setPhase('committed')
    }
  }

  async function cancelInFlight() {
    abortRef.current?.abort()
  }

  async function discardSession() {
    if (!sessionId) return
    if (!window.confirm(`Discard the current session and all ${committedBatches.length} committed batch${committedBatches.length === 1 ? '' : 'es'}? This deletes the uploaded audio from disk.`)) {
      return
    }
    await cancelMultitrackUpload(sessionId).catch(() => undefined)
    toast.info('Session discarded.')
    resetEverything()
  }

  function onSendToRefinement(sbv: string) {
    window.dispatchEvent(
      new CustomEvent(LOAD_TRANSCRIPT_EVENT, { detail: { text: sbv } })
    )
    toast.success('Transcript sent to Refinement.')
  }

  // ---- After transcription kicks off, LiveTranscript drives the view ----
  if ((phase === 'transcribing' || phase === 'ready') && latestExtract) {
    return (
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CheckCircle2 className="h-4 w-4 text-green-500" />
              Upload complete — Whisper is transcribing
            </CardTitle>
            <CardDescription>
              {committedBatches.length} part{committedBatches.length === 1 ? '' : 's'} stitched into one session
              ({formatDuration(cumulativeDurationMs)} total). All speakers
              merge into one chronological SBV — edit player / character
              names below and click <em>Re-render labels</em> to update
              the transcript before sending to Refinement.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="ghost" size="sm" onClick={resetEverything}>
              Upload another session
            </Button>
          </CardContent>
        </Card>
        <LiveTranscript
          sessionId={latestExtract.sessionId}
          onSendToRefinement={onSendToRefinement}
        />
      </div>
    )
  }

  // ---- Before transcription: dropzone + staging table + commit controls ----
  const hasZips = entries.some((e) => isZip(e.file))
  const hasStagedFiles = entries.length > 0
  const isUploading = phase === 'uploading'
  const isCommitted = phase === 'committed'

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Upload className="h-5 w-5" />
            Multitrack audio upload
          </CardTitle>
          <CardDescription>
            Upload <strong>one or more Craig zips</strong> (each becomes
            one chunk), or <strong>one audio file per speaker</strong>,
            or both. Chunks are stitched end-to-end into one session;
            same speaker across chunks (matched by Craig speaker ID, or
            by filename for loose files) is merged into one participant.
            The resulting <code>.sbv</code> interleaves every speaker
            chronologically. Whisper runs locally — nothing leaves your
            machine.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div
            onDrop={onDrop}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            className={`flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed p-8 text-center transition-colors ${
              dragOver
                ? 'border-primary bg-primary/5'
                : 'border-border hover:border-primary/50'
            } ${isUploading ? 'pointer-events-none opacity-60' : ''}`}
          >
            <UploadCloud className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm">
              {isAppendingMode ? (
                <>
                  Drop <strong>Part {committedBatches.length + 1}</strong> here, or{' '}
                  <button
                    type="button"
                    className="font-medium text-primary underline underline-offset-2"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    browse
                  </button>
                  .
                </>
              ) : (
                <>
                  Drag &amp; drop files here, or{' '}
                  <button
                    type="button"
                    className="font-medium text-primary underline underline-offset-2"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    browse
                  </button>
                  .
                </>
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              One or more <code>.zip</code> files (one chunk each), and/or
              loose audio files. Per-file limit: 4 GB. You can upload everything in one batch, or stage parts and commit between batches.
            </p>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".zip,.wav,.flac,.ogg,.opus,.mp3,.m4a,.aac,audio/*,application/zip"
              className="hidden"
              onChange={onPickFiles}
            />
          </div>

          {!isAppendingMode && (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="upload-session-label">
                  Session label (optional)
                </Label>
                <Input
                  id="upload-session-label"
                  placeholder="e.g. Session 42 — Drow ambush"
                  value={sessionLabel}
                  onChange={(e) => setSessionLabel(e.target.value)}
                  disabled={isUploading}
                />
                <p className="text-xs text-muted-foreground">
                  Stored as the session's display name in the Sessions tab. Locked once Part 1 is committed.
                </p>
              </div>
            </div>
          )}

          {/* Committed batches summary — only visible mid-session */}
          {committedBatches.length > 0 && (
            <div className="space-y-2 rounded-md border border-green-500/40 bg-green-500/5 p-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Layers className="h-4 w-4 text-green-600" />
                Saved so far — {committedBatches.length} part{committedBatches.length === 1 ? '' : 's'} · {formatDuration(cumulativeDurationMs)} total
              </div>
              <ul className="space-y-1 text-xs text-muted-foreground">
                {committedBatches.map((b) => (
                  <li key={b.partNumber} className="flex items-center gap-2">
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-600" />
                    <span className="font-medium">Part {b.partNumber}</span>
                    <span>·</span>
                    <span className="truncate">{b.summary}</span>
                    <span>·</span>
                    <span className="whitespace-nowrap">
                      {b.speakerCount} speaker{b.speakerCount === 1 ? '' : 's'}
                    </span>
                    <span>·</span>
                    <span className="whitespace-nowrap">{formatBytes(b.bytes)}</span>
                  </li>
                ))}
              </ul>
              {sessionLabel && (
                <p className="text-xs text-muted-foreground">
                  Session label: <strong>{sessionLabel}</strong>
                </p>
              )}
            </div>
          )}

          {/* Staged files table — shown for the current batch being uploaded */}
          {hasStagedFiles && (
            <div className="space-y-2 rounded-md border border-border p-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium">
                  {isAppendingMode
                    ? `Part ${committedBatches.length + 1} — staged files (${entries.length})`
                    : `Files (${entries.length})`}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearStagedFiles}
                  disabled={isUploading}
                >
                  <Trash2 className="mr-1 h-3.5 w-3.5" />
                  Clear staged
                </Button>
              </div>
              {hasZips ? (
                <p className="text-xs text-muted-foreground">
                  Use the arrows to reorder chunks. Each zip is stitched
                  end-to-end in the order you set here.
                  {looseEntries.length > 0
                    ? ' Loose audio files form one extra chunk at their position in this list.'
                    : ''}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Edit the Display name column to override what was parsed
                  from the filename. You can also remap player / character
                  names after transcription using the speakers card.
                </p>
              )}
              <div className="max-h-80 overflow-auto rounded border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
                    <tr>
                      <th className="px-2 py-1 text-left">#</th>
                      <th className="px-2 py-1 text-left">File</th>
                      <th className="px-2 py-1 text-left">Detected name</th>
                      <th className="px-2 py-1 text-left">Display name</th>
                      <th className="px-2 py-1 text-left">Size</th>
                      <th className="px-2 py-1"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((entry, idx) => {
                      const zip = isZip(entry.file)
                      return (
                        <tr key={entry.id} className="border-t border-border">
                          <td className="px-2 py-1.5 text-xs text-muted-foreground tabular-nums">
                            {idx + 1}
                          </td>
                          <td className="px-2 py-1.5">
                            <div className="flex items-center gap-1.5">
                              {zip ? (
                                <PackageOpen className="h-3.5 w-3.5 text-amber-500" />
                              ) : (
                                <FileAudio className="h-3.5 w-3.5 text-muted-foreground" />
                              )}
                              <code className="text-xs break-all">{entry.file.name}</code>
                            </div>
                          </td>
                          <td className="px-2 py-1.5 text-xs text-muted-foreground">
                            {entry.parsedName}
                          </td>
                          <td className="px-2 py-1.5">
                            {zip ? (
                              <span className="text-xs text-muted-foreground italic">
                                from zip contents
                              </span>
                            ) : (
                              <Input
                                value={entry.overrideName}
                                placeholder={entry.parsedName}
                                onChange={(e) =>
                                  setEntries((prev) =>
                                    prev.map((p) =>
                                      p.id === entry.id
                                        ? { ...p, overrideName: e.target.value }
                                        : p
                                    )
                                  )
                                }
                                disabled={isUploading}
                                className="h-7 text-xs"
                              />
                            )}
                          </td>
                          <td className="px-2 py-1.5 text-xs text-muted-foreground whitespace-nowrap">
                            {formatBytes(entry.file.size)}
                          </td>
                          <td className="px-2 py-1.5 text-right whitespace-nowrap">
                            <button
                              type="button"
                              onClick={() => moveEntry(entry.id, -1)}
                              disabled={isUploading || idx === 0}
                              className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                              aria-label="Move up"
                            >
                              <ArrowUp className="inline h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => moveEntry(entry.id, 1)}
                              disabled={isUploading || idx === entries.length - 1}
                              className="ml-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
                              aria-label="Move down"
                            >
                              <ArrowDown className="inline h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => removeEntry(entry.id)}
                              disabled={isUploading}
                              className="ml-2 text-muted-foreground hover:text-destructive disabled:opacity-50"
                              aria-label={`Remove ${entry.file.name}`}
                            >
                              <X className="inline h-3.5 w-3.5" />
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <div className="text-xs text-muted-foreground">
                Total staged: {formatBytes(totalBytes)}
                {hasZips && (
                  <>
                    {' '}· {entries.filter((e) => isZip(e.file)).length} chunk
                    {entries.filter((e) => isZip(e.file)).length === 1 ? '' : 's'}
                    {looseEntries.length > 0
                      ? ` + ${looseEntries.length} loose file${looseEntries.length === 1 ? '' : 's'}`
                      : ''}
                  </>
                )}
              </div>
            </div>
          )}

          {isUploading && (
            <div className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
              <div className="flex items-center gap-2 text-sm">
                <Loader2 className="h-4 w-4 animate-spin text-amber-500" />
                Uploading Part {committedBatches.length + 1}… ({formatBytes(bytesSent)} / {formatBytes(bytesTotal)})
              </div>
              <Progress value={uploadFraction * 100} />
              <Button
                variant="ghost"
                size="sm"
                onClick={cancelInFlight}
                className="text-xs"
              >
                Cancel upload
              </Button>
            </div>
          )}

          {errorText && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
              {errorText}
            </div>
          )}

          {/* Action bar. Different buttons in different phases. */}
          <div className="flex flex-wrap gap-2">
            {/* Save-batch button — visible whenever staged files exist */}
            {hasStagedFiles && !isUploading && (
              <Button onClick={commitBatch} disabled={entries.length === 0}>
                <Upload className="mr-2 h-4 w-4" />
                {isAppendingMode
                  ? `Save Part ${committedBatches.length + 1}`
                  : committedBatches.length === 0
                    ? 'Save Part 1'
                    : 'Save batch'}
              </Button>
            )}

            {/* Add-another-batch button — shown after at least one batch
                is committed and no files are staged. Just opens the
                file picker; the dropzone is already visible above. */}
            {isCommitted && !hasStagedFiles && (
              <Button variant="secondary" onClick={() => fileInputRef.current?.click()}>
                <PlusCircle className="mr-2 h-4 w-4" />
                Add another batch
              </Button>
            )}

            {/* Finalize button — auto-starts transcription. Only enabled
                once at least one batch is committed AND the user isn't
                staging more files. */}
            {sessionId && !hasStagedFiles && !isUploading && (
              isEnabled('audio-addon') ? (
                <Button variant="default" onClick={startTranscription} className="bg-green-600 hover:bg-green-700">
                  <Play className="mr-2 h-4 w-4" />
                  All audio uploaded — start transcription
                </Button>
              ) : (
                <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                  <span>
                    Whisper is not installed — go to <strong>Settings → Add-ons</strong> to
                    enable Audio Transcription, or paste a transcript directly into the{' '}
                    <strong>Chronicle</strong> tab instead.
                  </span>
                </div>
              )
            )}

            {/* Discard whole session escape hatch */}
            {sessionId && !isUploading && (
              <Button variant="ghost" size="sm" onClick={discardSession} className="text-destructive hover:text-destructive">
                <Trash2 className="mr-2 h-3.5 w-3.5" />
                Discard session
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">How to record a multitrack session</CardTitle>
          <CardDescription>
            Two paths, both reliable. The Craig path is recommended;
            you'll split long sessions into chunks (Craig rolls a new
            recording every hour automatically) and upload them all here.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div>
            <div className="font-medium">Option A — Craig bot (chunked)</div>
            <ol className="ml-5 list-decimal space-y-0.5 text-xs text-muted-foreground">
              <li>
                Invite <a href="https://craig.chat" target="_blank" rel="noreferrer" className="underline underline-offset-2">Craig</a> to your Discord server.
              </li>
              <li>
                Join your voice channel and run <code>/craig:join</code>. After
                ~60 minutes, run <code>/craig:leave</code>. Craig DMs you a
                download link — grab the multi-track FLAC zip.
              </li>
              <li>
                Immediately rejoin with <code>/craig:join</code> for the
                next chunk. Repeat until your session is done.
              </li>
              <li>
                Delete each Craig recording from craig.chat after you've
                downloaded the zip (their storage is limited).
              </li>
              <li>
                Drop all the chunk zips onto this page — either all at once,
                or staged across multiple batches using the <em>Save batch</em> +
                <em>Add another batch</em> flow. They'll be stitched in upload
                order (use the ↑/↓ arrows to reorder if needed).
              </li>
            </ol>
          </div>
          <div>
            <div className="font-medium">Option B — local per-player recording</div>
            <ol className="ml-5 list-decimal space-y-0.5 text-xs text-muted-foreground">
              <li>
                Each player records their own mic locally (Audacity, OBS,
                Windows Voice Recorder). Name the file with the player's
                name, e.g. <code>Wyldfyre.wav</code>.
              </li>
              <li>
                Everyone hits Record at "3, 2, 1, go" on Discord so the
                tracks share a start time.
              </li>
              <li>
                Collect all files in a folder, drag-drop them all here at
                once. They form one chunk.
              </li>
            </ol>
          </div>
          <div>
            <div className="font-medium">Staged batch uploads</div>
            <p className="ml-5 text-xs text-muted-foreground">
              Got 12 GB of Craig zips and a flaky internet connection?
              Drop the first few zips, click <em>Save Part 1</em>, wait for the
              green confirmation, then click <em>Add another batch</em> for the
              next set. Each batch commits independently — if Part 3 fails
              upload, Parts 1 and 2 stay saved and you can retry just Part 3.
              When everything's uploaded, click the green
              <em> All audio uploaded — start transcription</em> button.
              Whisper runs once across the whole stitched session.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function summariseBatch(files: File[]): string {
  if (files.length === 0) return 'empty batch'
  const zipCount = files.filter((f) => f.name.toLowerCase().endsWith('.zip')).length
  const looseCount = files.length - zipCount
  const namedPreview = files
    .slice(0, 2)
    .map((f) => f.name)
    .join(', ')
  const tail = files.length > 2 ? ` + ${files.length - 2} more` : ''
  if (zipCount > 0 && looseCount === 0) {
    return `${zipCount} zip${zipCount === 1 ? '' : 's'} — ${namedPreview}${tail}`
  }
  if (zipCount === 0 && looseCount > 0) {
    return `${looseCount} audio file${looseCount === 1 ? '' : 's'} — ${namedPreview}${tail}`
  }
  return `${zipCount} zip${zipCount === 1 ? '' : 's'} + ${looseCount} loose — ${namedPreview}${tail}`
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function formatDuration(ms: number): string {
  if (ms <= 0) return '0:00'
  const totalSec = Math.floor(ms / 1000)
  const hh = Math.floor(totalSec / 3600)
  const mm = Math.floor((totalSec % 3600) / 60)
  const ss = totalSec % 60
  if (hh > 0) return `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
  return `${mm}:${String(ss).padStart(2, '0')}`
}
