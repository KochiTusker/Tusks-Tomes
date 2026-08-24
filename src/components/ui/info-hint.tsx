// InfoHint — the "tell me more" affordance used to keep Settings tidy.
//
// Why click-to-open rather than a hover tooltip: the content this app needs
// to explain is long (measured trade-offs, cost caveats, provider quirks).
// Hover tooltips are the wrong container for a paragraph — they're
// unreachable on touch, vanish when the pointer moves toward them, and
// can't hold a link. This is the pattern GitHub/Stripe settings use for the
// same reason: a small ⓘ button that toggles a panel you can read at your
// own pace.
//
// The rule this component exists to enforce: a card shows ONE line of plain
// language, and everything else — rationale, measurements, caveats — lives
// behind the ⓘ. Nothing is deleted, just folded away until asked for.
//
// Accessibility: real <button> trigger, aria-expanded, labelled panel,
// Escape to close, click-outside to close, focus ring inherited from the
// app's ring token.

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Info } from 'lucide-react'
import { cn } from '@/lib/utils'

type Props = {
  /** Short accessible name, e.g. "About quote reassembly". Screen readers
   *  announce this on the trigger; sighted users see only the icon. */
  label: string
  children: ReactNode
  /** Which side of the trigger the panel opens toward. Use 'left' when the
   *  trigger sits near the right edge so the panel doesn't overflow. */
  align?: 'left' | 'right'
  className?: string
}

export function InfoHint({ label, children, align = 'right', className }: Props) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLSpanElement>(null)
  const panelId = useId()

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    function onPointerDown(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onPointerDown)
    }
  }, [open])

  return (
    <span ref={wrapRef} className={cn('relative inline-flex align-middle', className)}>
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full',
          'text-muted-foreground/70 transition-colors hover:text-arcane',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          open && 'text-arcane',
        )}
      >
        <Info className="h-3.5 w-3.5" />
      </button>
      {open && (
        <span
          id={panelId}
          role="note"
          className={cn(
            'absolute top-6 z-50 w-80 rounded-md border border-border bg-popover p-3',
            'text-left text-xs font-normal leading-relaxed text-muted-foreground shadow-lg',
            'normal-case tracking-normal',
            align === 'right' ? 'left-0' : 'right-0',
          )}
        >
          {children}
        </span>
      )}
    </span>
  )
}
