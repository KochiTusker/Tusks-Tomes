/**
 * Documentation tone linter.
 *
 * The docs are written in one deliberate voice: a GM who built a tool for
 * their own table, talking to other GMs. Understated, UK English, honest about
 * limitations, and — the part that's easy to lose — NOT selling anything.
 *
 * That voice degrades one word at a time. Someone adds "seamlessly", someone
 * else adds "unlock the power of", and six months later it reads like a
 * landing page for a Series A. This flags the specific vocabulary that signals
 * the drift, so it's caught in review rather than noticed a year later.
 *
 * It is advisory: it prints findings and exits 0 unless --strict is passed.
 * Tone is a judgement call and a linter should not be the final authority on
 * it — but it's very good at spotting "leverage" and "effortless".
 *
 *   node scripts/docs-tone.mjs            # report
 *   node scripts/docs-tone.mjs --strict   # non-zero exit if anything is flagged
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

const STRICT = process.argv.includes('--strict')
const ROOT = process.cwd()

/** Marketing vocabulary. Each entry is a phrase and why it's off-voice. */
const SALES_SPEAK = [
  ['game[- ]?changer', 'nothing is a game-changer'],
  ['supercharge', 'marketing verb'],
  ['revolutioni[sz]e', 'it writes up D&D sessions'],
  ['unlock the power', 'brochure phrasing'],
  ['effortless', 'overclaims; things take effort'],
  ['seamless', 'almost never true, and always sounds like a pitch'],
  ['blazing(ly)? fast', 'benchmark it or drop it'],
  ['best[- ]in[- ]class', 'says nothing'],
  ['world[- ]class', 'says nothing'],
  ['cutting[- ]edge', 'says nothing'],
  ['next[- ]generation', 'says nothing'],
  ['take (it|your \\w+) to the next level', 'brochure phrasing'],
  ['10x\\b', 'unless it is measured, it is a slogan'],
  ['empower(s|ing)? (you|users|your)', 'corporate'],
  ['leverage (the|your|our)', 'use "use"'],
  ['delightful', 'over-warm'],
  ['magical experience', 'over-warm'],
  ['simply put', 'filler'],
  ["let'?s dive (in|into)", 'over-familiar US blog register'],
  ['buckle up', 'over-familiar US blog register'],
  ['you got this', 'over-familiar US blog register'],
  ['super (easy|simple|quick)', 'US register; "quite" or "fairly" reads better'],
  ['a breeze\\b', 'US register'],
  ['no[- ]brainer', 'US register'],
]

/** US spellings that clash with the Commonwealth-English baseline. */
const US_SPELLING = [
  ['\\bcolor(s|ed|ing)?\\b', 'colour'],
  ['\\bbehavior(s|al)?\\b', 'behaviour'],
  ['\\bcustomiz(e|ed|ing|ation)\\b', 'customise'],
  ['\\boptimiz(e|ed|ing|ation)\\b', 'optimise'],
  ['\\borganiz(e|ed|ing|ation)\\b', 'organise'],
  ['\\brecogniz(e|ed|ing)\\b', 'recognise'],
  ['\\bcatalog\\b', 'catalogue'],
  ['\\bdefense\\b', 'defence'],
  // Case-SENSITIVE (third element drops the `i` flag): "LICENSE" is the
  // filename and "License" is the badge label — both correct. Only the
  // lower-case common noun is a spelling issue.
  ['(?<![A-Za-z])license(?![A-Za-z])', 'licence (noun); "license" is the verb', ''],
  ['\\bgotten\\b', 'got'],
]

/** Files that are reference material rather than prose — a table of env vars
 *  doesn't need a personality, and forcing one on it would be worse. */
const SKIP = [
  /^CLAUDE\.md$/i,
  /^docs\/security\/public-release-workflow\.md$/i,
  /^docs\/assets\//,
  /^node_modules\//,
  /^site-dist\//,
]

async function walk(dir, out = []) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'site-dist') continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) await walk(full, out)
    // .html as well as .md: site/index.template.html carries the landing-page
    // copy, which is the most-read prose the project has and was the one place
    // the voice was never checked.
    else if (e.name.endsWith('.md') || e.name.endsWith('.html')) out.push(full)
  }
  return out
}

/** Reduce a document to actual prose before matching.
 *
 *  Everything removed here is something a style rule has no business judging:
 *  `color=8B6F2C` in a badge URL is an API parameter, and `optimize` inside a
 *  code fence is somebody else's function name. Without this the linter is
 *  mostly false positives, which is the fastest way to get a linter ignored.
 *
 *  Blank lines are preserved (newline-for-newline) so reported line numbers
 *  still point at the right place in the original file. */
function prose(src) {
  const blank = (m) => m.replace(/[^\n]/g, ' ')
  return src
    .replace(/```[\s\S]*?```/g, blank) // fenced code
    .replace(/`[^`\n]*`/g, blank) // inline code
    .replace(/^(\s{4,}\S.*)$/gm, blank) // indented code
    .replace(/\]\([^)]*\)/g, blank) // markdown link targets
    .replace(/https?:\/\/\S+/g, blank) // bare URLs
    // HTML comments BEFORE tags: a comment can span lines, which the
    // single-line tag pattern below cannot reach into. Maintainer notes in
    // the landing-page template are not published copy and should not be
    // judged as such.
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/<[^>\n]+>/g, blank) // HTML tags and attributes
}

const files = (await walk(ROOT))
  .map((f) => path.relative(ROOT, f).split(path.sep).join('/'))
  .filter((f) => !SKIP.some((re) => re.test(f)))
  .sort()

let total = 0
for (const rel of files) {
  const text = prose(await fs.readFile(path.join(ROOT, rel), 'utf8'))
  const lines = text.split(/\r?\n/)
  const findings = []
  for (const [pattern, why] of SALES_SPEAK) {
    const re = new RegExp(pattern, 'i')
    lines.forEach((line, i) => {
      const m = re.exec(line)
      if (m) findings.push(`  ${rel}:${i + 1}  "${m[0]}" — ${why}`)
    })
  }
  for (const [pattern, better, flags = 'i'] of US_SPELLING) {
    const re = new RegExp(pattern, flags)
    lines.forEach((line, i) => {
      const m = re.exec(line)
      if (m) findings.push(`  ${rel}:${i + 1}  "${m[0]}" — UK spelling: ${better}`)
    })
  }
  if (findings.length) {
    total += findings.length
    console.log(findings.join('\n'))
  }
}

console.log(
  total === 0
    ? `\n✓ Tone check clean across ${files.length} files.`
    : `\n${total} tone finding(s) across ${files.length} files. These are advisory — read them, don't obey them blindly.`,
)
if (STRICT && total > 0) process.exit(1)
