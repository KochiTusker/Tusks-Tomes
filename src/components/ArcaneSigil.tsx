// Single arcane glyph that fades into a corner of the viewport, lingers
// briefly, then fades back out — once every ~28s per instance. Mount two
// (top-left + bottom-right) for a corner-to-corner rhythm that reads as a
// magical *event* rather than wallpaper. The animation and corner anchor
// live in index.css (.arcane-sigil and the corner modifier classes); this
// component is pure SVG.

interface ArcaneSigilProps {
  /** Which corner to anchor to. `tl` uses the amethyst tint; `br` uses
   *  the ember tint and starts mid-cycle so the two sigils don't bloom
   *  in unison. */
  corner: 'tl' | 'br'
}

export function ArcaneSigil({ corner }: ArcaneSigilProps) {
  return (
    <svg
      className={`arcane-sigil arcane-sigil--${corner}`}
      viewBox="0 0 200 200"
      fill="none"
      stroke="currentColor"
      strokeWidth={0.8}
      aria-hidden
    >
      {/* Outer + inner rings */}
      <circle cx="100" cy="100" r="92" strokeOpacity="0.5" />
      <circle cx="100" cy="100" r="78" strokeOpacity="0.7" strokeDasharray="3 5" />
      <circle cx="100" cy="100" r="46" strokeOpacity="0.55" />

      {/* Hexagram — two overlaid triangles */}
      <path
        d="M100 22 L165 138 L35 138 Z"
        strokeOpacity="0.65"
        strokeLinejoin="round"
      />
      <path
        d="M100 178 L165 62 L35 62 Z"
        strokeOpacity="0.65"
        strokeLinejoin="round"
      />

      {/* Cardinal accent marks just inside the outer ring */}
      <line x1="100" y1="6"   x2="100" y2="18"  strokeOpacity="0.8" strokeWidth={1.2} />
      <line x1="100" y1="182" x2="100" y2="194" strokeOpacity="0.8" strokeWidth={1.2} />
      <line x1="6"   y1="100" x2="18"  y2="100" strokeOpacity="0.8" strokeWidth={1.2} />
      <line x1="182" y1="100" x2="194" y2="100" strokeOpacity="0.8" strokeWidth={1.2} />

      {/* Eight rune ticks at the 22.5° offsets between cardinals */}
      {Array.from({ length: 8 }).map((_, i) => {
        const a = (i * Math.PI * 2) / 8 - Math.PI / 2 + Math.PI / 8
        const x1 = 100 + Math.cos(a) * 86
        const y1 = 100 + Math.sin(a) * 86
        const x2 = 100 + Math.cos(a) * 92
        const y2 = 100 + Math.sin(a) * 92
        return (
          <line
            key={i}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            strokeOpacity="0.6"
            strokeWidth={0.7}
          />
        )
      })}

      {/* Centre dot — small glowing core */}
      <circle cx="100" cy="100" r="3" fill="currentColor" fillOpacity="0.8" strokeWidth={0} />
    </svg>
  )
}
