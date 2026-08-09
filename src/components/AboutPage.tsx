// About page — mirrors the sister project's About layout: animated
// header, a lean bullet list of convictions, a two-sentence creator
// blurb, three source/license/version chips, and a quiet BMAC footer.
// Adapted to Tomes' arcane palette and the chronicling framing.
//
// Branding stays name-free per the project's privacy stance — the
// maintainer is identified by the KochiTusker handle only; there is
// no email channel.

import { motion } from 'motion/react'
import { Coffee, ExternalLink, Heart } from 'lucide-react'
import { RuneDivider } from './RuneDivider'
import { BMAC_URL } from './BuyMeACoffeeButton'

const CONVICTIONS: Array<{ title: string; body: string }> = [
  {
    title: 'Local-first, not SaaS',
    body: 'Your transcripts, your keys, your hardware. Audio never leaves the machine; only the text you choose reaches the LLM provider. No account, no telemetry, no rug-pull risk.',
  },
  {
    title: 'AI as scribe, not storyteller',
    body: 'Tusk’s Tomes grounds speakers and lore, writes the chronicle, and surfaces clarifying questions for the DM. It does not invent your session. The story stays yours.',
  },
  {
    title: 'Tools for tables, MIT-licensed',
    body: 'Built for kitchen-table games and small Discord servers. Fork it, modify it, redistribute it — it’s yours, forever free.',
  },
]

export function AboutPage() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
    >
      <header className="mb-8 flex flex-wrap items-start gap-6">
        <motion.div
          initial={{ opacity: 0, scale: 0.6, rotate: -8 }}
          animate={{ opacity: 1, scale: 1, rotate: 0 }}
          transition={{ delay: 0.1, type: 'spring', stiffness: 180, damping: 16 }}
          className="flex-shrink-0"
        >
          <img
            src="/logo.png"
            alt="Tusk's Tomes coat of arms"
            width={96}
            height={96}
            className="h-24 w-24 object-contain drop-shadow-[0_4px_18px_oklch(0.65_0.22_295/0.4)]"
          />
        </motion.div>
        <div className="min-w-0 flex-1">
          <h2 className="mb-1 font-display text-4xl font-bold tracking-wide text-[var(--color-arcane)]">
            About Tusk's Tomes
          </h2>
          <p className="italic text-muted-foreground">
            A chronicler of voyages, deeds, and the things that whisper below
            — built by a Dungeon Master, for Dungeon Masters and players.
          </p>
        </div>
      </header>

      <RuneDivider />

      <section className="mb-10">
        <h3 className="mb-3 font-display text-2xl text-[var(--color-arcane)]/90">
          Why this exists
        </h3>
        <ul className="space-y-2">
          {CONVICTIONS.map((c, i) => (
            <motion.li
              key={c.title}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.1 + i * 0.07, duration: 0.4 }}
              className="flex gap-3 leading-relaxed text-foreground/85"
            >
              <span className="flex-shrink-0 text-[var(--color-arcane)]/70">·</span>
              <span>
                <strong className="text-[var(--color-arcane)]">{c.title}.</strong>{' '}
                {c.body}
              </span>
            </motion.li>
          ))}
        </ul>
      </section>

      <RuneDivider />

      <section className="mb-10">
        <h3 className="mb-3 font-display text-2xl text-[var(--color-arcane)]/90">
          The creator
        </h3>
        <p className="leading-relaxed text-foreground/85">
          Tusk's Tomes is built by{' '}
          <a
            href="https://github.com/KochiTusker"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--color-arcane)] underline"
          >
            @KochiTusker
          </a>{' '}
          — a Dungeon Master who got tired of losing an hour after every
          session rewriting the recap.
        </p>
        <p className="mt-3 italic text-muted-foreground">
          Contributions, bug reports, and feedback welcome at{' '}
          <a
            href="https://github.com/KochiTusker/Tusks-Tomes"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--color-arcane)] underline"
          >
            github.com/KochiTusker/Tusks-Tomes
          </a>
          .
        </p>
      </section>

      <section className="mb-12 grid grid-cols-1 gap-4 md:grid-cols-3">
        <a
          href="https://github.com/KochiTusker/Tusks-Tomes"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card/40 p-4 transition-colors hover:border-[var(--color-arcane)]/60 hover:bg-card/60"
        >
          <div>
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
              Source
            </p>
            <p className="text-sm text-[var(--color-arcane)]">
              GitHub repository
            </p>
          </div>
          <ExternalLink size={16} className="text-muted-foreground" />
        </a>
        <a
          href="https://opensource.org/license/mit/"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card/40 p-4 transition-colors hover:border-[var(--color-arcane)]/60 hover:bg-card/60"
        >
          <div>
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
              License
            </p>
            <p className="text-sm text-[var(--color-arcane)]">
              MIT — fully open source
            </p>
          </div>
          <ExternalLink size={16} className="text-muted-foreground" />
        </a>
        <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card/40 p-4">
          <div>
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
              Version
            </p>
            <p className="text-sm text-[var(--color-arcane)]">
              0.1.0 — early access
            </p>
          </div>
        </div>
      </section>

      <motion.footer
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.7, duration: 0.5 }}
        className="border-t border-[var(--color-arcane)]/15 pt-8 text-center"
      >
        <p className="mb-4 flex items-center justify-center gap-2 text-sm italic text-muted-foreground">
          <Heart size={14} className="text-[var(--color-ember)]" />
          If Tusk's Tomes saves your session night, you can buy me a coffee.
          <Heart size={14} className="text-[var(--color-ember)]" />
        </p>
        <a
          href={BMAC_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-lg bg-[#FFDD00]/85 px-5 py-2.5 text-sm font-bold text-black transition-all hover:scale-[1.03] hover:bg-[#FFDD00]"
        >
          <Coffee size={16} />
          Buy me a coffee
        </a>
        <p className="mt-3 text-[11px] text-muted-foreground">
          Tusk's Tomes is MIT-licensed and free to use forever. Donations
          are entirely optional.
        </p>
      </motion.footer>
    </motion.div>
  )
}
