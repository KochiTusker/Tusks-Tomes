// Pre-processes a markdown string so that every H2 section is wrapped in
// a <details><summary><h2>...</h2></summary><div>...</div></details> block.
// Combined with react-markdown + rehype-raw, this gives us collapsible
// sections that work identically on GitHub (which renders <details>
// natively) and in-app (where the same elements get styled as cards via
// CSS in index.css under `details.docs-section { ... }`).
//
// Why programmatic wrapping instead of asking authors to write <details>
// by hand in every .md? Two reasons: (1) authors keep writing normal
// markdown `## Heading` syntax that's easier to edit, (2) docs that are
// already restructured with <details> blocks pass through unchanged
// because we detect that case and skip the auto-wrap.
//
// The wrap is intentionally conservative:
//   - Only top-level `## ` headings trigger a section boundary.
//   - The preamble (everything before the first H2) is left as-is so the
//     doc title, intro paragraph, and any TOC stay visible.
//   - H2s inside fenced code blocks are NOT split (we track ``` fences).
//   - Documents that already contain a <details> element are passed
//     through unchanged.

const FENCE_RE = /^```/

export function wrapH2SectionsInDetails(md: string): string {
  // Hands-off: doc author already structured this file with <details>.
  if (/<details[\s>]/i.test(md)) return md

  const lines = md.split('\n')
  const out: string[] = []
  let inFence = false
  let sectionDepth = 0 // 0 = preamble, 1 = inside a section

  const closeSection = () => {
    if (sectionDepth > 0) {
      out.push('', '</div>', '</details>', '')
      sectionDepth = 0
    }
  }

  for (const line of lines) {
    // Track fenced code blocks — ``` toggles the fence state. Headings
    // inside fences are content, not section breaks.
    if (FENCE_RE.test(line)) {
      inFence = !inFence
      out.push(line)
      continue
    }

    const h2 = !inFence && line.match(/^##\s+(.+?)\s*$/)
    if (h2) {
      // Close the previous section's body before opening the next one.
      closeSection()
      // Strip trailing punctuation hidden in headings like "## Foo:". The
      // raw text is fine for both GitHub and our card renderer, so we
      // preserve it verbatim — just escape angle brackets in the (rare)
      // case the heading contains them.
      const heading = h2[1].replace(/</g, '&lt;').replace(/>/g, '&gt;')
      out.push('<details class="docs-section">')
      out.push(`<summary><h2>${heading}</h2></summary>`)
      out.push('<div class="docs-section-body">')
      out.push('')
      sectionDepth = 1
    } else {
      out.push(line)
    }
  }
  closeSection()
  return out.join('\n')
}
