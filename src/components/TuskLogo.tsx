// "Tusk's Tomes" mark: a stylised grim reaper, cowl + scythe, cradling an
// open tome. Rendered as pure strokes so it picks up `currentColor` from
// whatever it's nested in — the Header tints it gold via the parent's
// text colour, but it works equally well in muted, accent, or destructive
// contexts.

import type { SVGProps } from 'react'

export function TuskLogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      {/* Scythe shaft — diagonal across the figure */}
      <path d="M3.5 21.5 L 19 5.5" />
      {/* Scythe blade — curving sweep from the shaft tip */}
      <path d="M19 5.5 C 16.5 4.5, 14.2 5.4, 13.2 8" />

      {/* Hood: peaked arch over the head */}
      <path d="M8 6 C 8 3.8, 9.8 2.5, 12 2.5 C 14.2 2.5, 16 3.8, 16 6 L 16 9.5 L 8 9.5 Z" />
      {/* Hood opening — the void where a face would be */}
      <path d="M9.8 6.8 Q 12 8.4, 14.2 6.8" />

      {/* Cloak / robe — sweeping shoulders that flare to the hem */}
      <path d="M8 9.5 L 6 19.5 M 16 9.5 L 18 19.5" />
      <path d="M6 19.5 Q 12 21, 18 19.5" />

      {/* Open tome cradled at chest height */}
      <path d="M8.5 13.5 L 12 12.5 L 15.5 13.5 L 15.5 17 L 12 16 L 8.5 17 Z" />
      {/* Tome spine */}
      <line x1="12" y1="12.5" x2="12" y2="16" />
    </svg>
  )
}
