import { describe, expect, it } from 'vitest'
import { resolveDocAsset } from './docAssets'

describe('resolveDocAsset', () => {
  it('resolves a diagram path relative to the doc that embeds it', () => {
    expect(resolveDocAsset('docs/chronicling/how-the-phases-work.md', '../assets/diagrams/phases.svg')).toBe(
      '/docs/assets/diagrams/phases.svg',
    )
  })

  it('resolves from a doc at the top of docs/', () => {
    expect(resolveDocAsset('docs/README.md', 'assets/diagrams/map.svg')).toBe('/docs/assets/diagrams/map.svg')
    expect(resolveDocAsset('docs/README.md', './assets/shot.png')).toBe('/docs/assets/shot.png')
  })

  it('accepts Windows separators in the doc path', () => {
    expect(resolveDocAsset('docs\\importing\\README.md', '../assets/diagrams/roads.svg')).toBe(
      '/docs/assets/diagrams/roads.svg',
    )
  })

  it('leaves anything outside docs/assets exactly as written', () => {
    expect(resolveDocAsset('docs/importing/README.md', '../../public/logo.png')).toBe('../../public/logo.png')
    expect(resolveDocAsset('docs/README.md', '../../../etc/passwd')).toBe('../../../etc/passwd')
  })

  it('leaves absolute, external and data URLs alone', () => {
    for (const src of ['https://img.shields.io/badge/x.svg', 'data:image/png;base64,AAAA', '/favicon.svg', '#top']) {
      expect(resolveDocAsset('docs/README.md', src)).toBe(src)
    }
  })
})
