// Running transcript + inline speaker mapping for a freshly-uploaded
// multitrack session. The server's `runState` drives which view shows:
//
//   recording     — nothing enqueued yet; the upload is being unpacked.
//   loading_model — Whisper is loading (first run downloads the model).
//   transcribing  — one speaker track at a time. The progress bar is in
//                   audio-seconds, not utterances, because one utterance
//                   is a whole per-speaker track of up to an hour and a
//                   per-utterance bar would sit still for most of a run.
//   finalising    — every track done; the merged SBV is being written.
//   ready         — manifest.processing.sbvPath is set. The progress bar
//                   gives way to a "Transcription finished" line, and the
//                   big green "Use this transcript for refinement" button
//                   hands off to the same pipeline any uploaded .sbv would
//                   feed.
//   failed        — the run stopped on an error (message shown once).
//   interrupted   — the server restarted mid-run; the manifest snapshot
//                   is all that remains, and the user must re-Process.
//
// Between tracks nothing else on screen changes, so the component also
// shows how long since the server last did anything, corrected for the
// gap between its clock and ours, and escalates from "still working" to
// "this may be stuck" on thresholds that scale with the track in flight.
//
// Speaker mapping edits write to speakers.json and POST
// /api/sessions/:id/live/refresh so cue labels update without re-running
// Whisper on any audio.

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  SendToBack,
  User as UserIcon,
} from 'lucide-react'
import { Button } from '@/platform/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/platform/ui/card'
import { Input } from '@/platform/ui/input'
import { Label } from '@/platform/ui/label'
import { Progress } from '@/platform/ui/progress'
import { useServerClock } from '@/features/transcription/hooks/useServerClock'
import {
  getLiveSession,
  refreshLiveLabels,
  type LiveEngine,
  type LiveParticipant,
  type LiveSessionResponse,
} from '@/features/transcription/lib/liveSession'
import {
  findSpeakerFor,
  getSpeakers,
  putSpeakers,
  type Speaker,
  type SpeakersDocument,
} from '@/features/corrections'
import {
  audioPercent,
  deriveDisplayPhase,
  deviceLabel,
  etaMs,
  formatAudioProgress,
  formatClock,
  formatEta,
  formatRealtime,
  formatTrackLength,
  isInProgress,
  observedPerTrackMs,
  stallLevel,
  trackCounts,
  wholeMinutes,
  type DisplayPhase,
  type StallLevel,
  splitErrorLines,
} from '@/features/transcription/lib/transcriptionLiveness'

const POLL_MS = 2000
/** Nobody is watching a hidden tab; poll slowly and catch up on return. */
const HIDDEN_POLL_MS = 10_000
/** The live region speaks at most once per this interval. */
const ANNOUNCE_GAP_MS = 30_000

export type LiveTranscriptProps = {
  sessionId: string
  /** Called when the user clicks Use this transcript. */
  onSendToRefinement?: (sbv: string) => void
}

type ParticipantDraft = {
  playerName: string
  characterName: string
  /** True if the row exists in speakers.json (vs. an unsaved local row). */
  persisted: boolean
}

/** One poll response plus the client clock when it landed, for skew correction. */
type Sample = {
  live: LiveSessionResponse
  receivedAt: number
}

function speakerLabel(participant: LiveParticipant, draft: ParticipantDraft | undefined): string {
  const character = draft?.characterName?.trim()
  const player = draft?.playerName?.trim()
  if (character && player) return `${character} (${player})`
  if (character) return character
  if (player) return player
  return participant.discordDisplayName ?? participant.discordUserId
}

const PHASE_TITLE: Record<DisplayPhase, string> = {
  recording: 'Waiting for the first track…',
  loading_model: 'Loading the Whisper model…',
  transcribing: 'Transcribing',
  finalising: 'Finalising',
  ready: 'Transcript ready',
  failed: 'Transcription failed',
  interrupted: 'Transcription interrupted',
}

function phaseDescription(phase: DisplayPhase): string {
  switch (phase) {
    case 'recording':
      return 'The upload is being unpacked. Whisper starts on the first speaker track as soon as it lands. Map speakers below so cues end up with the right character and player names.'
    case 'loading_model':
      return 'Loading the Whisper model… the first run downloads about 3 GB, so it can be a few minutes before the first track starts.'
    case 'transcribing':
      return 'Each speaker track is transcribed in turn — a long track can take several minutes with nothing new on screen. Map speakers below so cues end up with the right character and player names.'
    case 'finalising':
      return 'Every track is transcribed. Whisper is merging them into one chronological transcript.'
    case 'ready':
      return 'Transcription is final. Click the green button to drop this transcript into the refinement pipeline — it runs the same deterministic glossary clean-up and four-phase grounding as an uploaded .sbv.'
    case 'failed':
      return 'The run stopped on an error. Fix the cause it names, then reopen the session from the list and press Process to try again.'
    case 'interrupted':
      return 'Transcription was interrupted by a server restart — reopen the session from the list and press Process to resume.'
  }
}

function waitingButtonLabel(phase: DisplayPhase): string {
  switch (phase) {
    case 'recording':
      return 'Waiting for the first track…'
    case 'loading_model':
      return 'Loading model…'
    case 'finalising':
      return 'Finalising transcript…'
    default:
      return 'Transcribing…'
  }
}

function quietCopy(phase: DisplayPhase): string {
  switch (phase) {
    case 'loading_model':
      return 'The model is still loading — the first run downloads about 3 GB and can take several minutes.'
    case 'transcribing':
      return 'Whisper is still working on this track — long tracks can take several minutes.'
    default:
      return 'Still working — this can take a moment.'
  }
}

/** Mono pill, as PhaseProgress uses for the provider; amber when the GPU path fell over. */
function EnginePills({ engine }: { engine: LiveEngine }) {
  const device = deviceLabel(engine)
  const neutral = 'rounded border border-border bg-muted/60 px-2 py-0.5 font-mono text-[10px] font-normal text-foreground/80'
  const amber =
    'rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 font-mono text-[10px] font-normal text-amber-700 dark:text-amber-300'
  return (
    <>
      <span className="text-xs font-normal text-muted-foreground">·</span>
      <span className={neutral} title={`${engine.name} · ${engine.computeType}`}>
        {engine.model}
      </span>
      <span className="text-xs font-normal text-muted-foreground">·</span>
      <span
        className={engine.fallback ? amber : neutral}
        title={
          engine.fallback
            ? 'The GPU path failed, so Whisper is running on the CPU. It will finish, several times slower.'
            : 'The device Whisper is running on.'
        }
      >
        {device}
      </span>
    </>
  )
}

/**
 * What the screen reader hears. Only milestones — never the ticking
 * clock — so it cannot chatter every second.
 */
function milestoneText(
  phase: DisplayPhase,
  live: LiveSessionResponse,
  counts: { done: number; total: number },
  eta: number | null,
): string {
  const engine = live.engine
  const where = engine ? ` on ${deviceLabel(engine)} with ${engine.model}` : ''
  switch (phase) {
    case 'recording':
      return 'Waiting for the first track.'
    case 'loading_model':
      return 'Loading the Whisper model.'
    case 'transcribing': {
      const progress =
        counts.done > 0
          ? `${counts.done} of ${counts.total} tracks done.`
          : counts.total > 0
          ? `Track 1 of ${counts.total}.`
          : ''
      const remaining = eta !== null ? ` About ${formatEta(eta).replace(/^~/, '')} remaining.` : ''
      return `Transcribing${where}. ${progress}${remaining}`.trim()
    }
    case 'finalising':
      return 'All tracks transcribed. Writing the final transcript.'
    case 'ready': {
      const errors = splitErrorLines(live.errors).errors.length
      return `Transcript ready: ${counts.done} tracks, ${live.cueCount ?? 0} cues${
        errors > 0 ? `, ${errors} errors` : ''
      }.`
    }
    case 'failed':
      return 'Transcription failed.'
    case 'interrupted':
      return 'Transcription was interrupted by a server restart.'
  }
}

export function LiveTranscript({ sessionId, onSendToRefinement }: LiveTranscriptProps) {
  const [sample, setSample] = useState<Sample | null>(null)
  const [drafts, setDrafts] = useState<Record<string, ParticipantDraft>>({})
  const [savingSpeaker, setSavingSpeaker] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Avoid clobbering an in-flight user edit when the poll snapshot lands.
  const editingRef = useRef(false)

  const live = sample?.live ?? null
  const phase = deriveDisplayPhase(live)
  const inProgress = isInProgress(phase)
  const clock = useServerClock(
    sample ? { serverNow: sample.live.serverNow, receivedAt: sample.receivedAt } : null,
    inProgress,
  )

  const takeSample = useCallback((state: LiveSessionResponse) => {
    setSample({ live: state, receivedAt: Date.now() })
  }, [])

  const seedDraftsFromSpeakers = useCallback(
    (participants: LiveParticipant[], doc: SpeakersDocument) => {
      setDrafts((prev) => {
        if (editingRef.current) return prev
        const next: Record<string, ParticipantDraft> = { ...prev }
        for (const participant of participants) {
          // ID first, then Discord display name: mappings saved before
          // speaker identity moved off Craig's track index are keyed by
          // that old numeric ID and would otherwise not pre-fill here.
          const existing = findSpeakerFor(
            doc.speakers,
            participant.discordUserId,
            participant.discordDisplayName,
          )
          next[participant.discordUserId] = {
            playerName: existing?.playerName ?? prev[participant.discordUserId]?.playerName ?? '',
            characterName:
              existing?.characterName ?? prev[participant.discordUserId]?.characterName ?? '',
            persisted: !!existing,
          }
        }
        return next
      })
    },
    []
  )

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    // A tab coming back to the foreground polls at once rather than
    // waiting out a slow hidden-tab interval. The generation counter lets
    // that fresh poll supersede the one already scheduled or in flight.
    let generation = 0

    async function tick(mine: number) {
      try {
        const [state, speakers] = await Promise.all([getLiveSession(sessionId), getSpeakers()])
        if (cancelled || mine !== generation) return
        takeSample(state)
        seedDraftsFromSpeakers(state.participants, speakers)
        setError(null)
      } catch (err) {
        if (!cancelled && mine === generation) setError((err as Error).message)
      } finally {
        if (!cancelled && mine === generation) {
          const delay = typeof document !== 'undefined' && document.hidden ? HIDDEN_POLL_MS : POLL_MS
          timer = setTimeout(() => void tick(mine), delay)
        }
      }
    }

    function onVisibilityChange() {
      if (document.visibilityState !== 'visible') return
      if (timer) clearTimeout(timer)
      timer = null
      generation += 1
      void tick(generation)
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    void tick(generation)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [sessionId, seedDraftsFromSpeakers, takeSample])

  function patchDraft(userId: string, patch: Partial<ParticipantDraft>) {
    editingRef.current = true
    setDrafts((prev) => ({
      ...prev,
      [userId]: {
        playerName: prev[userId]?.playerName ?? '',
        characterName: prev[userId]?.characterName ?? '',
        persisted: prev[userId]?.persisted ?? false,
        ...patch,
      },
    }))
  }

  async function saveSpeaker(participant: LiveParticipant) {
    const draft = drafts[participant.discordUserId]
    if (!draft) return
    setSavingSpeaker(participant.discordUserId)
    try {
      const doc = await getSpeakers()
      // Drop any row for this person keyed by the OLD track-index ID as
      // well as the current one, so saving collapses a legacy duplicate
      // instead of leaving two rows for the same Discord account. The
      // display-name fallback in findSpeakerFor keeps older sessions
      // resolving against the re-keyed row.
      const displayNeedle = participant.discordDisplayName?.trim().toLowerCase()
      const others = doc.speakers.filter(
        (s) =>
          s.discordUserId !== participant.discordUserId &&
          !(displayNeedle && s.discordDisplayName?.trim().toLowerCase() === displayNeedle),
      )
      const next: SpeakersDocument = {
        version: 1,
        speakers: [
          ...others,
          {
            discordUserId: participant.discordUserId,
            discordDisplayName: participant.discordDisplayName,
            playerName: draft.playerName.trim(),
            characterName: draft.characterName.trim(),
          } satisfies Speaker,
        ],
      }
      await putSpeakers(next)
      await refreshLiveLabels(sessionId)
      editingRef.current = false
      patchDraft(participant.discordUserId, { persisted: true })
      takeSample(await getLiveSession(sessionId))
      toast.success(`Saved ${draft.characterName || draft.playerName || participant.discordUserId}.`)
    } catch (err) {
      toast.error(`Save failed: ${(err as Error).message}`)
    } finally {
      setSavingSpeaker(null)
    }
  }

  // ---- Derived progress ----------------------------------------------
  const participants = live?.participants ?? []
  const sbv = live?.sbv ?? ''
  const counts = trackCounts(live)
  const current = live?.current ?? null
  const engine = live?.engine ?? null
  const throughput = typeof live?.throughput === 'number' && live.throughput > 0 ? live.throughput : null
  const pctAudio = live ? audioPercent(live) : null
  // Older servers report no audio totals; fall back to the track fraction
  // so the bar still moves rather than sitting at zero.
  const percent =
    pctAudio ?? (counts.total > 0 ? Math.min(100, (counts.done / counts.total) * 100) : 0)
  const valueText =
    pctAudio !== null && live
      ? formatAudioProgress(live.processedAudioMs ?? 0, live.totalAudioMs ?? 0)
      : `${counts.done} of ${counts.total} tracks`
  const eta = live ? etaMs({ ...live, throughput }) : null
  const elapsed = inProgress ? clock.sinceMs(live?.startedAt) : null
  const trackStarted = current ? clock.sinceMs(current.startedAt) : null

  const activityTs = live?.lastActivityAt ?? live?.startedAt ?? null
  const sinceActivity = inProgress ? clock.sinceMs(activityTs) : null
  const stall: StallLevel =
    inProgress && live && sample
      ? stallLevel({
          lastActivityAt: activityTs,
          serverNow: live.serverNow,
          receivedAt: sample.receivedAt,
          clientNow: clock.now,
          currentAudioMs: current?.audioMs,
          observedPerTrackMs: observedPerTrackMs(live),
          throughput,
        })
      : 'fresh'

  const { errors: errorLines, notes: noteLines } = splitErrorLines(live?.errors)
  const errorCount = errorLines.length
  const errorsId = `live-errors-${sessionId}`
  const showErrorList = errorCount > 0 || stall === 'stalled'

  // ---- Live region: milestones only, at most one change per 30 s -----
  const [announcement, setAnnouncement] = useState('')
  const announceRef = useRef<{
    lastAt: number
    pending: string | null
    timer: ReturnType<typeof setTimeout> | null
  }>({ lastAt: 0, pending: null, timer: null })
  const milestoneTextRef = useRef('')
  if (live) milestoneTextRef.current = milestoneText(phase, live, counts, eta)
  const milestoneKey = live
    ? [phase, counts.done, engine?.device ?? '', engine?.fallback ? 'fallback' : ''].join('|')
    : ''

  useEffect(() => {
    if (!milestoneKey) return
    const r = announceRef.current
    const text = milestoneTextRef.current
    const wait = ANNOUNCE_GAP_MS - (Date.now() - r.lastAt)
    if (wait <= 0) {
      r.lastAt = Date.now()
      r.pending = null
      setAnnouncement(text)
      return
    }
    // Inside the quiet gap: remember the newest milestone and speak it
    // when the gap ends, so a burst of short tracks yields one sentence.
    r.pending = text
    if (r.timer === null) {
      r.timer = setTimeout(() => {
        r.timer = null
        if (r.pending !== null) {
          r.lastAt = Date.now()
          setAnnouncement(r.pending)
          r.pending = null
        }
      }, wait)
    }
  }, [milestoneKey])

  useEffect(() => {
    const r = announceRef.current
    return () => {
      if (r.timer !== null) clearTimeout(r.timer)
    }
  }, [])

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {inProgress ? (
            <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin text-primary" />
          ) : phase === 'ready' ? (
            <CheckCircle2 aria-hidden="true" className="h-4 w-4 text-green-500" />
          ) : (
            <AlertTriangle aria-hidden="true" className="h-4 w-4 text-destructive" />
          )}
          {PHASE_TITLE[phase]}
          {engine && <EnginePills engine={engine} />}
        </CardTitle>
        <CardDescription>{phaseDescription(phase)}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
          {announcement}
        </div>

        {phase === 'failed' && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
          >
            <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{live?.failure || 'Transcription failed. The error list below has what Whisper reported.'}</span>
          </div>
        )}

        {live && inProgress && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span>
                {current ? (
                  <>
                    Track {counts.total > 0 ? Math.min(counts.done + 1, counts.total) : counts.done + 1}
                    {counts.total > 0 ? ` of ${counts.total}` : ''} — {current.speakerDisplay} (
                    {formatTrackLength(current.audioMs)})
                    {trackStarted !== null ? ` · started ${formatClock(trackStarted)} ago` : ''}
                    {current.attempt > 1 ? ` · attempt ${current.attempt}` : ''}
                  </>
                ) : (
                  <>
                    {counts.done} of {counts.total} tracks
                  </>
                )}
              </span>
              <span className="font-mono">{percent.toFixed(0)}%</span>
            </div>
            {/* The shared wrapper keeps `value` for its indicator and does not
                hand it to the Radix root, so the ARIA value is set here
                directly — Radix spreads these props after its own. */}
            <Progress
              value={Math.round(Math.min(100, Math.max(0, percent)))}
              aria-label="Audio transcribed"
              aria-valuenow={Math.round(Math.min(100, Math.max(0, percent)))}
              aria-valuetext={valueText}
            />
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>
                {[
                  elapsed !== null ? `Elapsed ${formatClock(elapsed)}` : null,
                  throughput !== null ? formatRealtime(throughput) : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
              {inProgress && (
                <span>{eta === null ? 'ETA: estimating…' : `ETA ${formatEta(eta)} remaining`}</span>
              )}
            </div>
          </div>
        )}

        {/* A bar left full at 100 % reads as a job that hung on its last
            step, so a finished run gets a done line in its place. */}
        {live && phase === 'ready' && (
          <div
            className={`space-y-1 rounded-md border px-3 py-2 ${
              errorCount > 0
                ? 'border-amber-500/30 bg-amber-500/10'
                : 'border-green-600/30 bg-green-600/5'
            }`}
          >
            <p
              className={`flex items-center gap-2 text-sm font-medium ${
                errorCount > 0
                  ? 'text-amber-900 dark:text-amber-200'
                  : 'text-green-700 dark:text-green-400'
              }`}
            >
              {errorCount > 0 ? (
                <AlertTriangle aria-hidden="true" className="h-4 w-4 shrink-0" />
              ) : (
                <CheckCircle2 aria-hidden="true" className="h-4 w-4 shrink-0" />
              )}
              {errorCount > 0
                ? `Transcription finished with ${errorCount} error${errorCount === 1 ? '' : 's'}`
                : 'Transcription finished'}
            </p>
            <p className="text-xs text-muted-foreground">
              {counts.done} of {counts.total} tracks transcribed
              {throughput !== null ? ` · ${formatRealtime(throughput)}` : ''}
            </p>
            {sbv && (
              <p className="text-xs text-muted-foreground">
                Next: press <strong>Use this transcript for refinement</strong> at the foot of this
                panel.
              </p>
            )}
          </div>
        )}

        {inProgress && sinceActivity !== null && stall === 'fresh' && (
          <p className="text-xs text-muted-foreground">last update {formatClock(sinceActivity)} ago</p>
        )}
        {inProgress && sinceActivity !== null && stall === 'quiet' && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
            <Loader2 aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />
            <span>
              last update {formatClock(sinceActivity)} ago — {quietCopy(phase)}
            </span>
          </div>
        )}
        {inProgress && sinceActivity !== null && stall === 'stalled' && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <AlertTriangle aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              No progress for {wholeMinutes(sinceActivity)} minute
              {wholeMinutes(sinceActivity) === 1 ? '' : 's'} — this may be stuck.{' '}
              <a href={`#${errorsId}`} className="underline underline-offset-2">
                See the error list
              </a>
              . Last update {formatClock(sinceActivity)} ago.
            </span>
          </div>
        )}

        {live && (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="rounded-md border border-border p-2 text-center">
              <div className="text-xs text-muted-foreground">Tracks transcribed</div>
              <div className="text-xl font-medium">
                {counts.done}
                {counts.total > 0 ? <span className="text-muted-foreground"> / {counts.total}</span> : null}
              </div>
            </div>
            <div className="rounded-md border border-border p-2 text-center">
              <div className="text-xs text-muted-foreground">Cues transcribed</div>
              <div className="text-xl font-medium">{live.cueCount ?? 0}</div>
            </div>
            <div className="rounded-md border border-border p-2 text-center">
              <div className="text-xs text-muted-foreground">Errors</div>
              <div className={`text-xl font-medium ${errorCount > 0 ? 'text-destructive' : ''}`}>
                {errorCount}
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
            <AlertTriangle aria-hidden="true" className="h-4 w-4" />
            {error}
          </div>
        )}

        <section className="space-y-2">
          <h4 className="font-display tracking-wider uppercase text-sm">
            Speakers heard this session
          </h4>
          {participants.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No speakers yet — they appear as each track is transcribed.
            </p>
          ) : (
            <ul className="space-y-2">
              {participants.map((participant) => {
                const draft = drafts[participant.discordUserId]
                const persisted = draft?.persisted ?? false
                const label = speakerLabel(participant, draft)
                return (
                  <li
                    key={participant.discordUserId}
                    className="space-y-2 rounded-md border border-border p-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2 text-sm">
                        <UserIcon className="h-4 w-4 text-muted-foreground" />
                        <code className="text-xs">
                          {participant.discordDisplayName ?? participant.discordUserId}
                        </code>
                        <span className="text-xs text-muted-foreground">→</span>
                        <span className="font-medium">{label}</span>
                        {!persisted && (
                          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-700 dark:text-amber-300">
                            Unmapped
                          </span>
                        )}
                      </div>
                      <Button
                        size="sm"
                        variant={persisted ? 'outline' : 'default'}
                        disabled={savingSpeaker === participant.discordUserId}
                        onClick={() => saveSpeaker(participant)}
                      >
                        {savingSpeaker === participant.discordUserId
                          ? 'Saving…'
                          : persisted
                          ? 'Update'
                          : 'Save mapping'}
                      </Button>
                    </div>
                    <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                      <div className="space-y-1">
                        <Label htmlFor={`live-player-${participant.discordUserId}`}>
                          Player name
                        </Label>
                        <Input
                          id={`live-player-${participant.discordUserId}`}
                          placeholder="e.g. Wyldfyre"
                          value={draft?.playerName ?? ''}
                          onChange={(e) =>
                            patchDraft(participant.discordUserId, { playerName: e.target.value })
                          }
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor={`live-character-${participant.discordUserId}`}>
                          Character name
                        </Label>
                        <Input
                          id={`live-character-${participant.discordUserId}`}
                          placeholder="e.g. Ottilie"
                          value={draft?.characterName ?? ''}
                          onChange={(e) =>
                            patchDraft(participant.discordUserId, {
                              characterName: e.target.value,
                            })
                          }
                        />
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="font-display tracking-wider uppercase text-sm">
              Transcript so far
            </h4>
            <span className="text-xs text-muted-foreground">
              {sbv ? `${sbv.split('\n').length} lines` : 'no cues yet'}
            </span>
          </div>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/30 p-3 font-mono text-xs leading-relaxed">
            {sbv || (phase === 'finalising' ? 'Finalising…' : '(awaiting the first track…)')}
          </pre>
        </section>

        {showErrorList && (
          <details id={errorsId} className="rounded-md border border-destructive/40 p-2 text-xs">
            <summary className="cursor-pointer text-destructive">
              {errorCount} transcription error{errorCount === 1 ? '' : 's'}
            </summary>
            {errorCount === 0 ? (
              <p className="mt-2 text-muted-foreground">
                Whisper has reported nothing. If this stays stuck, the server console is the place to look.
              </p>
            ) : (
              <ul className="ml-4 mt-2 list-disc space-y-1">
                {errorLines.map((e, i) => (
                  <li key={i}>
                    <code className="text-xs">{e}</code>
                  </li>
                ))}
              </ul>
            )}
          </details>
        )}

        {noteLines.length > 0 && (
          <ul className="space-y-1 text-xs text-muted-foreground" aria-label="Engine notes">
            {noteLines.map((n, i) => (
              <li key={i}>
                <code className="text-xs">{n}</code>
              </li>
            ))}
          </ul>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          {phase === 'ready' ? (
            <Button
              size="lg"
              className="bg-green-600 text-white hover:bg-green-500 focus-visible:ring-green-600"
              disabled={!sbv}
              onClick={() => sbv && onSendToRefinement?.(sbv)}
            >
              <SendToBack className="mr-2 h-5 w-5" />
              Use this transcript for refinement
            </Button>
          ) : inProgress ? (
            <Button variant="secondary" size="sm" disabled title="Wait for transcription to finish — the green button will appear here automatically.">
              <Loader2 aria-hidden="true" className="mr-2 h-4 w-4 animate-spin" />
              {waitingButtonLabel(phase)}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              try {
                await refreshLiveLabels(sessionId)
                takeSample(await getLiveSession(sessionId))
                toast.success('Transcript re-rendered with the latest speaker mapping.')
              } catch (err) {
                toast.error(`Refresh failed: ${(err as Error).message}`)
              }
            }}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Re-render labels
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
