// Condense slider — picks the Phase 6 condense target as a percentage of
// the chronicle's word count. v1.1.0 replaces the static `min(2000, 25%)`
// heuristic with a user-controlled value (0-100%, step 5).
//
// The chronicle hasn't been generated yet when this component renders
// (OutputPicker runs after Phase 2 audit, before Phase 3 chronicle), so
// the preview word count is an estimate based on the grounded transcript
// length. Phase 6 itself recomputes the target at runtime using the
// actual chronicle word count, so the user's percentage choice holds
// regardless of estimate accuracy.

import { Wand2 } from 'lucide-react'
import { computeCondenseTarget } from '@/lib/wordCount'

type Props = {
  /** Current slider value, 0-100 in steps of 5. */
  value: number
  /** Fired when the user moves the slider. */
  onChange: (next: number) => void
  /** Best-available estimate of the chronicle's eventual word count.
   *  Typically wired from the grounded transcript word count — the
   *  chronicle's length tracks that closely on real sessions. */
  estimatedChronicleWords: number
}

const MIN = 0
const MAX = 100
const STEP = 5

export function CondenseSlider({ value, onChange, estimatedChronicleWords }: Props) {
  // Clamp + snap incoming value to a valid step. Defensive — if a stale
  // localStorage value slips through with an odd number, we still render.
  const safeValue = Math.max(MIN, Math.min(MAX, Math.round(value / STEP) * STEP))
  const estimatedWords = computeCondenseTarget(estimatedChronicleWords, safeValue)
  const showHighWarning = safeValue >= 90
  const showZeroNote = safeValue === 0

  return (
    <div className="mt-3 rounded-md border border-purple-500/30 bg-purple-50/40 p-3 dark:bg-purple-950/20">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium">
        <Wand2
          className="h-4 w-4 text-purple-600 dark:text-purple-300"
          style={{
            // Subtle pulse so the wand feels alive without distracting.
            animation: 'condense-wand-pulse 2.4s ease-in-out infinite',
          }}
          aria-hidden="true"
        />
        Condense length
      </div>

      {/* The range input is rendered with a gradient background that
       *  visually fills the track up to the thumb position. The native
       *  thumb is invisible; the wand-icon container above doubles as
       *  the visual marker. Cross-browser uses both ::-webkit-slider-thumb
       *  + ::-moz-range-thumb in a global stylesheet would be cleaner —
       *  for v1.1.0 the gradient + native thumb is simple, accessible,
       *  and keyboard-friendly. */}
      <input
        type="range"
        min={MIN}
        max={MAX}
        step={STEP}
        value={safeValue}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label="Condense percentage"
        aria-valuemin={MIN}
        aria-valuemax={MAX}
        aria-valuenow={safeValue}
        aria-valuetext={`${safeValue}% — about ${estimatedWords} words`}
        className="w-full cursor-pointer accent-purple-600"
        style={{
          // Custom-coloured track gradient that lights up to the thumb.
          background: `linear-gradient(to right, rgb(147 51 234) 0%, rgb(147 51 234) ${safeValue}%, rgb(229 229 229) ${safeValue}%, rgb(229 229 229) 100%)`,
          borderRadius: '999px',
          height: '6px',
          appearance: 'none',
          outline: 'none',
        }}
      />

      <div className="mt-2 flex items-center justify-between text-xs">
        <span className="font-mono text-purple-700 dark:text-purple-300">
          {safeValue}% ≈ {estimatedWords.toLocaleString()} words
        </span>
        <span className="text-muted-foreground">
          (estimated from grounded transcript; actual computed at Phase 6 start)
        </span>
      </div>

      {showZeroNote && (
        <div className="mt-2 rounded border border-amber-500/30 bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/20 dark:text-amber-100">
          0% disables the condense pass entirely — equivalent to unchecking the
          Condensed checkbox above. Phase 6 will not run.
        </div>
      )}

      {showHighWarning && (
        <div className="mt-2 rounded border border-amber-500/30 bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/20 dark:text-amber-100">
          High percentages produce a near-copy of the chronicle. For a tight
          recap suitable for Discord, try 15-30%.
        </div>
      )}

      {/* Pulse keyframes — scoped via a global style block since the
       *  animation property above references the name. Keep this
       *  lightweight; no animation library. */}
      <style>{`
        @keyframes condense-wand-pulse {
          0%, 100% { transform: rotate(-8deg) scale(1); opacity: 0.85; }
          50% { transform: rotate(-2deg) scale(1.08); opacity: 1; }
        }
      `}</style>
    </div>
  )
}

export const CONDENSE_SLIDER_MIN = MIN
export const CONDENSE_SLIDER_MAX = MAX
export const CONDENSE_SLIDER_STEP = STEP
