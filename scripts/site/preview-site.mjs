/**
 * Serve the built site locally, exactly as GitHub Pages will.
 *
 * The point of the base-path mapping below: Pages serves a project site under
 * /<repo>/, and every link the generator emits is absolute from that base. A
 * naive `serve site-dist` at the domain root would 404 on every internal link
 * and give a completely false impression of whether the site works.
 *
 *   npm run site:preview            # build already done, serve on :4321
 *   npm run site:preview -- --port 5000
 *
 * Read-only: it serves files and nothing else. No writes, no network calls out.
 */

import http from 'node:http'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const portArg = args.indexOf('--port')
const PORT = Number(portArg >= 0 ? args[portArg + 1] : 4321)
const ROOT = path.resolve(process.cwd(), 'site-dist')
const BASE = process.env.SITE_BASE ?? '/Tusks-Tomes'

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
}

if (!(await fs.stat(path.join(ROOT, 'index.html')).catch(() => null))) {
  console.error('\n✖ site-dist/index.html not found — run `npm run site:build` first.\n')
  process.exit(1)
}

const server = http.createServer(async (req, res) => {
  let url = decodeURIComponent((req.url ?? '/').split('?')[0])
  if (url === BASE) url = `${BASE}/`
  if (!url.startsWith(`${BASE}/`)) {
    res.writeHead(302, { Location: `${BASE}/` })
    return res.end()
  }
  let rel = url.slice(BASE.length + 1)
  if (rel === '' || rel.endsWith('/')) rel += 'index.html'

  // Containment: a crafted path must not escape site-dist.
  const file = path.resolve(ROOT, rel)
  if (!file.startsWith(ROOT)) {
    res.writeHead(403)
    return res.end('forbidden')
  }

  try {
    const body = await fs.readFile(file)
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(await fs.readFile(path.join(ROOT, '404.html')).catch(() => 'not found'))
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Previewing site-dist as GitHub Pages would serve it:\n`)
  console.log(`    http://127.0.0.1:${PORT}${BASE}/\n`)
  console.log(`  Bound to 127.0.0.1 only — not reachable from your network.`)
  console.log(`  Ctrl+C to stop.\n`)
})
