// Pre-processes a markdown string so that GitHub-style alert blockquotes
// render as coloured callouts in the in-app Help tab.
//
// The docs use GitHub's alert syntax as their ONLY highlighting mechanism —
// there are no emoji section markers any more, so colour carries the weight
// that a 🚨 or ✅ used to:
//
//     > [!CAUTION]     red     — warnings; something can break or cost money
//     > [!WARNING]     orange  — notices; a caveat worth reading before acting
//     > [!TIP]         green   — streamlined; a thing that got easier or faster
//     > [!NOTE]        blue    — neutral aside
//     > [!IMPORTANT]   purple  — load-bearing detail that is easy to miss
//
// Why a transform rather than styling <blockquote> directly: GitHub renders
// this syntax natively with exactly these colours, so the same .md file is
// already correct when read on github.com. Neither react-markdown nor
// remark-gfm implements it, though — there, `> [!CAUTION]` degrades to an
// ordinary grey blockquote whose first line reads "[!CAUTION]". Rewriting the
// block into a <div class="docs-alert …"> recovers the colour in-app without
// adding a dependency.
//
// Why <div class> specifically: DocsViewer sanitises raw HTML through
// SAFE_HTML_SCHEMA, which allows `class` on div (and on details/summary) and
// on nothing else. A <span style="color:red"> would be silently stripped of
// its style and render as flat text — so div+class is not a stylistic
// preference here, it is the only thing that survives the sanitiser.
//
// The static site build applies the same rewrite in
// scripts/site/build-site.mjs; the two are kept in sync by
// docsAlerts.test.ts, which asserts both produce the same class names.

/** Alert kinds GitHub recognises, lowercased for use in a class name. */
const ALERT_KINDS = ['note', 'tip', 'important', 'warning', 'caution'] as const

export type AlertKind = (typeof ALERT_KINDS)[number]

/** Matches the opening marker line of an alert blockquote: `> [!CAUTION]`. */
const ALERT_OPEN_RE = /^>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i

/** Matches any blockquote continuation line, including a bare `>`. */
const BLOCKQUOTE_LINE_RE = /^>(\s?)(.*)$/

const FENCE_RE = /^```/

/** Human-facing label rendered as the callout's heading. */
const ALERT_LABEL: Record<AlertKind, string> = {
  note: 'Note',
  tip: 'Streamlined',
  important: 'Important',
  warning: 'Notice',
  caution: 'Warning',
}

/**
 * Rewrite every GitHub alert blockquote into a titled <div> callout.
 *
 * Content inside the alert stays markdown — it is re-parsed by the markdown
 * renderer, so links, `code`, lists and emphasis all keep working. The blank
 * lines around the inner block are required: without them a markdown parser
 * treats the contents of an HTML block as literal text.
 *
 * Alerts inside fenced code blocks are left alone, so a doc can show the
 * syntax without the example being eaten.
 */
export function renderDocsAlerts(md: string): string {
  // Split on either ending and rejoin with \n. On Windows, git's autocrlf
  // leaves CRLF in the working tree, and a trailing \r breaks the body match:
  // `.` in a JS regex does NOT match \r (it is a line terminator), so
  // /^>(\s?)(.*)$/ fails on "> text\r" and the quote markers survive into the
  // rendered output. Normalising here rather than loosening every pattern
  // keeps the matching rules simple and makes the ending irrelevant
  // downstream — the result is transient markdown handed to a renderer, never
  // written back to disk.
  const lines = md.split(/\r?\n/)
  const out: string[] = []
  let inFence = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (FENCE_RE.test(line)) {
      inFence = !inFence
      out.push(line)
      continue
    }

    const open = !inFence && line.match(ALERT_OPEN_RE)
    if (!open) {
      out.push(line)
      continue
    }

    const kind = open[1].toLowerCase() as AlertKind

    // Consume the rest of the blockquote — every following line that is
    // still part of it. A line that is not a blockquote line ends the alert.
    const body: string[] = []
    let j = i + 1
    for (; j < lines.length; j++) {
      const m = lines[j].match(BLOCKQUOTE_LINE_RE)
      if (!m) break
      body.push(m[2])
    }
    // Step the outer loop to the last consumed line; the `for` increments it.
    i = j - 1

    // Trailing blank lines inside the quote add stray <p> tags.
    while (body.length > 0 && body[body.length - 1].trim() === '') body.pop()

    out.push(`<div class="docs-alert docs-alert-${kind}">`)
    out.push(`<div class="docs-alert-label">${ALERT_LABEL[kind]}</div>`)
    out.push('')
    out.push(...body)
    out.push('')
    out.push('</div>')
  }

  return out.join('\n')
}
