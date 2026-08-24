// The Whisper install gate, shared by every route into the install.
//
// The GPU warning below originally lived only inside the setup wizard's
// whisper step — which meant the Add-ons Install button, the path most
// people actually take, performed no check at all. The gate now guards the
// action, not one route to it. Three outcomes:
//
//   - NVIDIA card found      → proceed, and NAME the card so the user can
//                              see the check happened.
//   - no NVIDIA card         → recommend against (CPU transcription takes
//                              hours), require an explicit acknowledgement,
//                              never forbid.
//   - Python missing / wrong → block before the ~1.5 GB download starts.
//                              A failed download is the worst way to learn
//                              a prerequisite; there is nothing to
//                              acknowledge because the install WILL fail.
//
// The Python probe mirrors the installer's own lookup (see
// server/api/system.ts:detectPython), so "blocked" here means "the install
// script would fail", not "we found a python we dislike".

import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Cpu } from 'lucide-react'
import { getSystemInfo, type SystemInfo } from '@/lib/system'

/** Fetches system info once on mount. `null` while loading or on error —
 *  callers treat unknown as "could not check" and fail open with a note,
 *  never as "all clear". */
export function useWhisperPrereqs(): { info: SystemInfo | null; checked: boolean } {
  const [info, setInfo] = useState<SystemInfo | null>(null)
  const [checked, setChecked] = useState(false)
  useEffect(() => {
    let alive = true
    getSystemInfo()
      .then((s) => {
        if (alive) setInfo(s)
      })
      .catch(() => {
        /* fall through — checked flips regardless */
      })
      .finally(() => {
        if (alive) setChecked(true)
      })
    return () => {
      alive = false
    }
  }, [])
  return { info, checked }
}

/** Green confirmation naming the detected card, so "the check passed" is
 *  visible rather than implied by silence. */
export function GpuFoundLine({ name, vramGb }: { name?: string; vramGb?: number }) {
  return (
    <p className="flex items-center gap-2 text-sm">
      <CheckCircle2 className="h-4 w-4 shrink-0 text-green-500" />
      <span>
        <strong>{name ?? 'NVIDIA graphics card'}</strong>
        {vramGb ? ` (${vramGb} GB)` : ''} detected — transcription will use it.
      </span>
    </p>
  )
}

/**
 * The no-dedicated-GPU warning. Copy moved verbatim from the setup wizard's
 * whisper step — it was the best-written text in the app and the wording is
 * deliberately preserved.
 */
export function CpuWhisperWarning({
  accepted,
  onAcceptedChange,
}: {
  accepted: boolean
  onAcceptedChange: (next: boolean) => void
}) {
  return (
    <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
      <p className="font-medium">No dedicated graphics card was found on this computer</p>
      <p className="text-muted-foreground">
        Whisper will still work, but it will use your processor instead of a graphics card. In
        practice that means a three-hour recording can take <strong>several hours</strong> to
        transcribe, rather than 20–30 minutes.
      </p>
      <p className="text-muted-foreground">
        Most people in this position are better off skipping this and using the YouTube route
        instead: upload the recording as an unlisted video, let YouTube transcribe it, and import
        the captions. It costs nothing and takes minutes.
      </p>
      <label className="flex cursor-pointer items-start gap-2">
        <input
          type="checkbox"
          className="mt-1"
          checked={accepted}
          onChange={(e) => onAcceptedChange(e.target.checked)}
        />
        <span>
          I understand transcription will take hours on this computer, and I still want to
          install Whisper.
        </span>
      </label>
    </div>
  )
}

/** Hard stop: the installer will fail after the download, so don't start it. */
export function PythonBlockedNotice({
  found,
  version,
}: {
  found: boolean
  version: string | null
}) {
  return (
    <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
      <p className="flex items-center gap-2 font-medium text-destructive">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        {found
          ? `Python ${version} can't run Whisper`
          : 'Python was not found on this computer'}
      </p>
      <p className="text-muted-foreground">
        {found ? (
          <>
            Whisper needs Python <strong>3.10, 3.11 or 3.12</strong> — its speech components
            aren't published for {version} yet, so the install would download ~1.5&nbsp;GB and
            then fail.
          </>
        ) : (
          <>
            Whisper is written in Python, so Python has to be installed first — the install
            would fail before it starts.
          </>
        )}
      </p>
      <p className="text-muted-foreground">
        Install Python 3.12 from{' '}
        <a
          className="text-primary underline-offset-2 hover:underline"
          href="https://www.python.org/downloads/"
          target="_blank"
          rel="noreferrer"
        >
          python.org
        </a>{' '}
        {found
          ? '(it can sit alongside your current version, but it must be the one `python` runs)'
          : "and tick 'Add Python to PATH' in its installer"}
        , then come back and install Whisper.
      </p>
    </div>
  )
}

/**
 * The complete pre-install panel used by the Add-ons row: check → outcome →
 * proceed or stop. `onProceed` starts the real install stream.
 */
export function WhisperInstallPrecheck({
  onProceed,
  onCancel,
  installing,
}: {
  onProceed: () => void
  onCancel: () => void
  installing: boolean
}) {
  const { info, checked } = useWhisperPrereqs()
  const [accepted, setAccepted] = useState(false)

  if (!checked) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
        <Cpu className="h-4 w-4 animate-pulse" />
        Checking this computer…
      </div>
    )
  }

  const pythonBad = info !== null && !info.python.supported
  const gpuFound = info?.gpu.detected === true
  const canProceed = !pythonBad && (gpuFound || accepted || info === null)

  return (
    <div className="space-y-3 rounded-md border border-border bg-muted/20 p-3">
      {info === null && (
        <p className="text-sm text-muted-foreground">
          Couldn't check this computer's hardware — the install can still go ahead, but the
          notes below won't be personalised.
        </p>
      )}

      {pythonBad && <PythonBlockedNotice found={info.python.found} version={info.python.version} />}

      {!pythonBad && gpuFound && <GpuFoundLine name={info?.gpu.name} vramGb={info?.gpu.vramGb} />}

      {!pythonBad && info !== null && !gpuFound && (
        <CpuWhisperWarning accepted={accepted} onAcceptedChange={setAccepted} />
      )}

      <div className="flex items-center gap-2">
        {!pythonBad && (
          <button
            type="button"
            disabled={!canProceed || installing}
            onClick={onProceed}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {installing ? 'Installing…' : 'Download and install (~1.5 GB)'}
          </button>
        )}
        <button
          type="button"
          onClick={onCancel}
          disabled={installing}
          className="rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-50"
        >
          {pythonBad ? 'Close' : 'Cancel'}
        </button>
      </div>
    </div>
  )
}
