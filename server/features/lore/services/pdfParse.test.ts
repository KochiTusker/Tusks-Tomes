// Smoke test for the pdfjs-dist replacement of pdf-parse. Confirms:
//   1. The library imports without crashing under tsx/ESM (regression
//      vs. pdf-parse 1.x which probed a hardcoded test file at import).
//   2. Oversize input rejects with the size-cap error.
//   3. Malformed input rejects (rather than silently returning '').
//
// Real PDF fixture parsing is covered by the manual UI smoke test —
// adding a real PDF binary fixture file here would inflate the repo,
// and pdfjs-dist is itself extensively tested upstream.

import { describe, expect, it } from 'vitest'

describe('pdfParse (pdfjs-dist swap)', () => {
  it('exports parsePdf', async () => {
    const mod = await import('./pdfParse.js')
    expect(typeof mod.parsePdf).toBe('function')
  })

  it('rejects oversize input with the size-cap error', async () => {
    const { parsePdf } = await import('./pdfParse.js')
    const tooBig = Buffer.alloc(101 * 1024 * 1024) // 101 MB > 100 MB cap
    await expect(parsePdf(tooBig)).rejects.toThrow(/exceeds/)
  })

  it('rejects malformed bytes (not silently returning empty string)', async () => {
    const { parsePdf } = await import('./pdfParse.js')
    // Random non-PDF bytes — must throw, not return ''.
    const garbage = Buffer.from('this is definitely not a PDF file\n'.repeat(50))
    await expect(parsePdf(garbage)).rejects.toBeTruthy()
  })
})
