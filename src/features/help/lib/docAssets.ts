// Docs embed their diagrams with paths relative to the markdown file, e.g.
// `../assets/diagrams/phases.svg` from docs/chronicling/. That is what makes
// the same file render on GitHub and on the docs site. The Help tab shows the
// markdown at the app's own URL, where a relative path would resolve against
// the page instead of the file, so it is rewritten here to the absolute
// /docs/assets/... path the server serves (server/features/help/routes/docsAssets.ts).

const ASSETS = '/docs/assets/'

/**
 * Resolve an image `src` found in the doc at `docPath` (repo-relative, e.g.
 * `docs/chronicling/how-the-phases-work.md`). Returns the absolute app path
 * when the image lives under docs/assets, and `src` unchanged otherwise, so
 * anything this does not understand behaves exactly as it did before.
 */
export function resolveDocAsset(docPath: string, src: string): string {
  if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('/') || src.startsWith('#')) return src
  const dir = docPath.replace(/\\/g, '/').split('/').slice(0, -1)
  const parts = [...dir]
  for (const seg of src.split(/[?#]/)[0].split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (parts.length === 0) return src
      parts.pop()
    } else {
      parts.push(seg)
    }
  }
  const resolved = `/${parts.join('/')}`
  return resolved.startsWith(ASSETS) ? resolved : src
}
