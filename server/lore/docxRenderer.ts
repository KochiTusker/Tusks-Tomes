// Render a chronicle (full or condensed) plus the Gallery of Jests / Gore
// / Quotes as a .docx Buffer, using the `docx` npm package.
//
// Both save modes carry the same extras — the user's request was
// explicit on that: "Both versions have the Gallery of Jests and Gore
// and the funny quotes." The difference is the body:
//   - mode='full'      → the full Phase 3 chronicle, followed by the
//                        condensed chronicle + catch-up recap when those
//                        exist. "Full" means everything that was
//                        generated: Chronicle, Condensed, Recap, Jests,
//                        Gore, Quotes.
//   - mode='condensed' → only the condensed narrative + recap (plus the
//                        same extras), for a leaner hand-out.

import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from 'docx'

// Mirrors src/types.ts `Quote` — the server does not import from the client
// tree. `exchange` carries a multi-speaker back-and-forth; when it is set,
// `speaker` is the participant list and `line` a flattened fallback.
export type QuoteTurn = {
  speaker: string
  line: string
}

export type Quote = {
  speaker: string
  line: string
  kind?: 'funny' | 'stupid' | 'dark'
  exchange?: QuoteTurn[]
  context?: string
}

export type ExtrasOutput = {
  jests: string[]
  gore: string[]
  quotes: Quote[]
}

export type CondenseOutput = {
  narrative: string
  bulletPoints: string[]
}

export type ChronicleDocxArgs = {
  campaign: string
  sessionNumber: number
  chronicle: string
  extras: ExtrasOutput | null
  condensed: CondenseOutput | null
  /** 'full' uses the long Phase 3 chronicle; 'condensed' uses Phase 6. */
  mode: 'full' | 'condensed'
}

function heading(text: string, level: (typeof HeadingLevel)[keyof typeof HeadingLevel]): Paragraph {
  return new Paragraph({
    heading: level,
    spacing: { before: 240, after: 120 },
    children: [new TextRun({ text })],
  })
}

function body(text: string): Paragraph[] {
  // docx paragraphs are one per visible break. Split on blank lines so
  // the original chronicle's paragraph rhythm survives.
  const blocks = text.replace(/\r\n/g, '\n').split(/\n{2,}/)
  return blocks
    .map((b) => b.trim())
    .filter((b) => b.length > 0)
    .map((b) =>
      new Paragraph({
        spacing: { after: 160 },
        children: [new TextRun({ text: b })],
      })
    )
}

function bullet(text: string, indent = 0): Paragraph {
  return new Paragraph({
    bullet: { level: indent },
    spacing: { after: 80 },
    children: [new TextRun({ text })],
  })
}

function turnParagraph(t: QuoteTurn, level: number): Paragraph {
  return new Paragraph({
    bullet: { level },
    spacing: { after: 80 },
    children: [
      new TextRun({ text: `${t.speaker}: `, bold: true }),
      new TextRun({ text: `"${t.line}"`, italics: true }),
    ],
  })
}

/** A single-line quote is one bullet. An exchange gets a participant header
 *  with each turn indented beneath it, so the back-and-forth reads in order
 *  on the page rather than as one run-on line. */
function quoteParagraphs(q: Quote): Paragraph[] {
  if (!q.exchange?.length) {
    const paras = [turnParagraph(q, 0)]
    if (q.context) paras.push(contextParagraph(q.context, 1))
    return paras
  }
  const head = new Paragraph({
    bullet: { level: 0 },
    spacing: { after: 80 },
    children: [new TextRun({ text: q.speaker, bold: true })],
  })
  const paras = [head]
  if (q.context) paras.push(contextParagraph(q.context, 1))
  paras.push(...q.exchange.map((t) => turnParagraph(t, 1)))
  return paras
}

function contextParagraph(context: string, level: number): Paragraph {
  return new Paragraph({
    bullet: { level },
    spacing: { after: 80 },
    children: [new TextRun({ text: context, italics: true, color: '6B6B6B' })],
  })
}

export async function renderChronicleDocx(args: ChronicleDocxArgs): Promise<Buffer> {
  const { campaign, sessionNumber, chronicle, extras, condensed, mode } = args

  const children: Paragraph[] = []

  // Title block — campaign / session / mode / date.
  children.push(
    new Paragraph({
      heading: HeadingLevel.TITLE,
      spacing: { after: 60 },
      children: [
        new TextRun({
          text: `${campaign || 'Campaign'} — Session ${sessionNumber}`,
        }),
      ],
    })
  )
  children.push(
    new Paragraph({
      spacing: { after: 240 },
      children: [
        new TextRun({
          text: `${mode === 'condensed' ? 'Condensed chronicle' : 'Full chronicle'} · saved ${new Date().toISOString().slice(0, 10)}`,
          italics: true,
          color: '6B6B6B',
        }),
      ],
    })
  )

  // Body — full chronicle prose OR condensed narrative + bullet recap.
  if (mode === 'condensed' && condensed) {
    if (condensed.narrative.trim()) {
      children.push(heading('Condensed Chronicle', HeadingLevel.HEADING_1))
      children.push(...body(condensed.narrative))
    }
    if (condensed.bulletPoints.length) {
      children.push(heading('Catch-up Recap', HeadingLevel.HEADING_1))
      for (const point of condensed.bulletPoints) {
        children.push(bullet(point))
      }
    }
    if (!condensed.narrative.trim() && !condensed.bulletPoints.length) {
      // Condensed mode requested but no condensed output — fall back to
      // the full chronicle so we never write a contentless file.
      children.push(heading('Chronicle', HeadingLevel.HEADING_1))
      children.push(...body(chronicle || '(empty)'))
    }
  } else {
    children.push(heading('Chronicle', HeadingLevel.HEADING_1))
    children.push(...body(chronicle || '(empty)'))
    // "Full" carries the condensed forms too when they were generated, so a
    // single full export is the complete record (Chronicle + Condensed +
    // Recap + extras) rather than forcing a second condensed-only download.
    if (condensed?.narrative.trim()) {
      children.push(heading('Condensed Chronicle', HeadingLevel.HEADING_1))
      children.push(...body(condensed.narrative))
    }
    if (condensed?.bulletPoints.length) {
      children.push(heading('Catch-up Recap', HeadingLevel.HEADING_1))
      for (const point of condensed.bulletPoints) {
        children.push(bullet(point))
      }
    }
  }

  // Extras — same in both modes per the spec.
  if (extras) {
    if (extras.jests.length) {
      children.push(heading('Gallery of Jests', HeadingLevel.HEADING_1))
      for (const j of extras.jests) children.push(bullet(j))
    }
    if (extras.gore.length) {
      children.push(heading('Gallery of Gore', HeadingLevel.HEADING_1))
      for (const g of extras.gore) children.push(bullet(g))
    }
    if (extras.quotes.length) {
      children.push(heading('Memorable Quotes', HeadingLevel.HEADING_1))
      const groups = {
        funny: extras.quotes.filter((q) => (q.kind ?? 'funny') === 'funny'),
        stupid: extras.quotes.filter((q) => q.kind === 'stupid'),
        dark: extras.quotes.filter((q) => q.kind === 'dark'),
      }
      for (const [label, list] of [
        ['Funny', groups.funny],
        ['Stupid', groups.stupid],
        ['Dark', groups.dark],
      ] as const) {
        if (!list.length) continue
        children.push(heading(label, HeadingLevel.HEADING_2))
        for (const q of list) children.push(...quoteParagraphs(q))
      }
    }
  }

  const doc = new Document({
    creator: 'Tusk\'s Tomes',
    title: `${campaign || 'Campaign'} — Session ${sessionNumber}`,
    description: mode === 'condensed' ? 'Condensed session chronicle' : 'Full session chronicle',
    sections: [{ children }],
  })

  // docx@9: Packer.toBuffer returns a Promise<Buffer>.
  return Packer.toBuffer(doc)
}
