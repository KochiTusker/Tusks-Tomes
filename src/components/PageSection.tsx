// Collapsible section grouping for the Settings tab.
//
// Settings was 28 top-level cards in one flat 6.5-screen scroll with no
// landmarks — you scrolled past everything to reach anything. This wraps
// related cards into named, collapsible groups and gives the page a sticky
// rail so the whole surface is reachable in one click.
//
// Open/closed state persists per section, because Settings is a place you
// return to for one specific thing: whatever you collapsed last time should
// stay collapsed. `defaultOpen` only decides the FIRST visit.
//
// Uses native <details>/<summary> rather than a JS disclosure: keyboard and
// screen-reader behaviour comes free, it survives being rendered inside a
// hidden tab panel, and browser find-in-page can still reach collapsed
// content in engines that support it.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { safeGet, safeSet } from '@/lib/storage'
import { cn } from '@/lib/utils'

const LS_PREFIX = 'page_section_open:'

export type PageSectionDef = {
  id: string
  title: string
  /** One line describing what lives in here, shown under the title. */
  blurb: string
  icon: ReactNode
  defaultOpen?: boolean
}

type Props = PageSectionDef & {
  children: ReactNode
  /** Count of cards inside, shown as a chip when collapsed so the section
   *  doesn't read as empty. */
  itemCount?: number
  /** Short live state shown in the summary whether open or closed — e.g.
   *  which lore source is active. A collapsed section that still tells you
   *  its state is worth far more than one you must open to check. */
  status?: ReactNode
  /** Lighter styling for a section nested inside another. */
  nested?: boolean
}

export function PageSection({
  id,
  title,
  blurb,
  icon,
  defaultOpen = false,
  itemCount,
  status,
  nested,
  children,
}: Props) {
  const [open, setOpen] = useState<boolean>(() => safeGet(LS_PREFIX + id, defaultOpen))
  const ref = useRef<HTMLDetailsElement>(null)

  // Respond to the rail asking us to open (it dispatches before scrolling,
  // so the target has height by the time the scroll lands).
  useEffect(() => {
    function onOpenRequest(e: Event) {
      const detail = (e as CustomEvent<{ id?: string }>).detail
      if (detail?.id !== id) return
      setOpen(true)
      safeSet(LS_PREFIX + id, true)
      requestAnimationFrame(() => ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    }
    window.addEventListener(PAGE_SECTION_OPEN_EVENT, onOpenRequest)
    return () => window.removeEventListener(PAGE_SECTION_OPEN_EVENT, onOpenRequest)
  }, [id])

  return (
    <details
      ref={ref}
      id={`page-section-${id}`}
      open={open}
      onToggle={(e) => {
        const next = (e.currentTarget as HTMLDetailsElement).open
        setOpen(next)
        safeSet(LS_PREFIX + id, next)
      }}
      className={cn(
        'scroll-mt-4 rounded-lg border',
        nested ? 'border-border/50 bg-background/40' : 'border-border/70 bg-card/30',
      )}
    >
      <summary
        className={cn(
          'flex cursor-pointer list-none items-center gap-3 rounded-lg px-4 py-3',
          'transition-colors hover:bg-muted/30',
          '[&::-webkit-details-marker]:hidden',
        )}
      >
        <ChevronRight
          className={cn(
            'h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200',
            open && 'rotate-90',
          )}
        />
        <span className="text-muted-foreground">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block font-display text-sm uppercase tracking-wider">
          {title}
          {status && (
            <span className="ml-2 rounded-full bg-arcane/15 px-2 py-0.5 align-middle text-[11px] font-medium normal-case tracking-normal text-arcane">
              {status}
            </span>
          )}
        </span>
          <span className="block text-xs font-normal normal-case text-muted-foreground">
            {blurb}
          </span>
        </span>
        {!open && itemCount !== undefined && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            {itemCount}
          </span>
        )}
      </summary>
      <div className="space-y-4 border-t border-border/50 p-4">{children}</div>
    </details>
  )
}

export const PAGE_SECTION_OPEN_EVENT = 'sbts:open-page-section'

/** Ask a section to expand and scroll into view. Used by the rail. */
export function openPageSection(id: string) {
  window.dispatchEvent(new CustomEvent(PAGE_SECTION_OPEN_EVENT, { detail: { id } }))
}

/** Sticky in-page rail. Lives in the ~57% of horizontal space the settings
 *  column was leaving empty, so it costs no content width. */
export function PageSectionNav({ sections }: { sections: PageSectionDef[] }) {
  return (
    <nav aria-label="Page sections" className="sticky top-4 hidden w-52 shrink-0 xl:block">
      <p className="mb-2 px-3 font-display text-[11px] uppercase tracking-wider text-muted-foreground">
        Jump to
      </p>
      <ul className="space-y-0.5">
        {sections.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              onClick={() => openPageSection(s.id)}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-xs',
                'text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              )}
            >
              <span className="shrink-0">{s.icon}</span>
              <span className="truncate">{s.title}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
}
