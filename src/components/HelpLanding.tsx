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
  // Top-level docs (project-wide)
  readme: { icon: ScrollText, blurb: 'Start here — what Tusk\'s Tomes is, what it does, and why.', tone: 'gold' },
  setup: { icon: Compass, blurb: 'Install + first-run walkthrough.', tone: 'arcane' },
  contributing: { icon: GitCompare, blurb: 'How to file issues, send PRs, and run tests.', tone: 'moon' },
  roadmap: { icon: MapIcon, blurb: 'What\'s shipped, what\'s next, what\'s deferred.', tone: 'ember' },
  architecture: { icon: Layers, blurb: 'How the pieces fit together — pipeline, providers, add-ons.', tone: 'arcane' },

  // docs/
  'docs-readme': { icon: BookOpen, blurb: 'Documentation index.', tone: 'gold' },
  'docs-beginner-guide': { icon: Sparkles, blurb: 'Zero-to-chronicle in 15 minutes.', tone: 'gold' },
  'docs-comparison': { icon: GitCompare, blurb: 'How Tomes compares to NotebookLM, ChatGPT, etc.', tone: 'moon' },
  'docs-configuration': { icon: Cog, blurb: 'Settings, env vars, encrypted keystore.', tone: 'arcane' },
  'docs-dependencies': { icon: Plug, blurb: 'The libraries Tomes leans on.', tone: 'moon' },
  'docs-faq': { icon: HelpCircle, blurb: 'Quick answers to the common questions.', tone: 'gold' },
  'docs-features': { icon: Library, blurb: 'Capability tour — every tab, every panel.', tone: 'arcane' },
  'docs-pricing': { icon: Coins, blurb: 'Free forever. Why and how that holds up.', tone: 'ember' },
  'docs-privacy': { icon: ShieldCheck, blurb: 'What stays local, what reaches the cloud, what we never store.', tone: 'arcane' },
  'docs-providers': { icon: Cpu, blurb: 'Claude / Gemini / OpenAI / local — pick + switch.', tone: 'ember' },
  'docs-use-cases': { icon: BookText, blurb: 'Real campaigns running on Tomes.', tone: 'gold' },
  'docs-vault': { icon: Library, blurb: 'Pairing with Tusk\'s Vault for in-Discord lore retrieval.', tone: 'arcane' },
  'docs-workflows': { icon: History, blurb: 'End-to-end flows: transcript → chronicle → export.', tone: 'arcane' },

  // docs/add-ons/
  'docs-add-ons-readme': { icon: Plug, blurb: 'What add-ons are, how they install, why opt-in.', tone: 'ember' },
  'docs-add-ons-audio-transcription': { icon: Mic, blurb: 'Whisper + Craig multitrack offline.', tone: 'ember' },
  'docs-add-ons-local-llm': { icon: Cpu, blurb: 'Ollama / LM Studio / Unsloth as drop-in providers.', tone: 'ember' },
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

function groupForLanding(docs: DocEntry[]): Group[] {
  const buckets = new Map<string, DocEntry[]>()
  for (const d of docs) {
    const slash = d.path.lastIndexOf('/')
    const key = slash === -1 ? 'Project' : d.path.slice(0, slash)
    const list = buckets.get(key) ?? []
    list.push(d)
    buckets.set(key, list)
  }
  const order = ['Project', 'docs', 'docs/add-ons']
  const ordered: Group[] = []
  for (const key of order) {
    if (buckets.has(key)) {
      ordered.push({ label: key === 'Project' ? 'Project' : key, entries: buckets.get(key)! })
      buckets.delete(key)
    }
  }
  // Any remaining folders alphabetised at the end.
  const remaining = [...buckets.keys()].sort()
  for (const key of remaining) {
    ordered.push({ label: key, entries: buckets.get(key)! })
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
