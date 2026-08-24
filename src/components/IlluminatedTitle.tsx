import { motion } from 'motion/react'

// Ported from Tusk's Vault — per-character write-in animation for display
// titles. Each letter fades up + scales in with a small stagger so the title
// looks like it's being inscribed onto the page. The actual gradient and
// pulse come from the `.brand-title` class in index.css (amethyst → moonsilver
// gradient + 4s brand-pulse aura) so this component is purely the entrance.
//
// History note from Vault: an earlier version animated `filter: blur(8px)
// -> blur(0px)` per character. Even though blur(0px) is technically a no-op,
// leaving filter declarations on every span kept the filter rendering
// pipeline active and made the title look fuzzy in some browsers. We now
// animate opacity + transform only; the gradient stays crisp throughout.

interface IlluminatedTitleProps {
  text: string
  className?: string
  /** Tailwind classes applied to the heading. Defaults to `.brand-title`,
   *  which uses Cinzel + amethyst gradient + brand-pulse. */
  variant?: string
}

export function IlluminatedTitle({
  text,
  className = '',
  variant = 'brand-title',
}: IlluminatedTitleProps) {
  const chars = Array.from(text)
  return (
    <h1
      className={`${variant} flex flex-wrap ${className}`}
      aria-label={text}
    >
      {chars.map((ch, i) => (
        <motion.span
          key={i}
          initial={{ opacity: 0, y: 14, scale: 0.78 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{
            delay: 0.1 + i * 0.05,
            duration: 0.55,
            ease: [0.22, 1, 0.36, 1],
          }}
          aria-hidden="true"
          style={{
            whiteSpace: ch === ' ' ? 'pre' : undefined,
            display: 'inline-block',
          }}
        >
          {ch}
        </motion.span>
      ))}
    </h1>
  )
}
