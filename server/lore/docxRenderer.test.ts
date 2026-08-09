// Renders a chronicle to .docx, then round-trips it back to markdown (via the
// same mammoth-based converter the lore import uses) so we can assert on the
// actual document content — which sections landed and in what shape.

import { describe, expect, it } from 'vitest'
import { renderChronicleDocx } from './docxRenderer.js'
import { docxBufferToMarkdown } from './docxToMarkdown.js'

const EXTRAS = {
  jests: ['The bard tripped over a chicken.'],
  gore: ['The ogre was bisected.'],
  quotes: [{ speaker: 'Anwen', line: 'We do not negotiate with mimics.', kind: 'funny' as const }],
}

const CONDENSED = {
  narrative: 'A tighter retelling of the session in a few sentences.',
  bulletPoints: ['The party reached the cathedral.', 'They fought the ogre.'],
}

const CHRONICLE = 'The party marched at dawn toward the Crimson Cathedral.\n\nBattle was joined at the gates.'

describe('renderChronicleDocx', () => {
  it('full mode includes the chronicle AND the condensed chronicle + recap', async () => {
    const buf = await renderChronicleDocx({
      campaign: 'Too Many Bruisers',
      sessionNumber: 24,
      chronicle: CHRONICLE,
      extras: EXTRAS,
      condensed: CONDENSED,
      mode: 'full',
    })
    const md = await docxBufferToMarkdown(buf)
    expect(md).toContain('Chronicle')
    expect(md).toContain('marched at dawn')
    // The fix: full mode now carries the condensed forms too.
    expect(md).toContain('Condensed Chronicle')
    expect(md).toContain('tighter retelling')
    expect(md).toContain('Catch-up Recap')
    expect(md).toContain('reached the cathedral')
    // Extras present in both modes.
    expect(md).toContain('Gallery of Jests')
    expect(md).toContain('Gallery of Gore')
    expect(md).toContain('Memorable Quotes')
  })

  it('condensed mode includes the condensed narrative but not the full chronicle body', async () => {
    const buf = await renderChronicleDocx({
      campaign: 'Too Many Bruisers',
      sessionNumber: 24,
      chronicle: CHRONICLE,
      extras: EXTRAS,
      condensed: CONDENSED,
      mode: 'condensed',
    })
    const md = await docxBufferToMarkdown(buf)
    expect(md).toContain('Condensed Chronicle')
    expect(md).toContain('tighter retelling')
    expect(md).toContain('Catch-up Recap')
    // The long Phase 3 prose is omitted in condensed mode.
    expect(md).not.toContain('marched at dawn')
  })

  it('full mode without a condensed output renders just the chronicle + extras', async () => {
    const buf = await renderChronicleDocx({
      campaign: 'Too Many Bruisers',
      sessionNumber: 24,
      chronicle: CHRONICLE,
      extras: EXTRAS,
      condensed: null,
      mode: 'full',
    })
    const md = await docxBufferToMarkdown(buf)
    expect(md).toContain('marched at dawn')
    expect(md).not.toContain('Condensed Chronicle')
    expect(md).not.toContain('Catch-up Recap')
  })
})
