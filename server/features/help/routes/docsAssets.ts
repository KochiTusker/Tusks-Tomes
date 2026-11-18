// The images the docs embed (diagrams and screenshots), served read-only at
// /docs/assets so the Help tab shows the same pictures as the docs site and
// GitHub. Mounted in both modes: development would reach the folder through
// Vite anyway (its root is the repository), but production serves only
// dist/, and the two should not differ.
import express, { type RequestHandler } from 'express'
import path from 'node:path'

const IMAGE = /\.(svg|png|jpe?g|webp|gif)$/i

/** An SVG opened directly is a document, and a document can run script.
 *  This one may carry styles and embedded (data:) fonts, and nothing else. */
export const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; font-src data:; sandbox"

/**
 * Serve image files from `<repoRoot>/docs/assets`, and only those. The
 * folder also holds a contributor README and each diagram's editable
 * source, neither of which this route hands out. Anything it does not serve
 * is a plain 404 rather than a fall-through: the SPA fallback behind it
 * would otherwise answer with index.html and a 200.
 */
export function docsAssets(repoRoot: string): RequestHandler {
  const files = express.static(path.join(repoRoot, 'docs', 'assets'), {
    index: false,
    dotfiles: 'deny',
    redirect: false,
    fallthrough: true,
    setHeaders(res, file) {
      res.setHeader('X-Content-Type-Options', 'nosniff')
      if (file.toLowerCase().endsWith('.svg')) res.setHeader('Content-Security-Policy', SVG_CSP)
    },
  })
  const notFound = (res: express.Response) => res.status(404).type('text/plain').send('Not found')
  return (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).set('Allow', 'GET, HEAD').end()
    if (!IMAGE.test(req.path)) return notFound(res)
    return files(req, res, () => notFound(res))
  }
}
