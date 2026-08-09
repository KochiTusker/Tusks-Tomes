import { useCallback, useEffect, useMemo, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import { ArrowLeft, BookOpen, FileText, Folder } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { HelpLanding } from './HelpLanding'
import { wrapH2SectionsInDetails } from '@/lib/collapsibleMarkdown'

// Restrictive HTML sanitiser configuration. rehype-raw enables raw HTML
// in markdown — required so the collapsible <details>/<summary>/<div>
// wrappers injected by wrapH2SectionsInDetails render as actual DOM
// (and not as escaped text). Without sanitisation a compromised .md
// (e.g. via a hostile update fetch) would execute arbitrary script
// against the user's local Tomes — and that origin can read
// /api/provider-keys. The schema below allows only the tags we
// actually use, blocks event-handler attributes, and uses the upstream
// `defaultSchema` as a known-safe base.
//
// EXPORTED so the regression test (DocsViewer.xss.test.ts) imports the
// REAL schema rather than a copy. A future change here that loosens
// the schema must update the test in lockstep.
export const SAFE_HTML_SCHEMA = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    'details',
    'summary',
  ],
  attributes: {
    ...defaultSchema.attributes,
    details: ['className', 'class', 'open'],
    summary: ['className', 'class'],
    div: ['className', 'class'],
  },
}

const HELP_DOC_EVENT = 'sbts:open-doc'

type DocEntry = {
  slug: string
  title: string
  path: string
}

type DocContent = DocEntry & { content: string }

/** Dispatch helper for other components (AddonsManager, WhisperSettings) that
 *  want to deep-link the Help tab to a specific doc. App.tsx switches to the
 *  Help tab when this fires; DocsViewer reads it and loads the doc. */
export function openHelpDoc(slug: string): void {
  window.dispatchEvent(new CustomEvent(HELP_DOC_EVENT, { detail: { slug } }))
}

export function DocsViewer() {
  const [docs, setDocs] = useState<DocEntry[]>([])
  const [activeSlug, setActiveSlug] = useState<string | null>(null)
  const [activeDoc, setActiveDoc] = useState<DocContent | null>(null)
  const [loadingList, setLoadingList] = useState(true)
  const [loadingDoc, setLoadingDoc] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Load doc list on mount.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/docs')
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const { docs: list } = (await res.json()) as { docs: DocEntry[] }
        if (cancelled) return
        setDocs(list)
      } catch (err) {
        if (!cancelled) setError((err as Error).message)
      } finally {
        if (!cancelled) setLoadingList(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Cross-tab deep-link: another component can fire HELP_DOC_EVENT to ask the
  // viewer to show a specific slug.
  useEffect(() => {
    function handler(e: Event) {
      const detail = (e as CustomEvent).detail as { slug?: string } | undefined
      if (detail?.slug) setActiveSlug(detail.slug)
    }
    window.addEventListener(HELP_DOC_EVENT, handler)
    return () => window.removeEventListener(HELP_DOC_EVENT, handler)
  }, [])

  // Load the active doc whenever the slug changes. Pre-process the markdown
  // to wrap H2 sections in <details> blocks so each section becomes a
  // collapsible card (closed by default).
  useEffect(() => {
    if (!activeSlug) {
      setActiveDoc(null)
      return
    }
    let cancelled = false
    setLoadingDoc(true)
    ;(async () => {
      try {
        const res = await fetch(`/api/docs/${encodeURIComponent(activeSlug)}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = (await res.json()) as DocContent
        if (!cancelled) {
          setActiveDoc({ ...body, content: wrapH2SectionsInDetails(body.content) })
          // Scroll the doc back into view; switching docs otherwise leaves
          // you wherever you scrolled in the last one.
          window.scrollTo({ top: 0, behavior: 'smooth' })
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message)
      } finally {
        if (!cancelled) setLoadingDoc(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activeSlug])

  const tree = useMemo(() => groupDocs(docs), [docs])

  const select = useCallback((slug: string) => {
    setActiveSlug(slug)
    setError(null)
  }, [])

  const backToLanding = () => {
    setActiveSlug(null)
    setActiveDoc(null)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BookOpen className="h-5 w-5" />
          Help &amp; Documentation
        </CardTitle>
        <CardDescription>
          Browse the same docs that live in the GitHub repo, without leaving the app.
          Each section is collapsible — click to open. Add-on pages link straight
          here from their settings rows.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loadingList ? (
          <p className="text-sm text-muted-foreground">Loading docs…</p>
        ) : docs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No docs found.</p>
        ) : !activeSlug ? (
          // Landing — tile grid + search. This is the new default view of
          // the Help tab; previously it dumped the README straight into a
          // long scroll, which was overwhelming.
          <HelpLanding docs={docs} onSelect={select} />
        ) : (
          // Reading view: small sidebar nav + the active doc as
          // collapsible sections.
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="ghost" size="sm" onClick={backToLanding}>
                <ArrowLeft className="mr-1 h-4 w-4" />
                All docs
              </Button>
              {activeDoc && (
                <span className="font-display text-xs uppercase tracking-[0.2em] text-muted-foreground">
                  {activeDoc.path}
                </span>
              )}
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-[220px_minmax(0,1fr)]">
              <nav className="space-y-3 border-border md:border-r md:pr-4">
                {tree.map((group) => (
                  <div key={group.label} className="space-y-1">
                    <div className="flex items-center gap-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      {group.label === '/' ? null : <Folder className="h-3 w-3" />}
                      {group.label === '/' ? 'Top level' : group.label}
                    </div>
                    <ul className="space-y-0.5">
                      {group.entries.map((doc) => (
                        <li key={doc.slug}>
                          <button
                            type="button"
                            onClick={() => select(doc.slug)}
                            className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-muted ${
                              activeSlug === doc.slug
                                ? 'bg-muted font-medium'
                                : 'text-muted-foreground'
                            }`}
                          >
                            <FileText className="h-3 w-3 shrink-0" />
                            <span className="truncate">{doc.title}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </nav>
              <article className="min-w-0">
                {error && (
                  <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
                    {error}
                  </div>
                )}
                {loadingDoc ? (
                  <p className="text-sm text-muted-foreground">Loading…</p>
                ) : activeDoc ? (
                  // No @tailwindcss/typography in this project. Style each
                  // markdown element directly via Tailwind child selectors —
                  // covers the common subset (headings, paragraphs, lists,
                  // code, links, tables, images) without adding a dep.
                  // rehypeRaw is enabled so inline HTML (badges, centered
                  // banners, <details> blocks) renders correctly.
                  <div className="text-sm leading-relaxed
                    [&_h1]:mt-0 [&_h1]:mb-3 [&_h1]:font-display [&_h1]:text-2xl [&_h1]:tracking-wider
                    [&_h2]:mt-6 [&_h2]:mb-2 [&_h2]:font-display [&_h2]:text-xl [&_h2]:tracking-wider
                    [&_h3]:mt-5 [&_h3]:mb-2 [&_h3]:font-display [&_h3]:text-base [&_h3]:tracking-wide
                    [&_p]:my-2
                    [&_a]:text-primary [&_a]:underline
                    [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5
                    [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5
                    [&_li]:my-0.5
                    [&_img]:inline-block [&_img]:my-1
                    [&_code]:rounded [&_code]:bg-muted/60 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-xs
                    [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted/60 [&_pre]:p-3
                    [&_pre_code]:bg-transparent [&_pre_code]:p-0
                    [&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground
                    [&_table]:my-3 [&_table]:w-full [&_table]:border-collapse
                    [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-medium
                    [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1
                    [&_hr]:my-4 [&_hr]:border-border
                    [&_strong]:font-semibold">
                    <Markdown
                      remarkPlugins={[remarkGfm]}
                      // Order matters: rehypeRaw converts raw HTML in
                      // the markdown into the rehype AST first, then
                      // rehypeSanitize prunes anything outside the
                      // allowlisted schema. Reversing them would let
                      // a hostile <script> tag through because
                      // sanitize wouldn't see it as an HTML element
                      // yet.
                      rehypePlugins={[rehypeRaw, [rehypeSanitize, SAFE_HTML_SCHEMA]]}
                    >
                      {activeDoc.content}
                    </Markdown>
                    <p className="mt-6 text-xs text-muted-foreground">
                      Source: <code>{activeDoc.path}</code>
                    </p>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">Select a doc from the list.</p>
                )}
              </article>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/** Group docs by their parent folder so the sidebar mirrors the on-disk
 *  layout (top-level files, then docs/, then docs/add-ons/, etc). */
function groupDocs(entries: DocEntry[]): Array<{ label: string; entries: DocEntry[] }> {
  const byGroup = new Map<string, DocEntry[]>()
  for (const entry of entries) {
    const lastSlash = entry.path.lastIndexOf('/')
    const label = lastSlash === -1 ? '/' : entry.path.slice(0, lastSlash)
    const list = byGroup.get(label) ?? []
    list.push(entry)
    byGroup.set(label, list)
  }
  // Top level first, then folder paths alphabetical.
  const labels = [...byGroup.keys()].sort((a, b) => {
    if (a === '/') return -1
    if (b === '/') return 1
    return a.localeCompare(b)
  })
  return labels.map((label) => ({ label, entries: byGroup.get(label) ?? [] }))
}
