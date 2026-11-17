import { useMemo, useState } from 'react'
import {
  BookOpen,
  BookText,
  ScrollText,
  Map as MapIcon,
  Sparkles,
  Code2,
  ShieldCheck,
  Coins,
  Compass,
  HelpCircle,
  History,
  Layers,
  Cog,
  Plug,
  Library,
  Mic,
  Cpu,
  GitCompare,
  Search,
} from 'lucide-react'

type DocEntry = {
  slug: string
  title: string
  path: string
}

interface HelpLandingProps {
  docs: DocEntry[]
  onSelect: (slug: string) => void
}

// Map slug (or path prefix) to a Lucide icon + short description + colour
// tone. Falls back to a generic BookText icon for anything not listed.
// Keeping this as a plain table (no per-doc YAML frontmatter scraping)
// because we own both ends and the surface is small enough to enumerate.
type Meta = {
  icon: typeof BookOpen
  blurb: string
  tone: 'gold' | 'arcane' | 'ember' | 'moon'
}

const META: Record<string, Meta> = {
  // Getting started
  'docs-getting-started-requirements': { icon: Plug, blurb: 'What to install first, and what each thing is for.', tone: 'moon' },
  'docs-getting-started-installation': { icon: Compass, blurb: 'Install and first run, start to finish.', tone: 'arcane' },
  'docs-getting-started-quickstart': { icon: Sparkles, blurb: 'Your first chronicle, end to end.', tone: 'gold' },
  'docs-getting-started-without-a-terminal': { icon: HelpCircle, blurb: 'The same setup with no command line at all.', tone: 'gold' },

  // Guides
  'docs-importing': { icon: Compass, blurb: 'Three ways to get a session in — pick one.', tone: 'gold' },
  'docs-importing-a-transcript': { icon: ScrollText, blurb: 'Paste text from anywhere. Nothing to install.', tone: 'gold' },
  'docs-importing-session-audio': { icon: Mic, blurb: 'Craig multitrack and loose audio, transcribed locally.', tone: 'ember' },
  'docs-importing-youtube-captions': { icon: History, blurb: 'Let YouTube do the transcribing. No GPU needed.', tone: 'moon' },
  'docs-chronicling-reforging': { icon: Layers, blurb: 'Redo the later phases on a different model.', tone: 'arcane' },
  'docs-chronicling-recommended-settings': { icon: Cog, blurb: 'Sensible defaults, and when to move off them.', tone: 'arcane' },

  // Models and cost
  'docs-models-choosing-a-provider': { icon: Cpu, blurb: 'Gemini, OpenRouter, a subscription, or fully local.', tone: 'ember' },
  'docs-models-per-phase-routing': { icon: Layers, blurb: 'Which model should run which phase, and why.', tone: 'arcane' },
  'docs-models-costs': { icon: Coins, blurb: 'What a session actually costs on each route.', tone: 'ember' },

  // Modules
  'docs-extras': { icon: Plug, blurb: 'The optional half. Only one of them installs anything.', tone: 'ember' },
  'docs-extras-audio-transcription': { icon: Mic, blurb: 'Whisper and Craig multitrack, offline.', tone: 'ember' },
  'docs-extras-whisper-cpp': { icon: Cpu, blurb: 'Transcription on AMD, Intel and Apple GPUs.', tone: 'moon' },
  'docs-extras-local-llms': { icon: Cpu, blurb: 'Ollama, LM Studio and Unsloth as routing targets.', tone: 'ember' },
  'docs-extras-personas': { icon: BookText, blurb: 'Swap the narrator out of the default bardic voice.', tone: 'gold' },
  'docs-extras-claude-code': { icon: Code2, blurb: 'Spend a Claude subscription instead of API credit.', tone: 'arcane' },
  'docs-extras-codex': { icon: Code2, blurb: 'The same, for a ChatGPT subscription.', tone: 'arcane' },
  'docs-extras-obsidian-vault': { icon: Library, blurb: 'Ground chronicles against a read-only Obsidian vault.', tone: 'arcane' },
  'docs-extras-isolation-contract': { icon: ShieldCheck, blurb: 'What an installable module may and may not touch.', tone: 'moon' },

  // Reference
  'docs-settings-configuration': { icon: Cog, blurb: 'Every setting, env var, and file on disk.', tone: 'arcane' },
  'docs-chronicling-how-the-phases-work': { icon: Layers, blurb: 'What each of the six phases actually does.', tone: 'arcane' },
  'docs-about-how-its-built': { icon: Code2, blurb: 'How the pieces fit together, in detail.', tone: 'moon' },

  // Security
  'docs-security-overview': { icon: ShieldCheck, blurb: 'What stays local, what leaves, and what is encrypted.', tone: 'arcane' },
  'docs-security-what-it-installs': { icon: ShieldCheck, blurb: 'What it writes to your disk, and what could go wrong.', tone: 'moon' },

  // Integrations
  'docs-extras-tusks-vault': { icon: Library, blurb: 'Pairing with Tusk\'s Vault for lore retrieval.', tone: 'arcane' },

  // About
  'docs-about-features': { icon: Library, blurb: 'Everything it does, in one list.', tone: 'gold' },
  'docs-about-who-its-for': { icon: BookText, blurb: 'Whether this is built for your table.', tone: 'gold' },
  'docs-about-comparison': { icon: GitCompare, blurb: 'Against the tabletop services, and against doing it yourself.', tone: 'moon' },
  'docs-troubleshooting-faq': { icon: HelpCircle, blurb: 'The questions that actually get asked.', tone: 'gold' },
  'docs-troubleshooting-known-issues': { icon: Search, blurb: 'What is broken, and what is merely awkward.', tone: 'ember' },
  'docs-about-changelog': { icon: History, blurb: 'What changed between versions.', tone: 'moon' },
  'docs-about-roadmap': { icon: MapIcon, blurb: 'Shipped, in progress, and deliberately not doing.', tone: 'ember' },

  // Tooling and project
  'docs-troubleshooting-diagnostic-bundles': { icon: Search, blurb: 'Diagnostic bundles for a failing run.', tone: 'moon' },
  'docs-tooling-graphify': { icon: Code2, blurb: 'A local code graph for development.', tone: 'moon' },
  contributing: { icon: GitCompare, blurb: 'Filing issues, sending PRs, running the tests.', tone: 'moon' },
  'docs-readme': { icon: BookOpen, blurb: 'The documentation index.', tone: 'gold' },
}

const FALLBACK_META: Meta = { icon: BookText, blurb: 'Documentation.', tone: 'moon' }

const TONE_CLASSES: Record<Meta['tone'], { ring: string; iconBg: string; iconFg: string }> = {
  gold:   { ring: 'hover:border-amber-400/50',   iconBg: 'bg-amber-500/10',  iconFg: 'text-amber-300' },
  arcane: { ring: 'hover:border-violet-400/55',  iconBg: 'bg-violet-500/15', iconFg: 'text-violet-200' },
  ember:  { ring: 'hover:border-orange-400/55',  iconBg: 'bg-orange-500/15', iconFg: 'text-orange-300' },
  moon:   { ring: 'hover:border-slate-300/45',   iconBg: 'bg-slate-500/15',  iconFg: 'text-slate-200' },
}

function getMeta(slug: string): Meta {
  return META[slug] ?? FALLBACK_META
}

// Group docs by folder for the landing page. Top-level ("/") first as a
// hero row; then docs/ as the main grid; then docs/add-ons/ as an
// accented section.
type Group = { label: string; entries: DocEntry[] }

/** The shelves, in the order a reader meets them. Longest prefix wins, so a
 *  more specific folder must come before the one that would swallow it. */
const SHELVES: Array<{ prefix: string; label: string }> = [
  { prefix: 'docs/getting-started', label: "Getting started" },
  { prefix: 'docs/importing', label: "Bringing a session in" },
  { prefix: 'docs/chronicling', label: "Writing the chronicle" },
  { prefix: 'docs/models', label: "Models & cost" },
  { prefix: 'docs/extras', label: "Extras & integrations" },
  { prefix: 'docs/settings', label: "Settings & files" },
  { prefix: 'docs/security', label: "Privacy & safety" },
  { prefix: 'docs/troubleshooting', label: "Troubleshooting" },
  { prefix: 'docs/about', label: "About Tusk's Tomes" },
  { prefix: 'docs/tooling', label: "Developer tooling" },
]

/** Where a doc's tile belongs. Anything unshelved lands in "More". */
function shelfFor(doc: DocEntry): string {
  const dir = doc.path.includes('/') ? doc.path.slice(0, doc.path.lastIndexOf('/')) : ''
  for (const shelf of SHELVES) {
    if (dir === shelf.prefix || dir.startsWith(`${shelf.prefix}/`)) return shelf.label
  }
  return 'More'
}

function groupForLanding(docs: DocEntry[]): Group[] {
  const buckets = new Map<string, DocEntry[]>()
  for (const doc of docs) {
    const label = shelfFor(doc)
    const list = buckets.get(label) ?? []
    list.push(doc)
    buckets.set(label, list)
  }

  // Within a shelf, order by title so the grid is predictable rather than
  // dependent on filesystem walk order.
  for (const list of buckets.values()) {
    list.sort((a, b) => a.title.localeCompare(b.title))
  }

  const ordered: Group[] = []
  for (const shelf of SHELVES) {
    const entries = buckets.get(shelf.label)
    if (entries) {
      ordered.push({ label: shelf.label, entries })
      buckets.delete(shelf.label)
    }
  }
  for (const label of [...buckets.keys()].sort()) {
    ordered.push({ label, entries: buckets.get(label)! })
  }
  return ordered
}

export function HelpLanding({ docs, onSelect }: HelpLandingProps) {
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return docs
    return docs.filter((d) => {
      const m = getMeta(d.slug)
      return (
        d.title.toLowerCase().includes(q) ||
        d.path.toLowerCase().includes(q) ||
        d.slug.toLowerCase().includes(q) ||
        m.blurb.toLowerCase().includes(q)
      )
    })
  }, [docs, query])

  const groups = useMemo(() => groupForLanding(filtered), [filtered])

  return (
    <div className="space-y-6">
      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search docs by title, path, or topic…"
          aria-label="Search documentation"
          className="w-full rounded-lg border border-border/60 bg-card/40 py-2 pl-10 pr-3 text-sm placeholder:text-muted-foreground focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">No docs match &ldquo;{query}&rdquo;.</p>
      ) : (
        groups.map((group) => (
          <section key={group.label} className="space-y-3">
            <h3 className="text-xs font-display uppercase tracking-[0.2em] text-muted-foreground">
              {group.label}
            </h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {group.entries.map((doc) => {
                const meta = getMeta(doc.slug)
                const tone = TONE_CLASSES[meta.tone]
                const Icon = meta.icon
                return (
                  <button
                    key={doc.slug}
                    type="button"
                    onClick={() => onSelect(doc.slug)}
                    className={`group relative flex flex-col gap-2 rounded-xl border border-border/60 bg-card/50 p-4 text-left transition-all ${tone.ring} hover:-translate-y-0.5 hover:shadow-lg`}
                  >
                    <div className="flex items-start gap-3">
                      <span className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${tone.iconBg} ${tone.iconFg}`}>
                        <Icon className="h-4.5 w-4.5" size={18} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <h4 className="font-display text-sm tracking-wide text-foreground line-clamp-2">
                          {doc.title}
                        </h4>
                        <p className="mt-0.5 truncate text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                          {doc.path}
                        </p>
                      </div>
                    </div>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {meta.blurb}
                    </p>
                  </button>
                )
              })}
            </div>
          </section>
        ))
      )}
    </div>
  )
}
