// Ported from Tusk's Vault — decorative section divider: a thin amethyst
// gradient line with a centered four-pointed star ornament. Used between
// major page sections in place of plain borders.

interface RuneDividerProps {
  className?: string
}

export function RuneDivider({ className = '' }: RuneDividerProps) {
  return (
    <div
      className={`flex items-center gap-4 my-8 ${className}`}
      aria-hidden="true"
    >
      <div className="flex-1 h-px rune-divider" />
      <svg
        width="20"
        height="20"
        viewBox="0 0 20 20"
        className="text-[var(--color-arcane)] opacity-70"
      >
        <path
          d="M10 1 L11.5 8.5 L19 10 L11.5 11.5 L10 19 L8.5 11.5 L1 10 L8.5 8.5 Z"
          fill="currentColor"
        />
      </svg>
      <div className="flex-1 h-px rune-divider" />
    </div>
  )
}
