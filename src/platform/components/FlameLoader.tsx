// Ported from Tusk's Vault — a flickering candle-flame replacement for
// the generic Loader2 spinner. SVG so it scales and tints cleanly; the
// flicker + glow animation lives in index.css under .candle-flame.

interface FlameLoaderProps {
  size?: number
  className?: string
}

export function FlameLoader({ size = 18, className = '' }: FlameLoaderProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={`candle-flame ${className}`}
      aria-label="Loading"
      role="status"
    >
      <defs>
        <radialGradient id="flame-grad" cx="50%" cy="60%" r="55%">
          <stop offset="0%" stopColor="#FFF6C2" />
          <stop offset="40%" stopColor="#FFD587" />
          <stop offset="75%" stopColor="#FFB350" />
          <stop offset="100%" stopColor="#B85700" />
        </radialGradient>
      </defs>
      <path
        d="M12 2.5
           C 14 6 17 8.5 17 13
           C 17 17 14.5 19.5 12 19.5
           C 9.5 19.5 7 17 7 13
           C 7 8.5 10 6 12 2.5 Z"
        fill="url(#flame-grad)"
      />
      <path
        d="M12 7
           C 13 9.5 14.5 10.5 14.5 13.5
           C 14.5 16 13.2 17.5 12 17.5
           C 10.8 17.5 9.5 16 9.5 13.5
           C 9.5 10.5 11 9.5 12 7 Z"
        fill="rgba(255, 246, 194, 0.7)"
      />
    </svg>
  )
}
