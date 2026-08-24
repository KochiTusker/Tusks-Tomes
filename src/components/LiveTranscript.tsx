// Running transcript + inline speaker mapping for a freshly-uploaded
// multitrack session. Three explicit phases drive the UI:
//
//   1. Recording  — utterances are still being enqueued from the upload
//                   pipeline and live cues are streaming in.
//   2. Processing — ingest is done, Whisper is grinding through the
//                   queue. Progress bar shows processed / enqueued.
//   3. Ready      — manifest.processing.sbvPath is set, transcript is
//                   final, the big green "Use this transcript for
//                   refinement" button hands off to the same pipeline
//                   any uploaded .sbv would feed.
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
  Mic,
  RefreshCw,
  SendToBack,
  User as UserIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  getLiveSession,
  refreshLiveLabels,
  type LiveParticipant,
  type LiveSessionResponse,
} from '@/lib/liveSession'
import {
  findSpeakerFor,
  getSpeakers,
  putSpeakers,
  type Speaker,
  type SpeakersDocument,
} from '@/lib/speakers'

const POLL_MS = 2000

export type LiveTranscriptProps = {
  sessionId: string
  /** Called when the user clicks Use this transcript. */
  onSendToRefinement?: (sbv: string) => void
}

type Phase = 'recording' | 'processing' | 'ready'

type ParticipantDraft = {
  playerName: string
  characterName: string
  /** True if the row exists in speakers.json (vs. an unsaved local row). */
  persisted: boolean
}

function speakerLabel(participant: LiveParticipant, draft: ParticipantDraft | undefined): string {
  const character = draft?.characterName?.trim()
  const player = draft?.playerName?.trim()
  if (character && player) return `${character} (${player})`
  if (character) return character
  if (player) return player
  return participant.discordDisplayName ?? participant.discordUserId
}

function phaseOf(live: LiveSessionResponse | null): Phase {
  if (!live) return 'recording'
  if (live.active) return 'recording'
  if (live.finalized) return 'ready'
  return 'processing'
}

function PhaseBadge({ phase }: { phase: Phase }) {
  if (phase === 'recording') {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-red-500/15 px-1.5 py-0.5 text-xs text-red-600 dark:text-red-400">
        <Mic className="h-3 w-3" /> Recording
      </span>
    )
  }
  if (phase === 'processing') {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-700 dark:text-amber-400">
        <Loader2 className="h-3 w-3 animate-spin" /> Processing
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded bg-green-500/15 px-1.5 py-0.5 text-xs text-green-600 dark:text-green-400">
      <CheckCircle2 className="h-3 w-3" /> Ready
    </span>
  )
}

function ProgressBar({ value, label }: { value: number; label: string }) {
  const pct = Math.min(100, Math.max(0, value * 100))
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        <span>{pct.toFixed(0)}%</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded bg-muted">
        <div
          className="h-2 rounded bg-amber-500 transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

export function LiveTranscript({ sessionId, onSendToRefinement }: LiveTranscriptProps) {
  const [live, setLive] = useState<LiveSessionResponse | null>(null)
  const [drafts, setDrafts] = useState<Record<string, ParticipantDraft>>({})
  const [savingSpeaker, setSavingSpeaker] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Avoid clobbering an in-flight user edit when the poll snapshot lands.
  const editingRef = useRef(false)

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

    async function tick() {
      try {
        const [state, speakers] = await Promise.all([getLiveSession(sessionId), getSpeakers()])
        if (cancelled) return
        setLive(state)
        seedDraftsFromSpeakers(state.participants, speakers)
        setError(null)
      } catch (err) {
        if (!cancelled) setError((err as Error).message)
      } finally {
        if (!cancelled) timer = setTimeout(tick, POLL_MS)
      }
    }

    void tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [sessionId, seedDraftsFromSpeakers])

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
      setLive(await getLiveSession(sessionId))
      toast.success(`Saved ${draft.characterName || draft.playerName || participant.discordUserId}.`)
    } catch (err) {
      toast.error(`Save failed: ${(err as Error).message}`)
    } finally {
      setSavingSpeaker(null)
    }
  }

  const phase = phaseOf(live)
  const participants = live?.participants ?? []
  const sbv = live?.sbv ?? ''
  // Progress denominator: enqueued is the running total of utterances ever
  // pushed onto the queue for this session. processed is utterances Whisper
  // has finished. If we somehow drop to 0/0 (no audio yet), display 0%.
  const denom = live?.enqueued ?? 0
  const numer = live?.processed ?? 0
  const progress = denom > 0 ? numer / denom : 0

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Live transcript
          <PhaseBadge phase={phase} />
        </CardTitle>
        <CardDescription>
          {phase === 'recording'
            ? 'Ingest in progress. Whisper transcribes each utterance as it lands. Map speakers below so cues end up with the right character + player names.'
            : phase === 'processing'
            ? 'Ingest complete. Whisper is finalising any utterances that were still in the queue. The progress bar advances as each one completes.'
            : 'Transcription is final. Click the green button to drop this transcript into the refinement pipeline — it runs the same deterministic glossary clean-up and four-phase grounding as an uploaded .sbv.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {phase === 'processing' && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
            <ProgressBar
              value={progress}
              label={`${numer} / ${denom} utterances transcribed${
                live?.pending ? ` · ${live.pending} in queue` : ''
              }`}
            />
          </div>
        )}

        {phase !== 'processing' && (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="rounded-md border border-border p-2 text-center">
              <div className="text-xs text-muted-foreground">Cues transcribed</div>
              <div className="text-xl font-medium">{live?.cueCount ?? 0}</div>
            </div>
            <div className="rounded-md border border-border p-2 text-center">
              <div className="text-xs text-muted-foreground">
                {phase === 'recording' ? 'In Whisper queue' : 'Utterances processed'}
              </div>
              <div className="text-xl font-medium flex items-center justify-center gap-2">
                {phase === 'recording' ? live?.pending ?? 0 : numer}
                {(live?.pending ?? 0) > 0 && phase === 'recording' && (
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                )}
              </div>
            </div>
            <div className="rounded-md border border-border p-2 text-center">
              <div className="text-xs text-muted-foreground">Errors</div>
              <div
                className={`text-xl font-medium ${
                  (live?.errors.length ?? 0) > 0 ? 'text-destructive' : ''
                }`}
              >
                {live?.errors.length ?? 0}
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
            <AlertTriangle className="h-4 w-4" />
            {error}
          </div>
        )}

        <section className="space-y-2">
          <h4 className="font-display tracking-wider uppercase text-sm">
            Speakers heard this session
          </h4>
          {participants.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No-one has spoken yet — start talking in the voice channel.
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
                          placeholder="e.g. Almira"
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
            {sbv || (phase === 'processing' ? 'Finalising…' : '(awaiting the first utterance…)')}
          </pre>
        </section>

        {live?.errors && live.errors.length > 0 && (
          <details className="rounded-md border border-destructive/40 p-2 text-xs">
            <summary className="cursor-pointer text-destructive">
              {live.errors.length} transcription error{live.errors.length === 1 ? '' : 's'}
            </summary>
            <ul className="ml-4 mt-2 list-disc space-y-1">
              {live.errors.map((e, i) => (
                <li key={i}>
                  <code className="text-xs">{e}</code>
                </li>
              ))}
            </ul>
          </details>
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
          ) : (
            <Button variant="secondary" size="sm" disabled title="Wait for Processing to finish — the green button below will appear automatically.">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {phase === 'recording' ? 'Ingesting upload…' : 'Finalising transcript…'}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              try {
                await refreshLiveLabels(sessionId)
                setLive(await getLiveSession(sessionId))
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
