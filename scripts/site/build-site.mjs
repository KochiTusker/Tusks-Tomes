/**
 * Static site generator for the public GitHub Pages site.
 *
 * Why this exists: a GitHub repo README is crawled but ranks poorly for
 * anything except the project's own name. Search engines want a real site —
 * canonical URLs, one topic per page, structured data, an internal link
 * graph, and a sitemap. This builds exactly that out of content we already
 * maintain (docs/**\/*.md) plus one hand-authored landing page, so the site
 * can never drift away from the docs the app itself ships.
 *
 * Output: site-dist/ (gitignored — see scripts/site/publish-site.mjs for how
 * it reaches the `gh-pages` branch on the public remote).
 *
 * SAFETY — the load-bearing part of this file:
 *   Publishability is decided by checkForbiddenFilenames() from
 *   scripts/lib/secret-scanner.mjs — the SAME registry the pre-push release
 *   gate uses. That is deliberate: it makes it structurally impossible for a
 *   dev-only doc (CLAUDE.md, docs/security/public-release-workflow.md) to be
 *   published here while being blocked at the git gate. Adding a file to the
 *   scanner's FORBIDDEN_FILE_PATTERNS automatically removes it from the site.
 *   Do NOT replace that call with a local copy of the list — a second list is
 *   a second thing to forget to update.
 *
 * Raw HTML in markdown is passed through (rehype-raw). That is safe here and
 * only here: every input is a repo-tracked file that already passes the
 * release scanners. Never point this generator at user-supplied markdown.
 *
 * No new npm dependencies: unified/remark/rehype are already devDependencies
 * (used by the in-app docs viewer toolchain).
 */

import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkRehype from 'remark-rehype'
import rehypeRaw from 'rehype-raw'
import rehypeStringify from 'rehype-stringify'
import { checkForbiddenFilenames, scanLinesForTokens } from '../lib/secret-scanner.mjs'
import {
  scanLinesForEmails,
  scanLinesForLocalPaths,
  scanLinesForSpeakerNames,
} from '../lib/personal-info-scanner.mjs'
import { resolvePrivateNames, scanLinesForPrivateNames } from '../lib/private-names.mjs'
import { loadRotationState } from '../lib/name-pool.mjs'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Where the site will live. Overridable so a custom domain (or a local
 *  preview at a different base path) needs no code edit. For a GitHub project
 *  page the base path is the repo name — links MUST include it or every
 *  internal link 404s. */
export const SITE = {
  origin: process.env.SITE_ORIGIN ?? 'https://kochitusker.github.io',
  base: process.env.SITE_BASE ?? '/Tusks-Tomes',
  repo: 'https://github.com/KochiTusker/Tusks-Tomes',
  branch: 'main',
  name: "Tusk's Tomes",
  // Google Search Console site-ownership verification. Both tokens below are
  // public by design — each method REQUIRES its token to be publicly fetchable.
  // They prove ownership and grant no access on their own, so neither is a
  // secret. Removing one un-verifies that property and Search Console stops
  // reporting on it.
  //
  // Two methods, because they verify different properties:
  //   - meta tag: the <head> token, carried over from the earlier site work.
  //   - file:     the URL-prefix property for https://…/Tusks-Tomes/.
  // A github.io project page cannot use the DNS method at all — that verifies
  // the whole of kochitusker.github.io, and only GitHub can set DNS there.
  googleSiteVerification: 'Cz-7x7YO8xZdvh-X7LbaRQmhOZkzZRbAqyNqzwCDR5g',
  // Emitted verbatim at the site root. Google fetches it and expects the file
  // to name itself; set to null to stop emitting it.
  googleVerificationFile: 'googled056a1feb0133c98.html',
}

/** Root-level markdown promoted into the docs URL space, with the slug it
 *  should own. AddOns.md is the canonical add-on page, so it takes
 *  /docs/add-ons/ and the 491-byte stub at docs/add-ons/README.md is skipped
 *  (thin redirect pages are an SEO liability, not an asset). */
const ROOT_PAGES = [
  { src: 'SETUP.md', slug: 'docs/setup' },
  { src: 'AddOns.md', slug: 'docs/add-ons' },
  { src: 'ROADMAP.md', slug: 'docs/roadmap' },
  // README.md is deliberately absent. The landing page was written to cover
  // the same ground for a different reader, and publishing both would put two
  // near-identical pages in the index competing for the same queries instead
  // of covering different ones.
  { src: 'architecture.md', slug: 'docs/architecture' },
  { src: '.github/SECURITY.md', slug: 'docs/security-policy' },
  { src: '.github/CODE_OF_CONDUCT.md', slug: 'docs/code-of-conduct' },
]

/** Publishable markdown we nonetheless leave off the site.
 *  Not a security list — the security list is the scanner's. */
const SKIP_DOCS = new Set([
  'docs/add-ons/README.md', // redirect stub; AddOns.md owns /docs/add-ons/
  'docs/assets/README.md', // explains the image folder to contributors
])

/** Human-facing section labels for the docs nav, longest prefix wins. */
/** Index grouping, in match order — first hit wins, so put exact slugs before
 *  the prefixes that would otherwise swallow them.
 *
 *  Grouped by what a reader is trying to DO, not by where the file happens to
 *  sit in the repo. "Project" is the about-the-project shelf: what's planned,
 *  what's broken, how it's built, how to behave. Someone choosing whether to
 *  install reads those together and none of them belong under "Guides". */
const NAV_GROUPS = [
  { prefix: 'docs/add-ons', label: 'Add-ons' },
  { prefix: 'docs/tooling', label: 'Tooling' },
  {
    label: 'Project',
    slugs: [
      'docs/roadmap',
      'docs/known-bugs',
      'docs/architecture',
      'docs/security-policy',
      'docs/code-of-conduct',
    ],
  },
  { prefix: 'docs', label: 'Guides' },
]

/** Does this page belong to this group? */
function inNavGroup(page, group) {
  if (group.slugs) return group.slugs.includes(page.slug)
  return page.slug === group.prefix || page.slug.startsWith(`${group.prefix}/`)
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for scripts/site/build-site.test.mjs)
// ---------------------------------------------------------------------------

const norm = (p) => String(p).replace(/\\/g, '/')

/** Would publishing this repo-relative path be allowed?
 *  Delegates the security decision to the release scanner — see the file
 *  header for why this must not become a local copy of the list. */
export function isPublishable(rel) {
  const p = norm(rel)
  if (!/\.md$/i.test(p)) return false
  if (checkForbiddenFilenames([p]).length > 0) return false
  if (SKIP_DOCS.has(p)) return false
  return true
}

/** docs/faq.md → docs/faq · docs/README.md → docs · docs/a/b.md → docs/a/b */
export function slugForDoc(rel) {
  const p = norm(rel).replace(/\.md$/i, '')
  return p.replace(/\/README$/i, '') || 'docs'
}

/** The slug a repo-relative markdown file is published under, or null if it
 *  is not on the site at all. */
export function publishedSlug(rel) {
  const p = norm(rel)
  const override = ROOT_PAGES.find((r) => r.src.toLowerCase() === p.toLowerCase())
  if (override) return override.slug
  if (!p.startsWith('docs/')) return null
  if (!isPublishable(p)) return null
  return slugForDoc(p)
}

/**
 * Rewrite a markdown link/image target for the built site.
 *
 * Three destinations:
 *   - another published page  → pretty site URL (keeps the link graph internal)
 *   - a copied asset          → site asset URL
 *   - anything else in-repo   → absolute GitHub blob URL, so links to source
 *                               files and unpublished docs still resolve
 *                               instead of dead-ending on the site.
 */
export function rewriteHref(href, fromRel, opts = {}) {
  const { base = SITE.base, repo = SITE.repo, branch = SITE.branch } = opts
  if (!href || typeof href !== 'string') return href
  if (href.startsWith('#')) return href
  // Protocol-absolute (https:, mailto:), protocol-relative (//), or already
  // site-absolute (/Tusks-Tomes/...) — leave alone.
  if (/^([a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(href)) return href

  const hashAt = href.indexOf('#')
  const hash = hashAt >= 0 ? href.slice(hashAt) : ''
  const target = hashAt >= 0 ? href.slice(0, hashAt) : href
  if (!target) return href

  const fromDir = path.posix.dirname(norm(fromRel))
  let resolved = path.posix.normalize(path.posix.join(fromDir === '.' ? '' : fromDir, target))
  // A link that climbs above the repo root is malformed; clamp it rather than
  // emitting ../ segments that would escape the site base.
  resolved = resolved.replace(/^(\.\.\/)+/, '').replace(/^\.\//, '')

  if (resolved.startsWith('docs/assets/')) return `${base}/${resolved}${hash}`

  if (/\.md$/i.test(resolved)) {
    const slug = publishedSlug(resolved)
    if (slug) return `${base}/${slug}/${hash}`
  }
  return `${repo}/blob/${branch}/${resolved}${hash}`
}

/** Strip inline markdown so a paragraph can be used as a meta description. */
export function stripMd(s) {
  return String(s)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → text
    .replace(/<[^>]+>/g, '') // inline HTML
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Trim to a length search engines will actually render, on a word boundary. */
export function clampDescription(s, max = 158) {
  const t = stripMd(s)
  if (t.length <= max) return t
  const cut = t.slice(0, max)
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf(' '))
  return `${cut.slice(0, stop > 40 ? stop : max).replace(/[,;:.\s]+$/, '')}…`
}

/**
 * Pull a page title and meta description out of the markdown itself.
 * Title = the H1, minus any leading emoji (emoji in a <title> renders as
 * mojibake in some SERP contexts and wastes pixel budget).
 * Description = first real prose paragraph, skipping badge/image/HTML lines.
 */
export function extractMeta(md) {
  const lines = String(md).split(/\r?\n/)
  let title = null
  const paragraph = []
  let seenH1 = false

  for (const raw of lines) {
    const line = raw.trim()
    if (!seenH1) {
      const m = /^#\s+(.+?)\s*$/.exec(line)
      if (m) {
        title = stripMd(m[1])
          // Leading pictographs + variation selectors, then any separator.
          .replace(/^[\p{Extended_Pictographic}\u{FE0F}\u{200D}\s]+/u, '')
          .trim()
        seenH1 = true
      }
      continue
    }
    // Keep gathering until there's enough text to be a usable search snippet.
    // Some docs open with a one-line lead-in ("Two sources of config, in
    // priority order:") which on its own makes a useless meta description —
    // Google shows ~155 characters, and a 40-character fragment wastes the
    // slot. Below MIN_DESC we keep absorbing following blocks.
    const MIN_DESC = 90
    const enough = () => paragraph.join(' ').length >= MIN_DESC

    if (!line) {
      if (paragraph.length && enough()) break
      continue
    }
    if (line.startsWith('#')) {
      if (paragraph.length && enough()) break
      continue
    }
    // Skip badge rows, bare images, raw HTML blocks, tables, code fences.
    if (/^[<|>]/.test(line) || /^!\[/.test(line) || /^```/.test(line)) {
      if (paragraph.length && enough()) break
      continue
    }
    // Strip list markers so the snippet reads as prose rather than "1. **In-app
    // Settings tab.** …".
    paragraph.push(line.replace(/^(\s*[-*+]|\s*\d+\.)\s+/, ''))
  }

  return {
    title: title || null,
    description: paragraph.length ? clampDescription(paragraph.join(' ')) : null,
  }
}

/** GitHub-compatible heading anchor. */
export function slugifyHeading(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
}

const escapeHtml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** JSON-LD must not be able to break out of its own <script> element. */
const jsonLdSafe = (obj) => JSON.stringify(obj, null, 2).replace(/</g, '\\u003c')

// ---------------------------------------------------------------------------
// Markdown → HTML
// ---------------------------------------------------------------------------

const textOf = (node) =>
  node.type === 'text'
    ? node.value
    : node.children
      ? node.children.map(textOf).join('')
      : ''

function walk(node, fn) {
  fn(node)
  if (node.children) for (const child of node.children) walk(child, fn)
}

/** Rewrites links/images, adds heading anchors, and collects a table of
 *  contents — one pass over the tree so page builds stay cheap.
 *
 *  `toc` is supplied by the caller and filled in place, rather than stashed on
 *  the AST root: hast nodes have a defined shape and hanging extra fields off
 *  them breaks as soon as another plugin clones the tree.
 *
 *  Returns a unified *attacher* (a function returning the transformer), which
 *  is what .use() expects. */
function transformTree(fromRel, toc = []) {
  return () => (tree) => {
    const seen = new Map()
    walk(tree, (node) => {
      if (node.type !== 'element') return
      const props = (node.properties ||= {})

      if (node.tagName === 'a' && typeof props.href === 'string') {
        props.href = rewriteHref(props.href, fromRel)
        if (/^https?:/i.test(props.href) && !props.href.startsWith(SITE.origin)) {
          props.rel = ['noopener']
        }
      }

      if (node.tagName === 'img' && typeof props.src === 'string') {
        props.src = rewriteHref(props.src, fromRel)
        // Below-the-fold screenshots are heavy; lazy-loading them is a direct
        // Core Web Vitals (LCP) win, which Google uses as a ranking signal.
        props.loading = 'lazy'
        props.decoding = 'async'
      }

      if (/^h[23456]$/.test(node.tagName)) {
        const text = textOf(node)
        const stem = slugifyHeading(text) || 'section'
        const n = (seen.get(stem) ?? 0) + 1
        seen.set(stem, n)
        props.id = n === 1 ? stem : `${stem}-${n}`
        if (node.tagName === 'h2' && text.trim()) {
          toc.push({ id: props.id, text: text.trim() })
        }
      }
    })
  }
}

/** Render one markdown source to HTML, returning the body and its H2 outline.
 *
 *  HTML comments are stripped from the output. The docs use them as authoring
 *  notes — "Add new items here", "Items the maintainers want to do but haven't
 *  sized yet" — which are useful in the repo and are internal chatter once
 *  they're sitting in the page source of a public site. rehype-raw passes them
 *  through faithfully, so they have to be removed here. */
export async function renderMarkdown(md, fromRel) {
  const toc = []
  const html = String(
    await unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkRehype, { allowDangerousHtml: true })
      .use(rehypeRaw)
      .use(transformTree(fromRel, toc))
      .use(rehypeStringify, { allowDangerousHtml: true })
      .process(md),
  )
  return { html: html.replace(/<!--[\s\S]*?-->/g, ''), toc }
}

// ---------------------------------------------------------------------------
// HTML shell
// ---------------------------------------------------------------------------

const abs = (p) => `${SITE.origin}${SITE.base}${p.startsWith('/') ? p : `/${p}`}`

/** Only the faces used above the fold. Preloading every weight would compete
 *  for bandwidth with the LCP image and make the page slower, not faster. */
const PRELOAD_FONTS = ['cinzel-decorative-900.woff2', 'cinzel-700.woff2', 'inter-400.woff2']

/** Inline SVG symbols. Inline rather than an external sprite so the header
 *  paints with no extra request. */
const SVG_DEFS = `<svg class="svg-defs" aria-hidden="true">
  <symbol id="tt-tusk" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M3.5 21.5 L 19 5.5"/><path d="M19 5.5 C 16.5 4.5, 14.2 5.4, 13.2 8"/>
    <path d="M8 6 C 8 3.8, 9.8 2.5, 12 2.5 C 14.2 2.5, 16 3.8, 16 6 L 16 9.5 L 8 9.5 Z"/>
    <path d="M9.8 6.8 Q 12 8.4, 14.2 6.8"/>
    <path d="M8 9.5 L 6 19.5 M 16 9.5 L 18 19.5"/><path d="M6 19.5 Q 12 21, 18 19.5"/>
    <path d="M8.5 13.5 L 12 12.5 L 15.5 13.5 L 15.5 17 L 12 16 L 8.5 17 Z"/>
    <line x1="12" y1="12.5" x2="12" y2="16"/>
  </symbol>
  <symbol id="tt-star" viewBox="0 0 20 20"><path d="M10 1 L11.5 8.5 L19 10 L11.5 11.5 L10 19 L8.5 11.5 L1 10 L8.5 8.5 Z" fill="currentColor"/></symbol>
  <symbol id="tt-gh" viewBox="0 0 16 16"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></symbol>
</svg>`

/** Six drifting embers behind the page. Pure decoration, aria-hidden, and
 *  disabled entirely under prefers-reduced-motion. */
const EMBER_FIELD =
  '<div class="ember-field" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span><span></span></div>'

/** The single OG/Twitter preview image. Absolute URL — relative OG images are
 *  ignored by every crawler that matters. */
/** The social preview card — what Discord, Slack, X and Google show beside a
 *  link to this site.
 *
 *  1200x630 because that is the ratio every major scraper crops to; a square
 *  image gets letterboxed or centre-cropped and looks accidental. The crest is
 *  scaled DOWN onto the canvas, never up, so it stays crisp.
 *
 *  JPEG rather than PNG: identical at this size and a quarter of the bytes
 *  (145 KB against 617), and a preview image is fetched on every share.
 *
 *  Regenerate with scripts/site/make-social-card.mjs after changing the logo.
 *  Do not export one by hand — the script strips the encoder tag that ffmpeg
 *  otherwise leaves in a COM segment. */
const ogImage = () => abs('/docs/assets/tusks-tomes-social-card.jpg')

/**
 * The <head> for every page.
 *
 * Notes that deliberately stay in this source file rather than shipping as
 * HTML comments in the output:
 *   - `max-image-preview:large` opts the screenshots into large thumbnails in
 *     Google results, which lifts click-through for a visual tool.
 *   - `summary_large_image` needs no account handle, so `twitter:site` and
 *     `twitter:creator` are omitted: the site must link to no personal
 *     account. Explaining that in a shipped comment would itself advertise
 *     the posture, so the reasoning lives here.
 *   - The CSP is delivered as a meta tag because GitHub Pages serves HTTPS
 *     and HSTS but permits no custom response headers. It is deliberately
 *     strict — 'self' everywhere and NO 'unsafe-inline' for scripts, which is
 *     why the one behaviour script lives in site/site.js and the symbol sheet
 *     uses a class instead of style="display:none". The only third party
 *     allowed to frame anything is the privacy-mode YouTube domain, and that
 *     is contacted only after a deliberate click.
 *
 *     `frame-ancestors` is deliberately absent: the spec ignores it when a
 *     policy arrives via <meta>, and including it only logs a console error
 *     on every page load. Clickjacking protection would need an
 *     X-Frame-Options / CSP response header, which GitHub Pages does not let
 *     us set — an accepted limitation of this hosting, not an oversight.
 */
function head({ title, description, canonical, jsonLd }) {
  const blocks = (Array.isArray(jsonLd) ? jsonLd : [jsonLd]).filter(Boolean)
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${escapeHtml(canonical)}">
<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${escapeHtml(SITE.name)}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${escapeHtml(canonical)}">
<meta property="og:image" content="${escapeHtml(ogImage())}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="twitter:image" content="${escapeHtml(ogImage())}">
<meta name="theme-color" content="#12100c">
<meta name="google-site-verification" content="${escapeHtml(SITE.googleSiteVerification)}">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; frame-src https://www.youtube-nocookie.com; connect-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'">
<meta name="referrer" content="strict-origin-when-cross-origin">
<link rel="icon" href="${SITE.base}/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${SITE.base}/styles.css">
${PRELOAD_FONTS.map(
  (f) =>
    `<link rel="preload" href="${SITE.base}/assets/fonts/${f}" as="font" type="font/woff2" crossorigin>`,
).join('\n')}
${blocks.map((b) => `<script type="application/ld+json">\n${jsonLdSafe(b)}\n</script>`).join('\n')}`
}

/** Shared site header. Generated in one place so the landing page and the 30
 *  doc pages cannot drift apart. `links` is the middle of the nav; the brand
 *  and the GitHub button are fixed. */
function siteHeader(links) {
  return `<header class="site-head">
  <a class="brand" href="${SITE.base}/"><svg aria-hidden="true"><use href="#tt-tusk"/></svg> ${escapeHtml(SITE.name)}</a>
  <nav aria-label="Primary">
${links.map((l) => `    <a href="${l.href}"${l.external ? ' rel="noopener"' : ''}>${escapeHtml(l.label)}</a>`).join('\n')}
    <a class="gh" href="${SITE.repo}" rel="noopener"><svg aria-hidden="true"><use href="#tt-gh"/></svg> GitHub</a>
  </nav>
</header>`
}

/** Decorative divider between landing sections. */
const RUNE = '<div class="rune" aria-hidden="true"><svg><use href="#tt-star"/></svg></div>'

function docsNav(pages, currentSlug) {
  const groups = new Map(NAV_GROUPS.map((g) => [g.label, []]))
  for (const p of pages) {
    const group = NAV_GROUPS.find((g) => p.slug === g.prefix || p.slug.startsWith(`${g.prefix}/`))
    groups.get(group ? group.label : 'Guides').push(p)
  }
  const sections = []
  for (const { label } of NAV_GROUPS) {
    const items = (groups.get(label) ?? []).sort((a, b) => a.title.localeCompare(b.title))
    if (!items.length) continue
    sections.push(
      `<h2>${escapeHtml(label)}</h2>\n<ul>` +
        items
          .map(
            (p) =>
              `<li><a href="${SITE.base}/${p.slug}/"${p.slug === currentSlug ? ' aria-current="page"' : ''}>${escapeHtml(p.title)}</a></li>`,
          )
          .join('\n') +
        '</ul>',
    )
  }
  return `<nav class="docs-nav" aria-label="Documentation">${sections.join('\n')}</nav>`
}

function docPage({ page, bodyHtml, pages }) {
  const canonical = abs(`/${page.slug}/`)
  const breadcrumb = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: SITE.name, item: abs('/') },
      { '@type': 'ListItem', position: 2, name: 'Docs', item: abs('/docs/') },
      { '@type': 'ListItem', position: 3, name: page.title, item: canonical },
    ],
  }
  const article = {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline: page.title,
    description: page.searchDescription ?? page.description,
    url: canonical,
    isPartOf: { '@type': 'WebSite', name: SITE.name, url: abs('/') },
    about: { '@type': 'SoftwareApplication', name: SITE.name },
    inLanguage: 'en-GB',
  }
  const kw = keywordString(page.keywords ?? [])
  if (kw) article.keywords = kw

  // HowTo, on the pages that genuinely describe a start-to-finish procedure.
  // Only those: marking a reference page as a HowTo to chase the rich result
  // is the kind of thing that gets structured data ignored site-wide, and the
  // step names here are the page's own headings rather than an invented list.
  const howTo = page.howTo
    ? {
        '@context': 'https://schema.org',
        '@type': 'HowTo',
        name: page.howTo.name,
        description: page.searchDescription ?? page.description,
        url: canonical,
        ...(page.howTo.totalTime ? { totalTime: page.howTo.totalTime } : {}),
        ...(page.howTo.supply?.length
          ? { supply: page.howTo.supply.map((s) => ({ '@type': 'HowToSupply', name: s })) }
          : {}),
        ...(page.howTo.tool?.length
          ? { tool: page.howTo.tool.map((t) => ({ '@type': 'HowToTool', name: t })) }
          : {}),
        step: (page.howTo.steps ?? []).map((s, i) => ({
          '@type': 'HowToStep',
          position: i + 1,
          name: s.name,
          text: s.text,
          ...(s.anchor ? { url: `${canonical}#${s.anchor}` } : {}),
        })),
      }
    : null
  const toc = page.toc?.length
    ? `<aside class="toc" aria-label="On this page"><h2>On this page</h2><ul>${page.toc
        .map((t) => `<li><a href="#${escapeHtml(t.id)}">${escapeHtml(t.text)}</a></li>`)
        .join('')}</ul></aside>`
    : ''

  return `<!doctype html>
<html lang="en-GB">
<head>
${head({
  title: page.searchTitle ? `${page.searchTitle} — ${SITE.name}` : `${page.title} — ${SITE.name}`,
  description: page.searchDescription ?? page.description,
  canonical,
  jsonLd: [breadcrumb, article, howTo],
})}
</head>
<body class="docs">
<a class="skip" href="#main">Skip to content</a>
${SVG_DEFS}
${EMBER_FIELD}
${siteHeader([
  { href: `${SITE.base}/docs/`, label: 'Docs' },
  { href: `${SITE.base}/docs/setup/`, label: 'Install' },
])}
<div class="docs-layout">
  ${docsNav(pages, page.slug)}
  <main id="main">
    <nav class="crumbs" aria-label="Breadcrumb">
      <a href="${SITE.base}/">Home</a> <span aria-hidden="true">/</span>
      <a href="${SITE.base}/docs/">Docs</a> <span aria-hidden="true">/</span>
      <span>${escapeHtml(page.title)}</span>
    </nav>
    ${toc}
    <article class="prose">
${bodyHtml}
    </article>
    <p class="edit-link"><a href="${SITE.repo}/blob/${SITE.branch}/${page.src}" rel="noopener">Improve this page on GitHub →</a></p>
  </main>
</div>
<footer class="site-foot">
  <p>${escapeHtml(SITE.name)} — free, open source, MIT licensed. Runs on your own machine.</p>
  <p><a href="${SITE.repo}" rel="noopener">GitHub</a> · <a href="${SITE.base}/docs/">Documentation</a> · <a href="${SITE.repo}/blob/${SITE.branch}/LICENSE" rel="noopener">Licence</a></p>
</footer>
</body>
</html>
`
}

// ---------------------------------------------------------------------------
// Landing page
// ---------------------------------------------------------------------------

const DEFAULT_POSTER = 'docs/assets/pipeline-six-phase-ai-dnd-chronicle.png'

/**
 * Accept a timestamp as seconds (90), or as the "m:ss" / "h:mm:ss" form you
 * can copy straight out of a YouTube chapter list. Returns whole seconds.
 * Editing site.json should not require doing arithmetic by hand.
 */
export function parseTimestamp(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? Math.round(value) : null
  const raw = String(value).trim()
  if (/^\d+$/.test(raw)) return Number(raw)
  const parts = raw.split(':')
  if (parts.length < 2 || parts.length > 3 || !parts.every((p) => /^\d{1,2}$/.test(p.trim()))) return null
  return parts.reduce((acc, p) => acc * 60 + Number(p.trim()), 0)
}

/** Seconds → the "m:ss" / "h:mm:ss" form people expect next to a video.
 *  Mirrors parseTimestamp, so what you type in site.json is what gets shown. */
export function formatTimestamp(totalSeconds) {
  if (totalSeconds == null || !Number.isFinite(totalSeconds) || totalSeconds < 0) return null
  const s = Math.round(totalSeconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
}

/**
 * Click-to-load YouTube facade.
 *
 * Two reasons this is not a plain <iframe>:
 *  1. Privacy — a bare embed contacts Google and sets cookies on page load,
 *     for every visitor, whether or not they watch. The facade sends zero
 *     third-party requests until a deliberate click, which keeps the site
 *     consistent with the project's no-telemetry stance and sidesteps the
 *     need for a cookie banner. That matters more here than usual: the page
 *     carries SEVERAL embeds of the same video, so plain iframes would mean
 *     several megabytes and several trackers per visit.
 *  2. Speed — a YouTube iframe costs ~1MB+ and several hundred ms of main
 *     thread. Deferring protects the Core Web Vitals that feed search ranking.
 *
 * Posters are local screenshots rather than i.ytimg.com thumbnails — fetching
 * the YouTube thumbnail on load would leak the visitor to Google and defeat
 * the whole point of the facade.
 */
function facade({ id, poster, alt, note, start = null, end = null, compact = false }) {
  const attrs = [
    `data-video-id="${escapeHtml(id)}"`,
    start != null ? `data-start="${start}"` : '',
    end != null ? `data-end="${end}"` : '',
  ]
    .filter(Boolean)
    .join(' ')
  const watch =
    `https://www.youtube.com/watch?v=${encodeURIComponent(id)}` + (start != null ? `&t=${start}s` : '')
  return `<div class="video${compact ? ' video-compact' : ''}" ${attrs}>
  <button type="button" class="video-play" aria-label="${escapeHtml(alt)} (loads YouTube when clicked)">
    <img src="${SITE.base}/${poster}" alt="${escapeHtml(alt)}" width="1200" height="675" loading="lazy" decoding="async">
    <span class="video-btn" aria-hidden="true"></span>
    <span class="video-note">${escapeHtml(note)}</span>
  </button>
  <noscript><p><a href="${watch}" rel="noopener">Watch this section on YouTube</a></p></noscript>
</div>`
}

function videoBlock(video) {
  if (!video?.id) {
    return `<div class="video-placeholder">
      <p><strong>Demo video coming soon.</strong></p>
      <p>In the meantime, the <a href="${SITE.base}/docs/walkthrough/">step-by-step walkthrough</a> covers the same ground in screenshots.</p>
    </div>`
  }
  return facade({
    id: video.id,
    poster: video.poster || DEFAULT_POSTER,
    alt: video.title || 'Watch the demo',
    note: 'Click to play — YouTube only loads when you do',
  })
}

/**
 * One chapter of the single demo video, embedded where it is relevant on the
 * page and bounded to its own start/end. All chapters point at the same
 * upload, so there is one video to record and re-record.
 */
function clipBlock(video, chapter) {
  const start = parseTimestamp(chapter.start)
  const end = parseTimestamp(chapter.end)
  if (!video?.id) {
    return `<div class="clip-placeholder"><span>▶</span> ${escapeHtml(chapter.label)}<em>video chapter — pending upload</em></div>`
  }
  const from = formatTimestamp(start)
  const to = formatTimestamp(end)
  const range = from ? (to ? `${from}–${to}` : `from ${from}`) : null
  return `<figure class="clip">
${facade({
  id: video.id,
  poster: chapter.poster || video.poster || DEFAULT_POSTER,
  alt: chapter.label,
  note: chapter.note || 'Click to play this section',
  start,
  end,
  compact: true,
})}
  <figcaption>
    ${range ? `<span class="clip-time">${escapeHtml(range)}</span> ` : ''}${escapeHtml(chapter.label)}${chapter.blurb ? ` — ${escapeHtml(chapter.blurb)}` : ''}
  </figcaption>
</figure>`
}

/**
 * A clickable chapter index for the main demo video.
 *
 * Two things this buys, beyond looking tidy:
 *   - Visitors can skip straight to the part they care about instead of
 *     scrubbing a 20-minute video, which is the single most common reason
 *     someone gives up on a demo.
 *   - It mirrors the schema.org Clip data emitted in the page's JSON-LD, so
 *     the same chapters Google shows as "Key Moments" in search results are
 *     the ones visible here. One source (site.json), three surfaces.
 *
 * Each entry loads the demo video in place at that timestamp — no navigation
 * away, and still no YouTube request until a deliberate click.
 */
function chaptersBlock(video) {
  const chapters = video?.chapters ?? []
  if (!video?.id || chapters.length === 0) return ''
  const rows = chapters
    .map((c) => {
      const start = parseTimestamp(c.start)
      if (start == null) return ''
      const end = parseTimestamp(c.end)
      return `    <li>
      <button type="button" class="chapter" data-start="${start}"${end != null ? ` data-end="${end}"` : ''}>
        <span class="chapter-time">${escapeHtml(formatTimestamp(start))}</span>
        <span class="chapter-label">${escapeHtml(c.label)}</span>
      </button>
    </li>`
    })
    .filter(Boolean)
    .join('\n')
  if (!rows) return ''
  return `<div class="chapters">
  <h3>Jump to a section</h3>
  <ol class="chapter-list">
${rows}
  </ol>
</div>`
}

function faqBlock(faq) {
  if (!faq?.length) return ''
  return `<dl class="faq">
${faq
  .map(
    (f) =>
      `  <dt id="faq-${slugifyHeading(f.q)}">${escapeHtml(f.q)}</dt>\n  <dd>${f.a}</dd>`,
  )
  .join('\n')}
</dl>`
}

/** FAQPage structured data. Google requires the answer to be *visible* on the
 *  page, so both the visible <dl> and this graph are generated from the same
 *  array — they cannot fall out of sync. */
function faqJsonLd(faq) {
  if (!faq?.length) return null
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faq.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: stripMd(f.a.replace(/<[^>]+>/g, ' ')) },
    })),
  }
}

// ---------------------------------------------------------------------------
// Sample output
// ---------------------------------------------------------------------------

/**
 * Real pipeline output, shown on the landing page.
 *
 * THE GATE: `approved` in site/examples.json must be exactly `true`. Anything
 * else — false, missing, the string "true", a truthy 1 — renders nothing at
 * all, and the section, its heading and its structured data all disappear with
 * it. That strictness is the point. These strings are extracts from somebody's
 * real game; the failure mode to design against is not a bad snippet, it is an
 * unreviewed snippet reaching the public site because a data file was edited
 * and the review step was assumed to have happened.
 *
 * The provenance block is not decoration either. Sample output that does not
 * say which models produced it invites the reader to assume the best case, and
 * a reader who installs the tool, routes everything to a 4B local model and
 * gets something flatter has been misled by omission. So the routing table
 * ships beside the samples, and so does the note that the extras are curated.
 */
export const UNAPPROVED_PREVIEW_MARKER = 'data-tt-unapproved-preview'

/**
 * Escape sample text, then re-permit exactly two inline tags.
 *
 * The samples are transcript-derived prose that carries real emphasis: spell
 * names arrive italicised because the pipeline italicises them, and the recap
 * bullets arrive with bold lead-ins. Dropping that would misrepresent the
 * output; passing the strings through raw would mean trusting text whose whole
 * provenance is "a language model wrote this about a recording".
 *
 * So: escape everything first, unconditionally, then unescape the four exact
 * byte sequences `<em>`, `</em>`, `<strong>`, `</strong>`. Nothing else can
 * survive that — not an attribute, not a tag with whitespace in it, not
 * `<EM >`, not `<script>`. The allowlist is the implementation rather than a
 * filter applied to it, which is the difference between this and a sanitiser
 * you have to keep ahead of.
 */
export function inlineHtml(s) {
  return escapeHtml(s).replace(/&lt;(\/?)(em|strong)&gt;/g, '<$1$2>')
}

export function examplesBlock(ex, { preview = false } = {}) {
  const approved = ex?.approved === true
  if (!approved && !preview) return ''

  // The reviewer has to SEE the samples to approve them, and making them flip
  // the flag first inverts the gate — the file then sits at `true` until
  // somebody remembers to put it back, which is the same as having no gate.
  // So SITE_PREVIEW_UNAPPROVED=1 renders the section for a local read-through
  // and stamps the output with a marker that publish-site.mjs refuses to push.
  const banner = approved
    ? ''
    : `  <div class="notice warn unapproved" ${UNAPPROVED_PREVIEW_MARKER}>
    <h3>Preview only — not approved for publication</h3>
    <p>
      site/examples.json has <code>approved: false</code>. This section is rendered because
      <code>SITE_PREVIEW_UNAPPROVED=1</code> is set, so that these samples can be read in place before
      being signed off. <code>npm run site:publish</code> will refuse to push a build containing this
      banner. Set <code>approved</code> to <code>true</code> once the read-through is done.
    </p>
  </div>\n`

  const p = ex.provenance ?? {}
  const routing = (p.routing ?? [])
    .map((r) => `      <tr><th scope="row">${escapeHtml(r.phase)}</th><td>${escapeHtml(r.engine)}</td></tr>`)
    .join('\n')

  const provenance = `  <div class="provenance">
    <h3>How these were produced</h3>
    <div class="table-wrap">
      <table>
        <caption>${escapeHtml(p.sessionLabel ?? '')}</caption>
        <thead><tr><th scope="col">Phase</th><th scope="col">Model</th></tr></thead>
        <tbody>
${routing}
        </tbody>
      </table>
    </div>
    <p>${escapeHtml(p.routingNote ?? '')}</p>
    <p class="provenance-note"><strong>Names have been changed.</strong> ${escapeHtml(p.anonymisation ?? '')} ${escapeHtml(p.selectionNote ?? '')}</p>
  </div>`

  /** One sample, as a card. `body` is trusted generated markup, never input. */
  const sample = (s, body) =>
    !s
      ? ''
      : `  <article class="sample">
    <header class="sample-head">
      <h3>${escapeHtml(s.label)}</h3>
      <p class="sample-note">${escapeHtml(s.note)}</p>
      ${s.meta ? `<p class="sample-meta">${escapeHtml(s.meta)}</p>` : ''}
    </header>
    <div class="sample-body">
${body}
    </div>
    ${s.callout ? `<p class="sample-callout">${escapeHtml(s.callout)}</p>` : ''}
  </article>`

  const list = (items) =>
    `      <ul class="sample-list">\n${items
      .map((t) => `        <li>${inlineHtml(t)}</li>`)
      .join('\n')}\n      </ul>`

  /** A line of the site's own voice sitting inside a sample card. Sans-serif
   *  in the stylesheet, so it never reads as part of the generated prose. */
  const intro = (t) => (t ? `      <p class="sample-intro">${inlineHtml(t)}</p>\n` : '')
  const prose = (paras) => (paras ?? []).map((t) => `      <p>${inlineHtml(t)}</p>`).join('\n')

  const quote = (q) => {
    const attrib = `<footer class="quote-by">— ${escapeHtml(q.speaker)}</footer>`
    const kind = q.kind ? `<span class="quote-kind">${escapeHtml(q.kind)}</span>` : ''
    const context = q.context ? `<p class="quote-context">${escapeHtml(q.context)}</p>` : ''
    // An exchange keeps its turns as separate lines. Flattening it into one
    // string is exactly the failure this output shape exists to avoid: the
    // joke is the back-and-forth, and a single run-on line isn't funny.
    const body = q.exchange?.length
      ? `<div class="quote-turns">${q.exchange
          .map(
            (t) =>
              `<p><b>${escapeHtml(t.speaker)}</b><span>${escapeHtml(t.line)}</span></p>`,
          )
          .join('')}</div>`
      : `<p>${escapeHtml(q.line)}</p>`
    return `        <figure class="quote">${kind}${context}<blockquote>${body}</blockquote>${attrib}</figure>`
  }

  // Two chronicle extracts rather than one long one: a quiet character scene
  // and a combat round demonstrate different things, and a reader deciding
  // whether the prose is any good needs to see both. The second block is
  // optional — drop `secondParagraphs` and the card renders one extract.
  const chronicle = sample(
    ex.chronicle,
    intro(ex.chronicle?.intro) +
      prose(ex.chronicle?.paragraphs) +
      (ex.chronicle?.secondParagraphs?.length
        ? `\n${intro(ex.chronicle.secondIntro)}${prose(ex.chronicle.secondParagraphs)}`
        : ''),
  )

  const condensed = sample(
    ex.condensed,
    `      <p>${inlineHtml(ex.condensed?.narrative ?? '')}</p>\n` +
      `      <p class="sample-subhead">${escapeHtml(ex.condensed?.bulletsLabel ?? '')}</p>\n` +
      `      <ol class="sample-bullets">\n${(ex.condensed?.bullets ?? [])
        .map((t) => `        <li>${inlineHtml(t)}</li>`)
        .join('\n')}\n      </ol>`,
  )

  const jests = sample(ex.jests, list(ex.jests?.items ?? []))
  const gore = sample(ex.gore, list(ex.gore?.items ?? []))
  const quotes = sample(
    ex.quotes,
    `      <div class="quotes">\n${(ex.quotes?.items ?? []).map(quote).join('\n')}\n      </div>`,
  )

  // The whole section, heading and divider included — so an unapproved file
  // leaves no empty <section> with a dangling "Examples" heading above it.
  return `${RUNE}

  <section class="section samples-section" id="examples" aria-labelledby="examples-h">
    <h2 id="examples-h">${escapeHtml(ex.heading ?? 'What it actually writes')}</h2>
    <p class="section-lede">${escapeHtml(ex.lede ?? '')}</p>
${banner}${provenance}
  <div class="samples">
${[chronicle, condensed, jests, gore, quotes].filter(Boolean).join('\n')}
  </div>
  </section>`
}

/**
 * The samples as structured data.
 *
 * `Article` rather than `CreativeWork` so the extract reads as editorial
 * content, and `isBasedOn` pointing at the application so a crawler can see
 * the text is machine-generated output rather than hand-written marketing.
 * Returns null whenever the visible section is absent — structured data
 * describing content that is not on the page is a rich-result violation, not
 * a clever shortcut.
 */
export function examplesJsonLd(ex) {
  if (ex?.approved !== true) return null
  // stripMd, not the raw strings: the samples carry <em>/<strong> for the page,
  // and structured data wants the plain text a search engine would quote.
  const plain = (v) => stripMd([v].flat().filter(Boolean).join('\n\n'))
  const parts = [
    ex.chronicle && {
      name: ex.chronicle.label,
      text: plain([...(ex.chronicle.paragraphs ?? []), ...(ex.chronicle.secondParagraphs ?? [])]),
    },
    ex.condensed && { name: ex.condensed.label, text: plain(ex.condensed.narrative) },
    ex.jests && { name: ex.jests.label, text: plain(ex.jests.items ?? []) },
    ex.gore && { name: ex.gore.label, text: plain(ex.gore.items ?? []) },
  ].filter((p) => p && p.text)
  if (!parts.length) return null
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: 'Sample output from one real tabletop RPG session',
    description:
      'Extracts of a narrative chronicle, a condensed recap, catch-up bullets, jests, combat highlights and memorable quotes, all generated by the Tusk’s Tomes pipeline from a single session recording.',
    url: `${abs('/')}#examples`,
    isBasedOn: { '@type': 'SoftwareApplication', name: SITE.name, url: abs('/') },
    inLanguage: 'en-GB',
    hasPart: parts.map((p) => ({ '@type': 'CreativeWork', name: p.name, text: p.text })),
  }
}

/**
 * The search-facing vocabulary, resolved for one page.
 *
 * This is the deliberate answer to "put the keywords somewhere the reader
 * doesn't have to read". There is a real and generous invisible surface —
 * <title>, meta description, JSON-LD `keywords`/`about`/`audience`, OG tags,
 * alt text, the sitemap — and all of it is fair game. What is NOT fair game is
 * hidden body text: a keyword-stuffed off-screen div is an explicit Google
 * spam-policy violation, the penalty applies to the whole domain rather than
 * the one page, and site.js's own audit flags hidden elements on sight. So the
 * rule this file follows is: invisible METADATA yes, invisible CONTENT never.
 *
 * A page's <title> may legitimately differ from its H1 and usually should. The
 * H1 is written for someone already reading; the title is written for someone
 * scanning ten blue links who has never heard of the project, which means it
 * carries the words they actually typed. `seo.pages` in site/site.json holds
 * those overrides, keyed by slug.
 */
export function seoFor(slug, seo) {
  return (seo?.pages ?? {})[slug] ?? {}
}

/** Deduplicated, comma-joined keyword string for schema.org `keywords`.
 *  Unlike <meta name="keywords"> — which Google has ignored since 2009 and
 *  which is not emitted anywhere in this file — the schema.org property is
 *  read, so it is worth keeping accurate and worth keeping honest. */
export function keywordString(...lists) {
  const seen = new Set()
  for (const k of lists.flat().filter(Boolean)) {
    const t = String(k).trim()
    if (t) seen.add(t)
  }
  return [...seen].join(', ')
}

function landingJsonLd({ video, faq, version, seo }) {
  const app = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: SITE.name,
    alternateName: 'Tusks Tomes',
    applicationCategory: 'MultimediaApplication',
    applicationSubCategory: 'AI transcription and summarisation for tabletop RPGs',
    operatingSystem: 'Windows, macOS, Linux',
    softwareVersion: version,
    keywords: keywordString(seo?.keywords ?? []),
    audience: {
      '@type': 'Audience',
      audienceType:
        seo?.audience ??
        'Game masters, tabletop RPG players, actual-play podcasters and streamers',
    },
    about: (seo?.about ?? []).map((name) => ({ '@type': 'Thing', name })),
    url: abs('/'),
    downloadUrl: `${SITE.repo}/releases`,
    codeRepository: SITE.repo,
    license: `${SITE.repo}/blob/${SITE.branch}/LICENSE`,
    isAccessibleForFree: true,
    description:
      'Local-first, open-source AI session chronicler for D&D, Pathfinder and other tabletop RPGs. Turns session recordings and transcripts into a narrative chronicle, a Discord-ready recap, and curated quote lists.',
    featureList: [
      'Six-phase AI pipeline with name and lore grounding',
      'Per-speaker, per-character transcript attribution',
      'Local Whisper transcription of Craig multi-track Discord recordings',
      'Cloud LLMs (Gemini, Claude, OpenAI) or fully offline local LLMs',
      'DOCX chronicle, condensed recap, quotes, jests and combat highlights',
    ],
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'GBP' },
    image: ogImage(),
  }
  // An empty `keywords: ""` or `about: []` is worse than the absent property:
  // a consumer that trusts the field reads it as "declared, and empty".
  if (!app.keywords) delete app.keywords
  if (!app.about.length) delete app.about

  const site = {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: SITE.name,
    url: abs('/'),
    inLanguage: 'en-GB',
  }
  const graph = [site, app, faqJsonLd(faq)]
  if (video?.id) {
    // Each chapter is declared as a schema.org Clip. This is what Google's
    // "Key Moments" rich result reads: the video can then surface in search
    // with its individual sections listed and separately linkable, which is
    // worth considerably more traffic than a single undifferentiated embed.
    const clips = (video.chapters ?? [])
      .map((c) => {
        const startOffset = parseTimestamp(c.start)
        if (startOffset == null) return null
        const endOffset = parseTimestamp(c.end)
        return {
          '@type': 'Clip',
          name: c.label,
          startOffset,
          ...(endOffset != null ? { endOffset } : {}),
          url: `https://www.youtube.com/watch?v=${video.id}&t=${startOffset}s`,
        }
      })
      .filter(Boolean)

    graph.push({
      '@context': 'https://schema.org',
      '@type': 'VideoObject',
      name: video.title || `${SITE.name} demo`,
      description: video.description || 'Demonstration of the Tusk’s Tomes session chronicler.',
      thumbnailUrl: `https://i.ytimg.com/vi/${video.id}/maxresdefault.jpg`,
      embedUrl: `https://www.youtube-nocookie.com/embed/${video.id}`,
      contentUrl: `https://www.youtube.com/watch?v=${video.id}`,
      ...(video.uploadDate ? { uploadDate: video.uploadDate } : {}),
      ...(video.duration ? { duration: video.duration } : {}),
      ...(clips.length ? { hasPart: clips } : {}),
    })
  }
  return graph.filter(Boolean)
}

/**
 * The documentation index: a filter box over every page, grouped, each entry
 * carrying the one-line summary that already exists as its meta description.
 *
 * Progressive enhancement, and it matters here. The full grouped list is in
 * the HTML — the filter box is the only thing site.js adds, and it is marked
 * hidden until the script claims it. With JavaScript off, or before the script
 * runs, a reader sees every link rather than an inert search box above an
 * empty list. Crawlers see the complete link graph either way, which is the
 * whole point of having an index page.
 *
 * The summaries are not decoration: with 35 pages, titles alone force a reader
 * to guess and backtrack. `data-search` carries title + summary pre-lowercased
 * so filtering never has to touch the DOM's text or allocate per keystroke.
 */
function docsIndexLinks(pages) {
  const groups = new Map(NAV_GROUPS.map((g) => [g.label, []]))
  for (const p of pages) {
    const group = NAV_GROUPS.find((g) => inNavGroup(p, g))
    groups.get(group ? group.label : 'Guides').push(p)
  }

  const rendered = NAV_GROUPS.map(({ label }) => {
    const items = (groups.get(label) ?? []).sort((a, b) => a.title.localeCompare(b.title))
    if (!items.length) return ''
    const lis = items
      .map((p) => {
        const summary = clampDescription(stripMd(p.description), 110)
        const haystack = `${p.title} ${summary}`.toLowerCase()
        return (
          `<li class="doc-item" data-search="${escapeHtml(haystack)}">` +
          `<a href="${SITE.base}/${p.slug}/">${escapeHtml(p.title)}</a>` +
          `<span class="doc-item-note">${escapeHtml(summary)}</span>` +
          `</li>`
        )
      })
      .join('')
    return `<div class="doc-group"><h3>${escapeHtml(label)}</h3><ul>${lis}</ul></div>`
  })
    .filter(Boolean)
    .join('\n')

  // The filter control is NOT emitted here — site.js builds and inserts it.
  //
  // Shipping it in the markup means shipping it either dead (a search box
  // that silently does nothing when the script is blocked) or `hidden`, and
  // a hidden element in published output is the shape of a forgotten note or
  // an injection attempt, which the site audit flags on sight. Rightly: the
  // audit should not have to learn which hidden elements are the good ones.
  //
  // Building it in JS means the control exists exactly when it works.
  return rendered
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

async function walkDir(dir, out = []) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) await walkDir(full, out)
    else out.push(full)
  }
  return out
}

async function copyDir(src, dest) {
  await fs.mkdir(dest, { recursive: true })
  for (const e of await fs.readdir(src, { withFileTypes: true })) {
    const from = path.join(src, e.name)
    const to = path.join(dest, e.name)
    if (e.isDirectory()) await copyDir(from, to)
    else await fs.copyFile(from, to)
  }
}

function sitemap(urls) {
  const entries = urls
    .map(
      ({ loc, priority, changefreq, lastmod }) =>
        `  <url>\n    <loc>${escapeHtml(loc)}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>${changefreq}</changefreq>\n    <priority>${priority}</priority>\n  </url>`,
    )
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`
}

/**
 * Per-source `lastmod` dates, read from git history.
 *
 * Stamping every page with the build date is worse than useless. It tells a
 * crawler that all 33 pages changed on every publish, including ones untouched
 * for months. Google detects the pattern, concludes the field is noise, and
 * falls back to its own recrawl heuristics — so a page that genuinely DID
 * change gets picked up more slowly than if the field were accurate. An honest
 * date on a handful of pages is worth far more than a fresh date on all of them.
 *
 * Dates are resolved in UTC (TZ is forced) and emitted date-only. A `+HH:MM`
 * offset on a public artefact is a geolocation tell.
 *
 * Falls back to the build date whenever git cannot answer — an export with no
 * .git, a file not yet committed, or a working-tree edit that would make the
 * committed date a lie. Those cases are genuinely "changed now".
 */
export function createLastModifiedLookup(root, buildDate, { exec = execFileSync } = {}) {
  const git = (args) =>
    exec('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      // Force UTC so the date cannot vary with the machine's timezone.
      env: { ...process.env, TZ: 'UTC' },
    })

  // Uncommitted paths, collected in one call. A file that is dirty in the
  // working tree is being published in a state no commit describes, so its
  // committed date would understate its freshness.
  const dirty = new Set()
  try {
    const parts = git(['status', '--porcelain', '-z']).split('\0').filter(Boolean)
    for (let i = 0; i < parts.length; i++) {
      const status = parts[i].slice(0, 2)
      dirty.add(norm(parts[i].slice(3)))
      // Rename/copy entries carry a second NUL-terminated field (the source
      // path). Consume it, or it gets parsed as a status code next iteration.
      if (status[0] === 'R' || status[0] === 'C') i++
    }
  } catch {
    // No git, or not a repo. Everything falls back to the build date below.
  }

  const cache = new Map()

  return function lastModified(...relPaths) {
    let newest = null
    for (const rel of relPaths) {
      const key = norm(rel)
      if (!cache.has(key)) cache.set(key, resolveOne(key))
      const date = cache.get(key)
      if (date === null) return buildDate // an unknown date beats a stale one
      if (newest === null || date > newest) newest = date
    }
    return newest ?? buildDate
  }

  function resolveOne(key) {
    if (dirty.has(key)) return null
    try {
      const out = git([
        'log',
        '-1',
        '--format=%cd',
        '--date=format-local:%Y-%m-%d',
        '--',
        key,
      ]).trim()
      // Empty output means the path has no commits (untracked, or a path that
      // only exists in the working tree). Treat that as unknown, not as epoch.
      return /^\d{4}-\d{2}-\d{2}$/.test(out) ? out : null
    } catch {
      return null
    }
  }
}

/**
 * Last line of defence over the *generated* bytes.
 *
 * site-dist/ is gitignored, so `npm run audit:tree` never sees it. The
 * gh-pages push is still scanner-gated, but failing here means the operator
 * finds out at build time instead of at push time.
 */
function verifyOutput(files, root) {
  const findings = []
  // Warns rather than blocking when the list is absent — a contributor must
  // still be able to build the site. The public-push gate is where a missing
  // list is fatal, because only the maintainer pushes there.
  const { names: privateNames, warning } = resolvePrivateNames(root)
  if (warning) console.warn(`  !  ${warning}`)
  const rotationNames = Object.values(loadRotationState(root)?.assignment ?? {})
  for (const { name, content } of files) {
    // Heading-anchor slugs can look like a credential; scanLinesForTokens
    // handles that itself for .html inputs (see stripGeneratedSlugs in
    // scripts/lib/secret-scanner.mjs). Nothing to do here — and nothing to
    // duplicate, which is how the pre-push gate ended up still blocking on a
    // finding the other two gates had already been taught to ignore.
    findings.push(...scanLinesForTokens(name, content))
    findings.push(...scanLinesForEmails(name, content))
    findings.push(...scanLinesForLocalPaths(name, content))
    findings.push(...scanLinesForSpeakerNames(name, content, '', { allowNames: rotationNames }))
    findings.push(...scanLinesForPrivateNames(name, content, privateNames))
  }
  return findings
}

export async function build({ root = process.cwd(), outDir = 'site-dist', quiet = false } = {}) {
  const log = quiet ? () => {} : (...a) => console.log(...a)
  const out = path.resolve(root, outDir)
  // Containment guard, checked BEFORE the recursive delete below. Both `root`
  // and `outDir` are parameters, so a caller passing '..' or '' would aim the
  // delete at the repo root or above it. Refuse anything that is not a strict
  // subdirectory of root. (The incident this rule exists for: a test called
  // fs.rm on the user's real sibling lore folder and deleted it.)
  const outRel = path.relative(root, out)
  if (!outRel || outRel.startsWith('..') || path.isAbsolute(outRel)) {
    throw new Error(`refusing to clean "${out}" — outDir must be a subdirectory of ${root}`)
  }
  // allowlist:dangerous-fs-rm
  await fs.rm(out, { recursive: true, force: true })
  await fs.mkdir(out, { recursive: true })

  const siteCfg = JSON.parse(await fs.readFile(path.join(root, 'site', 'site.json'), 'utf8'))
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
  // Sample output lives in its own file rather than in site.json because it
  // carries a human approval flag: keeping it separate means the review is a
  // review of one small file, not of a diff buried in the site's whole config.
  const examples = JSON.parse(
    await fs.readFile(path.join(root, 'site', 'examples.json'), 'utf8'),
  )
  const seo = siteCfg.seo ?? {}
  const previewUnapproved = process.env.SITE_PREVIEW_UNAPPROVED === '1'

  // Poster images are referenced by path in site.json; a typo would otherwise
  // ship as a broken image on the homepage. Check them before doing any work.
  for (const poster of [
    siteCfg.video?.poster,
    ...(siteCfg.video?.chapters ?? []).map((c) => c.poster),
  ].filter(Boolean)) {
    await fs.access(path.join(root, poster)).catch(() => {
      throw new Error(`site.json references a poster image that does not exist: ${poster}`)
    })
  }

  // --- collect pages -------------------------------------------------------
  const docFiles = (await walkDir(path.join(root, 'docs')))
    .map((f) => norm(path.relative(root, f)))
    .filter((f) => /\.md$/i.test(f))
    .sort()

  const skipped = []
  const sources = []
  for (const rel of docFiles) {
    if (!isPublishable(rel)) {
      skipped.push(rel)
      continue
    }
    sources.push({ src: rel, slug: slugForDoc(rel) })
  }
  for (const { src, slug } of ROOT_PAGES) {
    if (!isPublishable(src)) {
      skipped.push(src)
      continue
    }
    sources.push({ src, slug })
  }

  // Fail loudly rather than silently shipping a dev-only doc: if the scanner
  // registry ever stops matching, this is the tripwire.
  for (const { src } of sources) {
    if (checkForbiddenFilenames([src]).length > 0) {
      throw new Error(`refusing to publish forbidden file: ${src}`)
    }
  }

  const pages = []
  for (const s of sources) {
    const md = await fs.readFile(path.join(root, s.src), 'utf8')
    const meta = extractMeta(md)
    // `title` is the on-page H1 and the breadcrumb. `searchTitle` and
    // `searchDescription` are what the <title> tag and meta description carry,
    // and they are allowed to differ — see seoFor() for why that is a feature
    // rather than a discrepancy. Absent an override they are the same string.
    const override = seoFor(s.slug, seo)
    const title = meta.title || slugForDoc(s.src).split('/').pop()
    const description =
      meta.description || `${SITE.name} documentation — ${meta.title || s.src}.`
    pages.push({
      ...s,
      md,
      title,
      description,
      searchTitle: override.title ?? null,
      searchDescription: override.description ?? description,
      keywords: override.keywords ?? [],
      howTo: override.howTo ?? null,
    })
  }
  pages.sort((a, b) => a.slug.localeCompare(b.slug))

  // --- render doc pages ----------------------------------------------------
  const written = []
  for (const page of pages) {
    const { html: bodyHtml, toc } = await renderMarkdown(page.md, page.src)
    page.toc = toc
    // A HowTo step whose `url` points at an anchor that no longer exists is
    // the worst kind of structured-data bug: the page renders perfectly, the
    // markup validates, and the only symptom is a rich result that drops its
    // steps or deep-links a reader to nowhere. Heading text drifts — someone
    // renames "Stage 2" — so the anchors are checked against what actually
    // rendered rather than trusted.
    const anchors = new Set(toc.map((t) => t.id))
    for (const step of page.howTo?.steps ?? []) {
      if (step.anchor && !anchors.has(step.anchor)) {
        throw new Error(
          `site.json → seo.pages["${page.slug}"].howTo step "${step.name}" targets #${step.anchor}, ` +
            `which is not a heading on that page. Headings are: ${[...anchors].join(', ') || '(none)'}`,
        )
      }
    }
    const html = docPage({ page, bodyHtml, pages })
    const dest = path.join(out, ...page.slug.split('/'), 'index.html')
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.writeFile(dest, html, 'utf8')
    written.push({ name: `${page.slug}/index.html`, content: html })
  }

  // --- landing page --------------------------------------------------------
  // Strip HTML comments BEFORE substituting. Two reasons, one of which is a
  // real bug this prevents: substitution is a whole-file string replace, so a
  // comment that documents the placeholder names would have those names
  // expanded too — silently duplicating the entire <head> and FAQ into a
  // comment. Stripping first makes that impossible, and keeps source notes
  // out of the bytes visitors download.
  const template = (
    await fs.readFile(path.join(root, 'site', 'index.template.html'), 'utf8')
  ).replace(/<!--[\s\S]*?-->/g, '')
  // Both strings live in site/site.json so the search-facing copy can be tuned
  // without touching code — and so the reason they differ from the page's own
  // H1 is documented next to them rather than inferred from a diff.
  const landingTitle = seo.landing?.title ?? "Tusk's Tomes — AI D&D Session Recap & Chronicle Generator"
  const landingDesc =
    seo.landing?.description ??
    'Turn a D&D, Pathfinder or any TTRPG session recording into a polished narrative chronicle and Discord-ready recap. Free, open source, runs on your own machine.'
  const landing = template
    .replaceAll('{{HEAD}}', head({
      title: landingTitle,
      description: landingDesc,
      canonical: abs('/'),
      jsonLd: [
        ...landingJsonLd({ video: siteCfg.video, faq: siteCfg.faq, version: pkg.version, seo }),
        examplesJsonLd(examples),
      ],
    }))
    .replaceAll('{{SVG_DEFS}}', SVG_DEFS)
    .replaceAll('{{EMBER_FIELD}}', EMBER_FIELD)
    .replaceAll(
      '{{HEADER}}',
      siteHeader([
        { href: '#routes', label: 'Two ways in' },
        ...(examples.approved === true || previewUnapproved
          ? [{ href: '#examples', label: 'Examples' }]
          : []),
        { href: '#requirements', label: 'What you need' },
        { href: '#how', label: 'How it works' },
        { href: `${SITE.base}/docs/`, label: 'Docs' },
      ]),
    )
    .replaceAll('{{RUNE}}', RUNE)
    .replaceAll('{{VIDEO}}', videoBlock(siteCfg.video))
    .replaceAll('{{CHAPTERS}}', chaptersBlock(siteCfg.video))
    .replaceAll('{{FAQ}}', faqBlock(siteCfg.faq))
    // Renders to the empty string — section, heading, divider and all — while
    // site/examples.json has `approved: false`. See examplesBlock().
    .replaceAll('{{EXAMPLES}}', examplesBlock(examples, { preview: previewUnapproved }))
    .replaceAll('{{DOCS_LINKS}}', docsIndexLinks(pages))
    .replaceAll('{{BASE}}', SITE.base)
    .replaceAll('{{REPO}}', SITE.repo)
    .replaceAll('{{VERSION}}', pkg.version)
    // {{CLIP:<slug>}} — one chapter of the demo video, placed inline next to
    // the step it illustrates. Unknown slugs throw rather than rendering
    // nothing, so a typo can't silently drop a video from the page.
    .replace(/\{\{CLIP:([a-z0-9-]+)\}\}/g, (_m, slug) => {
      const chapter = (siteCfg.video?.chapters ?? []).find((c) => c.slug === slug)
      if (!chapter) {
        throw new Error(
          `landing page references {{CLIP:${slug}}} but site/site.json has no video chapter with that slug`,
        )
      }
      if (siteCfg.video?.id && chapter.start != null && parseTimestamp(chapter.start) == null) {
        throw new Error(`video chapter "${slug}" has an unparseable start timestamp: ${chapter.start}`)
      }
      return clipBlock(siteCfg.video, chapter)
    })
  // A mistyped placeholder would otherwise ship as literal braces on the
  // homepage. Cheap assertion, catches it at build time.
  const leftover = landing.match(/\{\{[A-Z_]+\}\}/g)
  if (leftover) throw new Error(`unsubstituted placeholder(s) in landing page: ${[...new Set(leftover)].join(', ')}`)
  await fs.writeFile(path.join(out, 'index.html'), landing, 'utf8')
  written.push({ name: 'index.html', content: landing })

  // --- 404 -----------------------------------------------------------------
  const notFound = `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Page not found — ${escapeHtml(SITE.name)}</title>
<meta name="robots" content="noindex, follow">
<link rel="stylesheet" href="${SITE.base}/styles.css">
</head>
<body class="docs">
<div class="docs-layout"><main id="main"><article class="prose">
<h1>Page not found</h1>
<p>That page doesn't exist. Try the <a href="${SITE.base}/docs/">documentation index</a> or the <a href="${SITE.base}/">home page</a>.</p>
</article></main></div>
</body>
</html>
`
  await fs.writeFile(path.join(out, '404.html'), notFound, 'utf8')

  // --- static assets -------------------------------------------------------
  await fs.copyFile(path.join(root, 'site', 'styles.css'), path.join(out, 'styles.css'))
  // External so the CSP can be `script-src 'self'` with no 'unsafe-inline'.
  await fs.copyFile(path.join(root, 'site', 'site.js'), path.join(out, 'site.js'))
  await fs.copyFile(path.join(root, 'public', 'favicon.svg'), path.join(out, 'favicon.svg'))
  await copyDir(path.join(root, 'docs', 'assets'), path.join(out, 'docs', 'assets'))
  // Self-hosted OFL fonts. LICENSES.txt travels with them — the OFL requires
  // the licence to accompany redistributed font files.
  await copyDir(path.join(root, 'site', 'assets'), path.join(out, 'assets'))
  // Without .nojekyll, GitHub Pages runs Jekyll and silently drops files and
  // folders whose names begin with an underscore.
  await fs.writeFile(path.join(out, '.nojekyll'), '', 'utf8')

  // Google Search Console file verification. Generated rather than committed
  // as a loose asset so it cannot be lost on a future republish — the property
  // silently un-verifies if the file stops being served, and Search Console
  // just quietly stops reporting rather than telling you why.
  if (SITE.googleVerificationFile) {
    if (!/^google[a-z0-9]+\.html$/.test(SITE.googleVerificationFile)) {
      // A typo here fails verification with no error anywhere — Google reports
      // "file not found" and the build looks perfectly healthy. Fail loudly.
      throw new Error(
        `googleVerificationFile must look like "google<token>.html", got "${SITE.googleVerificationFile}"`,
      )
    }
    await fs.writeFile(
      path.join(out, SITE.googleVerificationFile),
      `google-site-verification: ${SITE.googleVerificationFile}\n`,
      'utf8',
    )
  }

  // --- sitemap + robots ----------------------------------------------------
  // Date-only, UTC. A full timestamp would carry a +HH:MM offset, which is a
  // geolocation tell on an otherwise anonymous project.
  const buildDate = new Date().toISOString().slice(0, 10)
  const lastModified = createLastModifiedLookup(root, buildDate)
  const urls = [
    {
      loc: abs('/'),
      priority: '1.0',
      changefreq: 'weekly',
      // The landing page is assembled from the template and the content data,
      // so it is as fresh as the newer of the two.
      lastmod: lastModified('site/index.template.html', 'site/site.json'),
    },
    // Priority is a hint about relative importance WITHIN this site, not a
    // ranking lever — Google treats an all-1.0 sitemap as no signal at all.
    // So the two pathway pages, which are what someone searching for "D&D
    // transcriber" should land on, sit above the reference docs, and the
    // reference docs stay honest at 0.6.
    ...pages.map((p) => ({
      loc: abs(`/${p.slug}/`),
      priority: seoFor(p.slug, seo).priority ?? (p.slug === 'docs' ? '0.8' : '0.6'),
      changefreq: 'monthly',
      lastmod: lastModified(p.src),
    })),
  ]
  await fs.writeFile(path.join(out, 'sitemap.xml'), sitemap(urls), 'utf8')
  // NOTE: on a GitHub *project* page this file sits at /Tusks-Tomes/robots.txt
  // and crawlers ignore it — robots.txt is only honoured at the domain root,
  // which belongs to the kochitusker.github.io repo. It is emitted anyway so
  // the site is correct behind a custom domain. Submit the sitemap URL
  // directly in Google Search Console; that is what actually gets it read.
  // AI crawlers are named EXPLICITLY rather than left to the wildcard. Many
  // sites block these; this project wants the opposite — being answerable
  // inside ChatGPT/Claude/Perplexity is how a niche tool gets found now, and
  // the content is MIT-licensed documentation we actively want quoted. Naming
  // each agent also documents the intent, so nobody later assumes the wildcard
  // was an oversight.
  const AI_AGENTS = [
    'GPTBot', // OpenAI — ChatGPT browsing + training
    'OAI-SearchBot', // OpenAI — ChatGPT search index
    'ChatGPT-User', // OpenAI — user-initiated fetches
    'ClaudeBot', // Anthropic — crawling
    'Claude-User', // Anthropic — user-initiated fetches
    'anthropic-ai',
    'PerplexityBot',
    'Perplexity-User',
    'Google-Extended', // Gemini grounding (separate from Googlebot)
    'Applebot-Extended',
    'CCBot', // Common Crawl — feeds many open models
    'Bytespider',
    'cohere-ai',
    'Meta-ExternalAgent',
  ]
  await fs.writeFile(
    path.join(out, 'robots.txt'),
    `# Everything here is public documentation for an MIT-licensed project.\n` +
      `# Crawl it, index it, quote it.\n\n` +
      `User-agent: *\nAllow: /\n\n` +
      AI_AGENTS.map((a) => `User-agent: ${a}\nAllow: /`).join('\n\n') +
      `\n\nSitemap: ${abs('/sitemap.xml')}\n`,
    'utf8',
  )

  // llms.txt — the emerging convention (llmstxt.org) for handing an LLM a
  // curated map of a site in markdown, instead of making it infer structure
  // from rendered HTML. Cheap to emit, and it costs nothing if ignored.
  const llmsTxt =
    `# ${SITE.name}\n\n` +
    `> Local-first, open-source AI session chronicler for D&D, Pathfinder and other tabletop RPGs. ` +
    `Turns a session recording or transcript into a narrative chronicle, a session summary, and ` +
    `curated quote lists — grounded in the user's own glossary of campaign names and lore. ` +
    `Runs on the user's own machine; no subscription, no account, no telemetry. MIT licensed.\n\n` +
    `Key facts an assistant is likely to be asked:\n` +
    `- Cost: free software. Roughly £1–£2 of the user's own LLM API credit per 3-hour session, ` +
    `or £0 using a local model or an existing Claude Code / ChatGPT subscription.\n` +
    `- Inputs: pasted text, YouTube .sbv captions, .docx/.pdf notes, or Craig multi-track Discord recordings.\n` +
    `- Requirements: Node.js 20+. Python 3.10–3.12 only for the optional audio add-on.\n` +
    `- Privacy: audio is transcribed locally and never uploaded. Only transcript text goes to the chosen AI provider.\n` +
    `- Platform: developed and tested on Windows; Linux and macOS are untested.\n\n` +
    `## Documentation\n\n` +
    pages
      .map((p) => `- [${p.title}](${abs(`/${p.slug}/`)}): ${p.description}`)
      .join('\n') +
    `\n\n## Source\n\n- [GitHub repository](${SITE.repo})\n` +
    `\nThe full text of every page above is available as a single file: ` +
    `${abs('/llms-full.txt')}\n`
  await fs.writeFile(path.join(out, 'llms.txt'), llmsTxt, 'utf8')

  // llms-full.txt — the same documentation as one markdown file. llms.txt is
  // a map and still costs a crawler 32 fetches to actually read anything;
  // this is the whole corpus in one request, which is what the retrieval side
  // of an assistant actually wants. Emitted from `page.md`, the same source
  // the HTML is rendered from, so the two can never disagree.
  //
  // Source paths are included per section. When an assistant cites a claim,
  // that gives it something checkable to point at rather than a bare URL.
  //
  // The per-section header is deliberately VISIBLE text, not an HTML comment.
  // A comment is stripped by every markdown renderer, so the attribution would
  // vanish exactly when a model is reading the file as markdown — and hidden
  // text in a published artefact is the shape of a prompt-injection trick,
  // which the site audit flags on sight and rightly so.
  const llmsFull =
    `# ${SITE.name} — complete documentation\n\n` +
    `> Generated from the project's own markdown. Canonical HTML: ${abs('/')}\n` +
    `> Map of individual pages: ${abs('/llms.txt')}\n` +
    `> Licence: MIT. This documentation may be quoted and indexed freely.\n\n` +
    pages
      .map(
        (p) =>
          `---\n\n` +
          `**Page:** ${abs(`/${p.slug}/`)}  \n` +
          `**Source:** \`${norm(p.src)}\`\n\n` +
          `${p.md.trim()}\n`,
      )
      .join('\n')
  await fs.writeFile(path.join(out, 'llms-full.txt'), llmsFull, 'utf8')

  // --- verify --------------------------------------------------------------
  const findings = verifyOutput(written, root)
  if (findings.length) {
    for (const f of findings) console.error(`  ✖ ${f.file}: ${f.detail ?? f.rule ?? 'finding'}`)
    throw new Error(`generated site failed the personal-info/secret scan (${findings.length} findings)`)
  }

  log(`Built ${pages.length + 1} pages → ${path.relative(root, out) || out}`)
  log(`  landing:  ${abs('/')}`)
  log(`  docs:     ${pages.length}`)
  if (skipped.length) log(`  excluded: ${skipped.join(', ')}`)
  if (!siteCfg.video?.id) log('  video:    not set (site/site.json → video.id) — placeholder rendered')
  if (examples.approved === true) {
    log('  samples:  approved — sample output section published')
  } else if (previewUnapproved) {
    log('  samples:  NOT approved — rendered for local review only. THIS BUILD CANNOT BE PUBLISHED.')
  } else {
    log('  samples:  NOT approved (site/examples.json → approved) — section omitted')
    log('            to read them in place: SITE_PREVIEW_UNAPPROVED=1 npm run site:preview')
  }
  return { pages, skipped, out }
}

// Run only when invoked directly, so the test file can import the helpers.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  build().catch((err) => {
    console.error(err.message)
    process.exit(1)
  })
}
