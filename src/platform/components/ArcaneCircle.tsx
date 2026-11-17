// Slow-rotating arcane circle that wraps the Tusk's Tomes brand logo
// in the Header. Two layered SVGs — an outer ring that rotates CCW and
// an inner ring that counter-rotates CW. Pure SVG (no images), pure
// CSS animations, no JS overhead.
//
// Drop it as a sibling of the logo and absolutely position both inside
// a `relative` container; the .arcane-circle class in index.css sizes
// it to overflow the parent and applies the rotation keyframes.

export function ArcaneCircle() {
  return (
    <>
      {/* Outer ring — pentagram + glyph marks, CCW rotation, amethyst */}
      <svg
        className="arcane-circle"
        viewBox="0 0 200 200"
        fill="none"
        stroke="currentColor"
        strokeWidth={0.6}
        aria-hidden
      >
        <circle cx="100" cy="100" r="92" strokeOpacity="0.45" />
        <circle cx="100" cy="100" r="84" strokeOpacity="0.7" strokeDasharray="2 4" />
        {/* Pentagram */}
        <path
          d="M100 16
             L141 134
             L23  64
             L177 64
             L59  134 Z"
          strokeOpacity="0.55"
          strokeLinejoin="round"
        />
        {/* Twelve runic tick marks around the inner circle */}
        {Array.from({ length: 12 }).map((_, i) => {
          const a = (i * Math.PI * 2) / 12 - Math.PI / 2
          const x1 = 100 + Math.cos(a) * 74
          const y1 = 100 + Math.sin(a) * 74
          const x2 = 100 + Math.cos(a) * 80
          const y2 = 100 + Math.sin(a) * 80
          return (
            <line
              key={i}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              strokeOpacity="0.65"
              strokeWidth={i % 3 === 0 ? 1.2 : 0.7}
            />
          )
        })}
      </svg>

      {/* Inner ring — smaller circle with sigil cross, CW rotation, ember-tinted */}
      <svg
        className="arcane-circle--inner"
        viewBox="0 0 200 200"
        fill="none"
        stroke="currentColor"
        strokeWidth={0.5}
        aria-hidden
      >
        <circle cx="100" cy="100" r="60" strokeOpacity="0.7" strokeDasharray="1 3" />
        <circle cx="100" cy="100" r="48" strokeOpacity="0.5" />
        {/* Cardinal sigil cross */}
        <line x1="100" y1="40" x2="100" y2="56" strokeOpacity="0.6" />
        <line x1="100" y1="144" x2="100" y2="160" strokeOpacity="0.6" />
        <line x1="40" y1="100" x2="56" y2="100" strokeOpacity="0.6" />
        <line x1="144" y1="100" x2="160" y2="100" strokeOpacity="0.6" />
      </svg>
    </>
  )
}
