// Arcane rune divider — a centered SVG glyph flanked by violet trace
// lines. Drop between major sections where you want a visible break
// with theme flavor:
//
//   <ArcaneRune />
//   <ArcaneRune glyph="sigil" />
//   <ArcaneRune glyph="star" className="my-8" />
//
// The .arcane-rune-divider class in index.css handles the flanking
// lines + drop-shadow glow on the SVG.

type Glyph = 'eye' | 'sigil' | 'star'

export function ArcaneRune({
  glyph = 'eye',
  className = '',
}: {
  glyph?: Glyph
  className?: string
}) {
  return (
    <div
      className={`arcane-rune-divider ${className}`}
      role="presentation"
      aria-hidden
    >
      <RuneSvg glyph={glyph} />
    </div>
  )
}

function RuneSvg({ glyph }: { glyph: Glyph }) {
  const common = {
    width: 28,
    height: 28,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  }

  if (glyph === 'sigil') {
    // Triangle within a circle with a vertical stroke — a generic
    // alchemical mark
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 4 L20 19 L4 19 Z" />
        <line x1="12" y1="2" x2="12" y2="22" strokeOpacity="0.6" />
      </svg>
    )
  }

  if (glyph === 'star') {
    // Six-pointed star within a circle — astrolabe glyph
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 3 L17 12 L12 21 L7 12 Z" />
        <path d="M3 12 L21 12" strokeOpacity="0.55" />
      </svg>
    )
  }

  // glyph === 'eye' — default: stylised eye-of-providence inside a
  // diamond, our most "tomes-y" rune
  return (
    <svg {...common}>
      <path d="M12 3 L21 12 L12 21 L3 12 Z" />
      <ellipse cx="12" cy="12" rx="5.5" ry="3.2" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" />
    </svg>
  )
}
