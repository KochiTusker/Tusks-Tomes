import { motion, AnimatePresence } from 'motion/react'

// Ported from Tusk's Vault — eight sparkles bursting outward in a star
// pattern. Triggered by an `active` flag from the parent (e.g. a one-shot
// state set true on first mount, or set true on a save-success event).
// Auto-clears via AnimatePresence when `active` flips back to false.
//
// Colour: amethyst (text-[var(--color-arcane)]) so it reads as a "spell
// shimmer" and pairs with the brand-pulse aura on the wordmark.

interface SparkleBurstProps {
  active: boolean
}

const POSITIONS = [
  { dx: 60, dy: 0, scale: 1.1, delay: 0.0, size: 18 },
  { dx: 42, dy: 42, scale: 0.9, delay: 0.04, size: 14 },
  { dx: 0, dy: 60, scale: 1.0, delay: 0.08, size: 16 },
  { dx: -42, dy: 42, scale: 0.85, delay: 0.04, size: 12 },
  { dx: -60, dy: 0, scale: 1.0, delay: 0.0, size: 16 },
  { dx: -42, dy: -42, scale: 0.9, delay: 0.04, size: 14 },
  { dx: 0, dy: -60, scale: 1.1, delay: 0.08, size: 18 },
  { dx: 42, dy: -42, scale: 0.95, delay: 0.04, size: 14 },
]

function Sparkle({ size }: { size: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      style={{ filter: 'drop-shadow(0 0 6px oklch(0.78 0.22 295 / 0.7))' }}
    >
      <path
        d="M 12 0 L 13.5 9 L 24 12 L 13.5 15 L 12 24 L 10.5 15 L 0 12 L 10.5 9 Z"
        fill="currentColor"
      />
    </svg>
  )
}

export function SparkleBurst({ active }: SparkleBurstProps) {
  return (
    <AnimatePresence>
      {active && (
        <div
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center text-[var(--color-arcane)]"
          aria-hidden="true"
        >
          {POSITIONS.map((p, i) => (
            <motion.div
              key={i}
              initial={{ x: 0, y: 0, opacity: 0, scale: 0 }}
              animate={{
                x: p.dx,
                y: p.dy,
                opacity: [0, 1, 1, 0],
                scale: [0, p.scale, p.scale, 0],
                rotate: [0, 180],
              }}
              exit={{ opacity: 0 }}
              transition={{
                duration: 0.9,
                delay: p.delay,
                ease: 'easeOut',
              }}
              className="absolute"
            >
              <Sparkle size={p.size} />
            </motion.div>
          ))}
        </div>
      )}
    </AnimatePresence>
  )
}
