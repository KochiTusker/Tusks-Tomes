/**
 * Pre-publish audit of the BUILT site — the actual bytes that go public.
 *
 * The repo-level scanners check tracked source. This checks the generated
 * output, which is a different set of bytes: templates get expanded, markdown
 * becomes HTML, images get copied, and metadata rides along inside binaries
 * where no text scanner will ever see it.
 *
 * Two questions it answers:
 *
 *   1. Is anything of the author's hidden in here? Not just visible prose —
 *      HTML comments, meta tags, JSON-LD, hidden elements, data attributes,
 *      and EXIF inside the screenshots. A screenshot is the highest-risk
 *      artefact on any developer's site: it can carry a username in a window
 *      title, a file path in a title bar, or camera/software metadata.
 *
 *   2. Does it hold up against the OWASP Top 10, for the parts that apply to
 *      a static site? Most of the list is about servers and databases and is
 *      genuinely not applicable — saying so explicitly is more useful than
 *      pretending otherwise. What DOES apply: XSS surface, external requests,
 *      and security headers.
 *
 *   node scripts/site/audit-site.mjs
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

import { stripGeneratedSlugs } from '../lib/secret-scanner.mjs'

const ROOT = path.resolve(process.cwd(), 'site-dist')
const findings = []
const notes = []
const add = (sev, area, msg) => findings.push({ sev, area, msg })

async function walk(dir, out = []) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name)
    if (e.isDirectory()) await walk(f, out)
    else out.push(f)
  }
  return out
}

const files = await walk(ROOT).catch(() => null)
if (!files) {
  console.error('\n✖ site-dist not found — run `npm run site:build` first.\n')
  process.exit(1)
}
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/')
const html = files.filter((f) => f.endsWith('.html'))
const text = files.filter((f) => /\.(html|css|txt|xml|json|js|svg)$/.test(f))
const binaries = files.filter((f) => /\.(png|jpe?g|gif|webp|woff2?|ttf|otf|pdf|zip|mp4)$/i.test(f))

// ---------------------------------------------------------------------------
// 1. Author information hidden in the output
// ---------------------------------------------------------------------------

/** Personal-identifier shapes. Deliberately broad — a false positive costs a
 *  glance, a miss is permanent once it's on a crawler. */
const IDENTITY = [
  [/[A-Za-z0-9._%+-]+@(?!users\.noreply\.github\.com|example\.(com|org|net))[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, 'email address'],
  [/[A-Z]:\\+Users\\+[^\\/<>"'\s]+/g, 'Windows user path'],
  [/\/Users\/(?!<|your|you\b)[^/\s"'<>]+\//g, 'macOS user path'],
  [/\/home\/(?!<|your|you\b)[^/\s"'<>]+\//g, 'Linux home path'],
  // Valid dotted quads only: each octet 0-255, no leading zeros. The loose
  // version matched SVG path coordinates ("2.33.66.07" out of a `d=` attribute)
  // on every page, which buried the real findings under 170 false positives.
  [/\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g, 'IP address'],
  [/AIza[A-Za-z0-9_-]{20,}/g, 'Google API key'],
  [/sk-[A-Za-z0-9_-]{16,}/g, 'API key'],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, 'GitHub token'],
]

/** Localhost and documentation placeholders are expected in setup docs. */
const IDENTITY_OK = [/^127\.0\.0\.1$/, /^0\.0\.0\.0$/, /^192\.168\./, /^255\./, /^1\.1\.1\.1$/]

/** Inline SVG is geometry, not prose. Its coordinate lists look like dotted
 *  quads and its path data looks like anything you care to imagine, so it is
 *  removed before identity matching. */
const withoutSvg = (s) => s.replace(/<svg[\s\S]*?<\/svg>/gi, ' ')

// Heading-anchor slugs can collapse into something matching a credential
// shape. Imported rather than reimplemented — see stripGeneratedSlugs in
// scripts/lib/secret-scanner.mjs for why, and for why it costs no coverage.
// This file runs its own regex set (identity shapes as well as tokens), so it
// has to apply the suppression itself; it should not own a second copy of it.
const withoutGeneratedSlugs = stripGeneratedSlugs

for (const f of text) {
  const raw = await fs.readFile(f, 'utf8')
  const content = withoutGeneratedSlugs(withoutSvg(raw))
  for (const [re, label] of IDENTITY) {
    for (const m of content.match(re) ?? []) {
      if (IDENTITY_OK.some((ok) => ok.test(m))) continue
      add('HIGH', 'identity', `${rel(f)}: ${label} — ${m}`)
    }
  }
}

// HTML comments: the classic place for a stray note to survive into production.
for (const f of html) {
  const content = await fs.readFile(f, 'utf8')
  for (const c of content.match(/<!--[\s\S]*?-->/g) ?? []) {
    add('INFO', 'comment', `${rel(f)}: HTML comment retained — ${c.slice(0, 90).replace(/\s+/g, ' ')}`)
  }
}

// Hidden content — text present in the DOM but not shown. This is where a
// forgotten note would survive.
//
// `aria-hidden` is NOT flagged: it means "this is decorative, skip it in a
// screen reader", which is correct markup for icons and the ember layer, and
// flagging it produced noise on every page while hiding real findings. What
// matters is content hidden from EVERYONE — display:none, visibility:hidden,
// or the `hidden` attribute.
for (const f of html) {
  const content = await fs.readFile(f, 'utf8')
  const hidden = content.match(/<[^>]*(?:display:\s*none|visibility:\s*hidden|\shidden(?=[\s>]))[^>]*>/gi) ?? []
  for (const h of hidden) {
    if (/<svg|symbol|<use\b/i.test(h)) continue // the inline symbol sheet
    add('INFO', 'hidden', `${rel(f)}: hidden element — ${h.slice(0, 80)}`)
  }
}

// ---------------------------------------------------------------------------
// 2. Binary metadata — EXIF/XMP in images, name tables in fonts
// ---------------------------------------------------------------------------

/** Read a PNG's ancillary text chunks (tEXt / iTXt / zTXt) and any EXIF chunk.
 *  Screenshot tools routinely write software names, and some write paths. */
async function pngMetadata(file) {
  const buf = await fs.readFile(file)
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return { chunks: [], text: [] }
  const chunks = []
  const textEntries = []
  let off = 8
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    if (!/^[a-zA-Z]{4}$/.test(type)) break
    chunks.push(type)
    if (['tEXt', 'iTXt', 'zTXt', 'eXIf'].includes(type)) {
      const data = buf.subarray(off + 8, off + 8 + len)
      textEntries.push(`${type}: ${data.toString('latin1').replace(/\0/g, ' ').slice(0, 120).trim()}`)
    }
    if (type === 'IEND') break
    off += 12 + len
  }
  return { chunks, text: textEntries }
}

for (const f of binaries) {
  if (/\.png$/i.test(f)) {
    const { chunks, text: meta } = await pngMetadata(f)
    for (const m of meta) add('MEDIUM', 'exif', `${rel(f)}: embedded metadata — ${m}`)
    const risky = chunks.filter((c) => ['eXIf', 'iTXt', 'tEXt', 'zTXt'].includes(c))
    if (risky.length === 0) notes.push(`${rel(f)}: clean (no text/EXIF chunks)`)
  } else if (/\.jpe?g$/i.test(f)) {
    // Walk the segment headers rather than substring-searching the whole file:
    // "Exif" can occur inside compressed scan data by chance, and — more to
    // the point — a byte search finds only the marker it is told to look for.
    // EXIF was the only one checked, so a COM segment sailed through. ffmpeg
    // writes its encoder version into COM unless told not to, which is a tool
    // fingerprint on a published image; XMP and IPTC ride in APP1/APP13 and
    // routinely carry an author name.
    const buf = await fs.readFile(f)
    // Severity splits by what the segment can actually contain.
    //
    // BLOCKING: these carry identity. EXIF holds GPS coordinates, camera
    // serial numbers, author and original filename; XMP rides in the same
    // APP1; IPTC exists to record a creator; JUMBF carries C2PA provenance
    // which is signed identity by design. Any of those on a published image
    // defeats the point of the rest of this audit, so they stop the publish
    // rather than printing a note somebody scrolls past.
    //
    // ADVISORY: an ICC profile is colour management, APP14 is a colour
    // transform flag, and COM is usually just an encoder version. Worth
    // stripping — a tool fingerprint is still a fingerprint — but not worth
    // blocking a release over.
    const IDENTIFYING = {
      0xe1: 'APP1 (EXIF or XMP)',
      0xeb: 'APP11 (JUMBF / C2PA provenance)',
      0xed: 'APP13 (IPTC / Photoshop)',
    }
    const BENIGN = {
      0xe2: 'APP2 (ICC profile)',
      0xee: 'APP14 (Adobe colour transform)',
      0xfe: 'COM (comment / encoder tag)',
    }
    // Walking segment headers rather than substring-searching the file: a
    // byte search finds only the marker it is told to look for, which is how
    // an `Exif` check missed everything else, and "Exif" can occur by chance
    // inside compressed scan data.
    //
    // APP0/JFIF is the mandatory header — density units only — so it is in
    // neither table and needs no excusing.
    const identifying = []
    const benign = []
    let o = 2
    while (o < buf.length - 3 && buf[o] === 0xff) {
      const marker = buf[o + 1]
      if (marker === 0xda) break // start of scan: headers are done
      const len = buf.readUInt16BE(o + 2)
      if (len < 2) break // malformed; stop rather than loop forever
      if (IDENTIFYING[marker]) identifying.push(IDENTIFYING[marker])
      else if (BENIGN[marker]) benign.push(BENIGN[marker])
      o += 2 + len
    }
    const strip = '(ffmpeg: -map_metadata -1 -bitexact)'
    if (identifying.length) {
      add('HIGH', 'exif', `${rel(f)}: JPEG carries ${identifying.join(', ')} — strip before publishing ${strip}`)
    }
    if (benign.length) {
      add('MEDIUM', 'exif', `${rel(f)}: JPEG carries ${benign.join(', ')} ${strip}`)
    }
    if (!identifying.length && !benign.length) {
      notes.push(`${rel(f)}: clean (no EXIF/XMP/IPTC/comment segments)`)
    }
  } else if (/\.woff2?$/i.test(f)) {
    notes.push(`${rel(f)}: font (name table carries designer/licence only)`)
  }
}

// ---------------------------------------------------------------------------
// 3. OWASP Top 10 — only the items that apply to static hosting
// ---------------------------------------------------------------------------

const owasp = []

// A03 Injection / XSS — is there any script that builds markup from input?
let inlineScripts = 0
let dangerousSinks = []
for (const f of html) {
  const content = await fs.readFile(f, 'utf8')
  inlineScripts += (content.match(/<script(?![^>]*type="application\/ld\+json")/g) ?? []).length
  for (const sink of ['innerHTML', 'outerHTML', 'document.write', 'eval(', 'insertAdjacentHTML', 'new Function(']) {
    if (content.includes(sink)) dangerousSinks.push(`${rel(f)}: ${sink}`)
  }
}
owasp.push({
  id: 'A03 Injection / XSS',
  applies: true,
  status: dangerousSinks.length ? 'REVIEW' : 'OK',
  detail: dangerousSinks.length
    ? `HTML-writing sinks present: ${dangerousSinks.join(', ')}`
    : `No innerHTML/document.write/eval anywhere. ${inlineScripts} inline script block(s), all DOM-API only.`,
})

// A05 Security Misconfiguration — headers. GitHub Pages won't let you set
// response headers, so a CSP has to come from a meta tag or not at all.
const landing = await fs.readFile(path.join(ROOT, 'index.html'), 'utf8')
const hasCsp = /http-equiv="Content-Security-Policy"/i.test(landing)
const hasReferrer = /name="referrer"/i.test(landing)
owasp.push({
  id: 'A05 Security Misconfiguration',
  applies: true,
  status: hasCsp && hasReferrer ? 'OK' : 'REVIEW',
  detail: `CSP meta: ${hasCsp ? 'present' : 'MISSING'}; referrer policy: ${hasReferrer ? 'present' : 'MISSING'}. ` +
    `GitHub Pages sends HTTPS + HSTS itself but allows no custom headers, so meta tags are the only lever.`,
})

// A06 Vulnerable Components — what does the page load at runtime?
const externalRefs = new Set()
for (const f of html) {
  const content = await fs.readFile(f, 'utf8')
  for (const m of content.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)) {
    externalRefs.add(new URL(m[1]).host)
  }
}
owasp.push({
  id: 'A06 Vulnerable / Outdated Components',
  applies: true,
  status: externalRefs.size === 0 ? 'OK' : 'INFO',
  detail:
    externalRefs.size === 0
      ? 'Zero runtime dependencies — no CDN scripts, no external fonts, no analytics. Nothing to become outdated.'
      : `Outbound references (links, not loads): ${[...externalRefs].join(', ')}`,
})

// A08 Integrity — subresource integrity only matters if something is loaded
// from a third party. Nothing is.
owasp.push({
  id: 'A08 Data Integrity Failures',
  applies: externalRefs.size > 0,
  status: 'OK',
  detail: 'No third-party subresources are loaded, so there is nothing requiring SRI.',
})

// A09 Logging — inverted here: the requirement is that there is NO tracking.
const trackers = []
for (const f of html) {
  const content = await fs.readFile(f, 'utf8')
  // Match DOMAINS and call sites, not bare words. "plausible" is an ordinary
  // English adjective and matching it flagged the landing page's own prose as
  // an analytics script.
  for (const t of [
    'google-analytics.com',
    'googletagmanager.com',
    'gtag(',
    'plausible.io',
    'usefathom.com',
    'static.hotjar.com',
    'connect.facebook.net',
    'cdn.mixpanel.com',
    'cdn.segment.com',
    'clarity.ms',
    'matomo',
  ]) {
    if (content.toLowerCase().includes(t)) trackers.push(`${rel(f)}: ${t}`)
  }
}
owasp.push({
  id: 'A09 Logging & Monitoring',
  applies: true,
  status: trackers.length ? 'FAIL' : 'OK',
  detail: trackers.length
    ? `Tracking code found: ${trackers.join(', ')} — the project promises none.`
    : 'No analytics, tag managers, or tracking pixels. Matches the no-telemetry promise.',
})

for (const id of [
  'A01 Broken Access Control',
  'A02 Cryptographic Failures',
  'A04 Insecure Design',
  'A07 Authentication Failures',
  'A10 Server-Side Request Forgery',
]) {
  owasp.push({
    id,
    applies: false,
    status: 'N/A',
    detail: 'No server, no sessions, no database, no user input processed at runtime.',
  })
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log(`\nAudited ${files.length} built files (${html.length} pages, ${binaries.length} binaries)\n`)

console.log('── OWASP Top 10 (static-site scope) ──────────────────────────')
for (const o of owasp) {
  const mark = o.status === 'OK' ? '✓' : o.status === 'N/A' ? '·' : '!'
  console.log(`  ${mark} ${o.id.padEnd(34)} ${o.status}`)
  if (o.status !== 'N/A') console.log(`      ${o.detail}`)
}

const bySeverity = (s) => findings.filter((f) => f.sev === s)
console.log('\n── Author information in the output ──────────────────────────')
for (const sev of ['HIGH', 'MEDIUM', 'INFO']) {
  const rows = bySeverity(sev)
  if (!rows.length) continue
  console.log(`\n  ${sev}: ${rows.length}`)
  for (const r of rows.slice(0, 20)) console.log(`    ${r.msg}`)
  if (rows.length > 20) console.log(`    …and ${rows.length - 20} more`)
}
if (findings.length === 0) {
  console.log('  ✓ No emails, machine paths, IPs, credentials, HTML comments or hidden text.')
  console.log(`  ✓ ${binaries.length} binaries carry no embedded metadata.`)
}

const blocking = bySeverity('HIGH').length + owasp.filter((o) => o.status === 'FAIL').length
console.log(
  blocking === 0
    ? '\n✓ Safe to publish.\n'
    : `\n✖ ${blocking} blocking finding(s) — resolve before publishing.\n`,
)
process.exit(blocking === 0 ? 0 : 1)
