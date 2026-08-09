import { useEffect, useState } from 'react'
import { useLocalStorage } from '@/hooks/useLocalStorage'
import { LS_CAMPAIGN, LS_SESSION } from '@/lib/constants'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ArcaneCircle } from './ArcaneCircle'
import { ProviderModelsLink } from './ProviderModelsLink'
import { TuskLogo } from './TuskLogo'
import { IlluminatedTitle } from './IlluminatedTitle'
import { SparkleBurst } from './SparkleBurst'

interface HeaderProps {
  /** Fired on every click of the coat-of-arms logo. App-level code uses
   *  this for the 5-tap dev-mode unlock that reveals the Updater card's
   *  remote-toggle. Omit when no app-wide handling is wanted — the click
   *  is then a no-op (no cursor-pointer hint either). */
  onSecretTap?: () => void
}

export function Header({ onSecretTap }: HeaderProps = {}) {
  const [campaign, setCampaign] = useLocalStorage<string>(LS_CAMPAIGN, '')
  const [sessionNumber, setSessionNumber] = useLocalStorage<number>(LS_SESSION, 1)

  // One-shot sparkle burst around the sigil on mount. Pairs with
  // IlluminatedTitle's per-character entrance so the brand reveal feels
  // like a small spell being cast. Burst lasts ~1.2s then clears itself.
  const [sigilSparkle, setSigilSparkle] = useState(false)
  useEffect(() => {
    const enterTimer = window.setTimeout(() => setSigilSparkle(true), 350)
    const exitTimer = window.setTimeout(() => setSigilSparkle(false), 1500)
    return () => {
      window.clearTimeout(enterTimer)
      window.clearTimeout(exitTimer)
    }
  }, [])

  // Coat-of-arms image at /logo.png is the primary mark. If the user
  // hasn't dropped their PNG yet (or it 404s), fall back to the original
  // TuskLogo SVG mark so the header doesn't show a broken-image icon.
  const [logoFailed, setLogoFailed] = useState(false)

  return (
    <header className="relative border-b border-border/60">
      {/* Subtle brass underline — drifting shimmer instead of a static seam. */}
      <div className="ornament-shimmer pointer-events-none absolute inset-x-0 bottom-0 h-px" />
      <div className="mx-auto flex max-w-6xl flex-col gap-5 px-6 py-7 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex items-center gap-4">
          {/* The coat-of-arms has its own organic silhouette (shield +
              supporters + ribbon) and a transparent background, so we
              strip the old card-style circular frame entirely — bg / border
              / shadow were boxing the heraldry into a square inside a
              circle. ArcaneCircle still rotates behind it as a subtle
              magical aura, and SparkleBurst fires once on mount. */}
          <div
            className={`relative flex h-20 w-20 shrink-0 items-center justify-center drop-shadow-[0_0_18px_oklch(0.65_0.22_295/0.35)] ${
              onSecretTap ? 'cursor-pointer select-none' : ''
            }`}
            onClick={onSecretTap}
          >
            <ArcaneCircle />
            {logoFailed ? (
              <TuskLogo className="relative z-10 h-10 w-10 text-[var(--color-arcane)]" />
            ) : (
              <img
                src="/logo.png"
                alt="Tusk's Tomes coat of arms"
                className="relative z-10 h-20 w-20 object-contain"
                onError={() => setLogoFailed(true)}
              />
            )}
            <SparkleBurst active={sigilSparkle} />
          </div>
          <div className="space-y-1">
            <IlluminatedTitle
              text="Tusk's Tomes"
              className="text-2xl sm:text-3xl"
            />
            <p className="brand-subtitle text-sm">
              A chronicler of voyages, deeds, and the things that whisper below.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="campaign" className="text-xs uppercase tracking-wider text-muted-foreground">
              Campaign
            </Label>
            <Input
              id="campaign"
              placeholder="e.g. The Underdark Crusade"
              value={campaign}
              onChange={(e) => setCampaign(e.target.value)}
              className="w-64"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="session" className="text-xs uppercase tracking-wider text-muted-foreground">
              Session №
            </Label>
            <Input
              id="session"
              type="number"
              min={1}
              value={sessionNumber}
              onChange={(e) =>
                setSessionNumber(Math.max(1, Number(e.target.value) || 1))
              }
              className="w-24"
            />
          </div>
          <div className="flex items-end gap-2 self-end">
            <ProviderModelsLink />
          </div>
        </div>
      </div>
    </header>
  )
}
