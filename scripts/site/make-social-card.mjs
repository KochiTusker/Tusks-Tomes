#!/usr/bin/env node
/**
 * Build the social preview card — the image Discord, Slack, X, LinkedIn and
 * Google show beside a link to the site.
 *
 * Committed as a generated artefact rather than produced during `site:build`,
 * because it changes only when the logo does and rebuilding it on every
 * publish would churn a 145 KB binary in the release commit for no reason.
 *
 * Run this after changing public/logo.png, then commit the result:
 *   node scripts/site/make-social-card.mjs
 *
 * Why the specifics:
 *
 *   1200x630  Every major scraper crops to roughly this ratio. A square image
 *             gets letterboxed or centre-cropped and reads as accidental.
 *
 *   scale down only  The source is 939x923. Fitting it to 540px tall is a
 *             reduction, so it stays sharp; upscaling to fill the canvas
 *             would look soft in the one image most people see first.
 *
 *   light background  The logo has a transparency checkerboard baked in as
 *             opaque near-white pixels — an artefact of the tool that removed
 *             its background. It cannot be keyed out: resampling smeared it
 *             across dozens of tones that the artwork's smoke also occupies.
 *             On the site's near-black it reads as a grey grid; on parchment
 *             it is almost invisible. Replace this with the site background
 *             once a clean logo exists.
 *
 *   JPEG q3   Visually identical to PNG here and a quarter of the size
 *             (145 KB against 617). This is fetched on every share.
 *
 *   -bitexact  Without it ffmpeg writes its encoder version into a JPEG COM
 *             segment. Harmless, but it is a tool fingerprint in a public
 *             artefact and the project strips metadata from binaries.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import ffmpeg from 'ffmpeg-static'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const SOURCE = path.join(ROOT, 'public', 'logo.png')
const OUT = path.join(ROOT, 'docs', 'assets', 'tusks-tomes-social-card.jpg')

const WIDTH = 1200
const HEIGHT = 630
const LOGO_HEIGHT = 540
const BACKGROUND = '0xf2ece0'

function fail(msg) {
  console.error(`\n✖ ${msg}\n`)
  process.exit(1)
}

if (!ffmpeg) fail('ffmpeg-static did not resolve a binary — run `npm ci`.')

// Refuse to upscale. If someone swaps in a smaller logo the card would go
// soft, and a blurry preview image is worse than an unchanged one.
const src = readFileSync(SOURCE)
if (src.toString('ascii', 1, 4) !== 'PNG') fail(`${SOURCE} is not a PNG.`)
const srcHeight = src.readUInt32BE(20)
if (srcHeight < LOGO_HEIGHT) {
  fail(
    `logo is ${srcHeight}px tall but the card needs ${LOGO_HEIGHT}px.\n` +
      `  Scaling up would ship a soft image. Supply a larger logo, or lower\n` +
      `  LOGO_HEIGHT in this script if a smaller mark is genuinely intended.`,
  )
}

execFileSync(
  ffmpeg,
  [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=c=${BACKGROUND}:s=${WIDTH}x${HEIGHT}`,
    '-i', SOURCE,
    '-filter_complex',
    `[1:v]scale=-1:${LOGO_HEIGHT}:flags=lanczos[lg];[0:v][lg]overlay=(W-w)/2:(H-h)/2:format=auto`,
    '-frames:v', '1',
    '-map_metadata', '-1',
    '-bitexact',
    '-q:v', '3',
    OUT,
  ],
  { stdio: ['ignore', 'pipe', 'inherit'] },
)

// Verify what was actually written rather than trusting the flags. A metadata
// segment slipping into a published binary is exactly what the release audit
// exists to catch; catching it here is cheaper than catching it there.
const out = readFileSync(OUT)
const SEGMENTS = { 0xe1: 'APP1/EXIF-or-XMP', 0xed: 'APP13/IPTC', 0xee: 'APP14', 0xfe: 'COM' }
const found = []
let dims = null
let o = 2
while (o < out.length - 1 && out[o] === 0xff) {
  const marker = out[o + 1]
  if (marker === 0xda) break // start of scan — headers are done
  const len = out.readUInt16BE(o + 2)
  if (marker >= 0xc0 && marker <= 0xc3) {
    dims = { h: out.readUInt16BE(o + 5), w: out.readUInt16BE(o + 7) }
  }
  if (SEGMENTS[marker]) found.push(SEGMENTS[marker])
  o += 2 + len
}

if (found.length) fail(`card carries metadata segments: ${found.join(', ')}`)
if (!dims || dims.w !== WIDTH || dims.h !== HEIGHT) {
  fail(`expected ${WIDTH}x${HEIGHT}, got ${dims ? `${dims.w}x${dims.h}` : 'unreadable'}`)
}

const kb = Math.round(statSync(OUT).size / 1024)
console.log(`Built ${path.relative(ROOT, OUT)} — ${dims.w}x${dims.h}, ${kb} KB, no metadata`)
console.log('Commit it; site:build references it but does not regenerate it.')
