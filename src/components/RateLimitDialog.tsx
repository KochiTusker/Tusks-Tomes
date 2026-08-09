// Rate-limit dialog — fires when a long-running cloud pipeline hits a
// per-minute or daily quota on its current key. Offers four user choices:
// stop now and export what we have, slow down (3× pacing), pause and save
// for later (writes a disk checkpoint), or fall back to the paid key for
// the rest of the run.
//
// The copy is verbose and tier-aware. The provider event populates which
// key was actually rate-limited (with a short fingerprint matching the
// Settings → API Keys probe row), how many requests the singleton has
// dispatched in the last 60 seconds, and the model's published RPM/TPM
// caps. This means the user can see at a glance:
//   - which physical key is being throttled,
//   - whether they're against the cap or just unlucky,
//   - whether "Switch to paid key" is a meaningful action (it isn't if
//     they're already on Paid, or if this run already exhausted Paid and
//     soft-flipped to the Free fallback — both cases would be no-ops).
//
// Buttons are conditionally disabled based on context:
//  - Slow down is grey for daily_quota (waiting won't help — daily bucket
//    is empty).
//  - Switch to paid key is grey when:
//      (a) no paid key is configured, OR
//      (b) activeTier is already 'paid' (the user clicked "switch to paid"
//          but it would dispatch to the same singleton they're already on),
//      OR
//      (c) permanentlyOnFallback is true (the auto-tier already exhausted
//          Paid in this run; swapping back is a no-op until a refresh).

import {
  AlertTriangle,
  Download,
  PauseCircle,
  Timer,
  Wallet,
  XOctagon,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

export type RateLimitChoice =
  | { kind: 'stop' }
  | { kind: 'slowdown'; multiplier: number }
  | { kind: 'pause' }
  | { kind: 'fallback' }

export type QuotaKind = 'rate_limit' | 'daily_quota'

type Props = {
  open: boolean
  quotaKind: QuotaKind
  /** Whether a paid Gemini key is configured. Disables the fallback option when false. */
  paidKeyAvailable: boolean
  /** Phase context for the dialog header (e.g. "Phase 3 — chunk 12/30"). Optional. */
  phaseLabel?: string
  /** Which provider singleton emitted the event. Today only Gemini opens
   *  this dialog (Claude/OpenAI's auto-pacing keeps them under their caps),
   *  but the props are provider-agnostic for forward-compatibility. */
  provider: 'gemini' | 'claude' | 'openai' | 'local' | 'claudeCode' | 'codex'
  /** Which tier was active when the dispatching chunk fired. Drives the
   *  verbose title ("Gemini Paid — ...") + the Switch-to-paid disable logic. */
  activeTier: 'free' | 'paid' | 'auto'
  /** Model id at exhaustion time, e.g. "gemini-2.5-pro". */
  model?: string
  /** 6-char SHA-256 prefix of the active key. Matches the Settings → API
   *  Keys → Probe row so the user can cross-reference. */
  keyFingerprint?: string
  /** Approximate count of requests the active singleton has dispatched in
   *  the last 60 seconds. Used in the verbose description to give the user
   *  a number rather than just "rate limit hit". */
  requestsInLastMinute?: number
  /** Published per-minute request cap for (activeTier, model). */
  rpmCap?: number
  /** Published per-minute input-token cap for (activeTier, model). */
  tpmCap?: number
  /** True when the run's auto-tier singleton has already exhausted its Paid
   *  key and soft-flipped to Free. The "Switch to paid" button is disabled
   *  in this case (Paid is already exhausted; the user must add credits to
   *  their billing project and start a fresh run to retry on Paid). */
  permanentlyOnFallback: boolean
  onChoose: (choice: RateLimitChoice) => void
  /** Fires when the user dismisses the dialog (X / Esc / overlay). We treat
   *  dismiss as "stop" — the safer option, since the chunk loop is paused
   *  and silently resuming could thrash the limit again. */
  onClose: () => void
}

const SLOWDOWN_MULTIPLIER = 3

/** Human label for a (provider, tier) pair. Goes in the dialog title. */
function tierLabel(provider: Props['provider'], activeTier: Props['activeTier']): string {
  if (provider !== 'gemini') {
    // Claude / OpenAI don't have tiers as such — keep the title generic.
    return provider.charAt(0).toUpperCase() + provider.slice(1)
  }
  if (activeTier === 'paid') return 'Gemini Paid'
  if (activeTier === 'free') return 'Gemini Free'
  return 'Gemini (auto)'
}

function titleFor(props: Props): string {
  const who = tierLabel(props.provider, props.activeTier)
  return props.quotaKind === 'daily_quota'
    ? `${who} — daily quota exhausted`
    : `${who} — per-minute rate limit hit`
}

/** Build the verbose description. Falls back to the generic copy when the
 *  caller didn't populate the optional fields (older provider events). */
function descriptionFor(props: Props): string {
  const parts: string[] = []
  const who = tierLabel(props.provider, props.activeTier)
  const modelStr = props.model ? `\`${props.model}\`` : 'this model'

  if (props.quotaKind === 'daily_quota') {
    parts.push(
      `The daily quota for ${modelStr} on the ${who} key looks exhausted. ` +
        `Free-tier keys reset around midnight UTC; paid-tier daily caps reset on the project's billing cycle. ` +
        `Pause now and resume tomorrow exactly where you left off, or stop and export the in-progress output.`,
    )
  } else {
    // rate_limit — verbose with numbers when available.
    if (props.rpmCap && props.requestsInLastMinute !== undefined) {
      parts.push(
        `${modelStr} on the ${who} key has a published cap of ${props.rpmCap} requests per minute. ` +
          `This run has dispatched ${props.requestsInLastMinute} request${props.requestsInLastMinute === 1 ? '' : 's'} ` +
          `in the last 60 seconds. Slowing down 3× will space the next chunks by ` +
          `${Math.ceil((60_000 / props.rpmCap) * 3 / 1000)}s, well under the cap.`,
      )
    } else {
      parts.push(
        `${modelStr} on the ${who} key hit its per-minute rate limit. ` +
          `Slow down 3× will pace subsequent chunks more conservatively.`,
      )
    }
  }

  if (props.keyFingerprint) {
    parts.push(
      `Key fingerprint: \`${props.keyFingerprint}\` (matches the row in Settings → API Keys → Probe).`,
    )
  }

  return parts.join('\n\n')
}

/** Why is the Switch-to-paid button disabled? Returns null when it's enabled
 *  (i.e. the click would do something useful). */
function fallbackDisabledReason(props: Props): string | null {
  if (!props.paidKeyAvailable) {
    return 'No paid Gemini key is configured. Add one in Settings → API Keys (Paid tier slot).'
  }
  if (props.activeTier === 'paid') {
    return "You're already on the Paid key. Slow Down 3× is the right action for paid-tier rate limits."
  }
  if (props.permanentlyOnFallback) {
    return 'This run already swapped to the Free key after a paid-key quota error. ' +
      'Add credits to your billing project and start a fresh run to retry on Paid.'
  }
  return null
}

export function RateLimitDialog(props: Props) {
  const {
    open,
    quotaKind,
    phaseLabel,
    onChoose,
    onClose,
  } = props
  const slowdownDisabled = quotaKind === 'daily_quota'
  const fallbackDisabled = fallbackDisabledReason(props)
  const description = descriptionFor(props)

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            {titleFor(props)}
          </DialogTitle>
          <DialogDescription className="whitespace-pre-line">
            {phaseLabel ? <span className="block text-xs text-muted-foreground">{phaseLabel}</span> : null}
            {description}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Button
            variant="outline"
            className="h-auto w-full justify-start gap-3 py-3 text-left"
            onClick={() => onChoose({ kind: 'stop' })}
          >
            <XOctagon className="h-5 w-5 shrink-0 text-destructive" />
            <span className="flex flex-col items-start">
              <span className="font-medium">Stop and export what we have</span>
              <span className="text-xs font-normal text-muted-foreground">
                Aborts the run; you can download the partial chronicle from the export button.
              </span>
            </span>
          </Button>

          <Button
            variant="outline"
            className="h-auto w-full justify-start gap-3 py-3 text-left"
            disabled={slowdownDisabled}
            onClick={() => onChoose({ kind: 'slowdown', multiplier: SLOWDOWN_MULTIPLIER })}
            title={slowdownDisabled ? 'Slowing down does not help when the daily quota is empty.' : undefined}
          >
            <Timer className="h-5 w-5 shrink-0 text-blue-500" />
            <span className="flex flex-col items-start">
              <span className="font-medium">Slow down ({SLOWDOWN_MULTIPLIER}× longer between calls)</span>
              <span className="text-xs font-normal text-muted-foreground">
                {slowdownDisabled
                  ? 'Disabled: daily quota is empty, waiting longer between calls will not help.'
                  : `Keeps the same key but paces ${SLOWDOWN_MULTIPLIER}× more conservatively for the rest of the run.`}
              </span>
            </span>
          </Button>

          <Button
            variant="outline"
            className="h-auto w-full justify-start gap-3 py-3 text-left"
            onClick={() => onChoose({ kind: 'pause' })}
          >
            <PauseCircle className="h-5 w-5 shrink-0 text-violet-500" />
            <span className="flex flex-col items-start">
              <span className="font-medium">Pause and save for later</span>
              <span className="text-xs font-normal text-muted-foreground">
                Saves the full pipeline state to disk. Resume from the Chronicle tab when the quota
                resets — picks up at the exact chunk we stopped on.
              </span>
            </span>
          </Button>

          <Button
            variant="outline"
            className="h-auto w-full justify-start gap-3 py-3 text-left"
            disabled={fallbackDisabled !== null}
            onClick={() => onChoose({ kind: 'fallback' })}
            title={fallbackDisabled ?? undefined}
          >
            <Wallet className="h-5 w-5 shrink-0 text-emerald-500" />
            <span className="flex flex-col items-start">
              <span className="font-medium">Switch to paid key for the rest</span>
              <span className="text-xs font-normal text-muted-foreground">
                {fallbackDisabled
                  ? `Disabled: ${fallbackDisabled}`
                  : 'Continues the run using the paid Gemini key. The free key stays available for future runs.'}
              </span>
            </span>
          </Button>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            <Download className="mr-2 h-4 w-4" />
            Close (also stops the run)
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
