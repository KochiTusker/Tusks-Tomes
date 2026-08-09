// PDF text extraction via pdfjs-dist (Mozilla's parser used in Firefox).
//
// Migrated from `pdf-parse@1.1.1` — that package was last published in
// 2018, is unmaintained, and bundled a hardcoded test PDF that crashed
// at import time under tsx/ESM. pdfjs-dist gets active security
// upgrades, exposes a page-iterator API that lets us cap memory, and
// disables system font lookups by default (no out-of-band font fetch).
//
// Size ceiling: PDF parsing is a notorious DoS / memory-corruption
// surface. A malicious or massive PDF should fail loudly rather than
// wedge the server. 100 MB is well above realistic D&D supplements
// (the average sourcebook is 20–50 MB) and far below the kind of file
// a parser is comfortable holding entirely in memory.

import { getDocument, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'

const MAX_PDF_BYTES = 100 * 1024 * 1024

// pdfjs-dist's getTextContent item shape: TextItem | TextMarkedContent.
// Only TextItem carries a `str`. Narrow inline rather than importing
// the union — pdfjs-dist's deep type exports are unstable across
// minor versions.
type TextItemish = { str?: unknown }

export async function parsePdf(buffer: Buffer): Promise<string> {
  if (buffer.length > MAX_PDF_BYTES) {
    throw new Error(
      `PDF exceeds ${MAX_PDF_BYTES} bytes (${buffer.length} bytes). ` +
        `Split it or copy the relevant excerpt into a .md file.`,
    )
  }
  // pdfjs-dist takes a Uint8Array and detaches the buffer — copy to a
  // fresh ArrayBuffer-backed view so the caller's Buffer isn't
  // surprise-mutated.
  const data = new Uint8Array(buffer.byteLength)
  data.set(buffer)
  const loadingTask = getDocument({
    data,
    disableFontFace: true, // no font rendering — we only extract text
    useSystemFonts: false, // no on-disk font resolution path
    isEvalSupported: false, // legacy build still respects this
    verbosity: 0, // suppress library chatter
  })
  let doc: PDFDocumentProxy | null = null
  try {
    doc = await loadingTask.promise
    const out: string[] = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      try {
        const content = await page.getTextContent()
        const pageText = (content.items as TextItemish[])
          .map((item) => (typeof item.str === 'string' ? item.str : ''))
          .join(' ')
        out.push(pageText)
      } finally {
        page.cleanup()
      }
    }
    return out.join('\n')
  } finally {
    if (doc) await doc.destroy().catch(() => undefined)
  }
}
