// docx → markdown conversion.
//
// AI models read .docx by first having someone unzip the OOXML, strip the
// inline namespace junk, and extract the body text. The simpler that
// extraction, the cleaner the tokens. Two practical levels:
//
//   - `mammoth.extractRawText` — pulls only the visible characters, no
//     structural information (headings collapse to plain paragraphs, lists
//     lose their bullets, tables flatten). Cheapest, but a heading-heavy
//     campaign-bible loses navigation cues the model would otherwise use.
//
//   - `mammoth.convertToHtml` → turndown → markdown — preserves heading
//     levels, lists, tables, and emphasis. Costs ~30KB of dependency
//     (turndown is MIT, no transitive deps) plus a small CPU bump for
//     the HTML→md walk. The output is structured markdown the chronicle
//     pipeline can use directly.
//
// We pick markdown for everything that flows into AI context (KB lookups
// during the run, ad-hoc /api/parse/docx requests). Plain-text extraction
// stays available for callers that explicitly need it.

import mammoth from 'mammoth'
import TurndownService from 'turndown'
import { promoteHeadings } from './headingPromotion.js'

let cachedTurndown: TurndownService | null = null

function turndown(): TurndownService {
  if (cachedTurndown) return cachedTurndown
  const td = new TurndownService({
    headingStyle: 'atx', // # H1 instead of underline-style, easier for LLMs to parse
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '_',
    strongDelimiter: '**',
  })
  // Tables: turndown's default drops them. Add a minimal pipe-table renderer
  // so a tabular party-roster lore doc keeps its row structure.
  td.addRule('table', {
    filter: 'table',
    replacement: (_content, node) => {
      const rows = Array.from((node as HTMLTableElement).rows ?? [])
      if (rows.length === 0) return ''
      const cellsFor = (r: HTMLTableRowElement) =>
        Array.from(r.cells).map((c) => (c.textContent ?? '').trim().replace(/\|/g, '\\|'))
      const header = cellsFor(rows[0])
      const lines = [
        `| ${header.join(' | ')} |`,
        `| ${header.map(() => '---').join(' | ')} |`,
      ]
      for (const r of rows.slice(1)) lines.push(`| ${cellsFor(r).join(' | ')} |`)
      return `\n\n${lines.join('\n')}\n\n`
    },
  })
  cachedTurndown = td
  return td
}

/** Convert a .docx file buffer to markdown. Falls back to extractRawText
 *  on mammoth/turndown errors so a corrupt file degrades gracefully
 *  instead of crashing the whole document scan. */
export async function docxBufferToMarkdown(buffer: Buffer): Promise<string> {
  try {
    const html = await mammoth.convertToHtml({ buffer })
    const md = turndown().turndown(html.value)
    // Mammoth can emit large empty-paragraph runs; collapse 3+ blank lines.
    const collapsed = md.replace(/\n{3,}/g, '\n\n').trim()
    // Promote heading-shaped paragraphs to H1s. Recovers section structure
    // when the docx author styled headings as bold/large text rather than
    // via Word's Heading styles — without this the converted markdown loses
    // every section anchor, and downstream Phase 3 retrieval has nothing
    // to ground against. No-op when the document already has `#` headings.
    return promoteHeadings(collapsed)
  } catch (err) {
    console.warn('[docxToMarkdown] convertToHtml failed, falling back to raw text:', err)
    const raw = await mammoth.extractRawText({ buffer })
    return promoteHeadings(raw.value)
  }
}
