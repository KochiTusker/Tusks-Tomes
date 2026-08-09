#!/usr/bin/env node
// One-shot helper that adds H1 markdown headings to .md files where the
// docx→md conversion produced plain-text section titles. Reads the
// frontmatter to know which entity names should become headings, then
// prepends `# ` to the matching prose lines. Idempotent — re-running on
// an already-restructured file is a no-op.
//
// Usage:  node scripts/lore/restructure-headings.mjs <loreRoot> [--apply]
//         Without --apply, prints a diff preview without writing anything.
//
// Backups: writes <file>.bak2 on apply (the original migration .bak
// remains untouched).

import { promises as fs } from 'node:fs'
import path from 'node:path'

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/

function parseEntityNamesFromFrontmatter(content) {
  const m = content.match(FRONTMATTER_RE)
  if (!m) return []
  const body = m[1]
  const names = []
  for (const line of body.split(/\r?\n/)) {
    const nameMatch = line.match(/^\s+-\s+name:\s+(.+)$/)
    if (nameMatch) {
      names.push(nameMatch[1].trim().replace(/^["']|["']$/g, ''))
    }
  }
  return names
}

function findPlainTextHeading(lines, name, startIdx = 0) {
  // Match when the line is exactly `name`, preceded by a blank line (or
  // file start), and followed by a blank line. This is the same pattern
  // extract-aliases.mjs's heading-promotion looks for.
  for (let i = startIdx; i < lines.length; i++) {
    if (lines[i].trim() !== name) continue
    const prev = i === 0 ? '' : lines[i - 1].trim()
    const next = i + 1 < lines.length ? lines[i + 1].trim() : ''
    if (prev === '' && next === '') return i
  }
  return -1
}

async function processFile(absPath, apply) {
  const content = await fs.readFile(absPath, 'utf8')
  const names = parseEntityNamesFromFrontmatter(content)
  if (names.length === 0) {
    return { file: absPath, action: 'skipped', reason: 'no-frontmatter-entities' }
  }
  const lines = content.split(/\r?\n/)
  const additions = []
  for (const name of names) {
    const idx = findPlainTextHeading(lines, name)
    if (idx < 0) continue
    // Already a heading at this line? Skip.
    if (lines[idx].startsWith('#')) continue
    // Mutate inline: prepend `# `.
    lines[idx] = `# ${name}`
    additions.push({ name, line: idx + 1 })
  }
  if (additions.length === 0) {
    return { file: absPath, action: 'skipped', reason: 'no-plain-headings-found' }
  }
  if (apply) {
    await fs.writeFile(`${absPath}.bak2`, content, 'utf8')
    await fs.writeFile(absPath, lines.join('\n'), 'utf8')
  }
  return { file: absPath, action: apply ? 'restructured' : 'preview', additions }
}

async function walk(dir) {
  const out = []
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue
    const abs = path.join(dir, e.name)
    if (e.isDirectory()) {
      out.push(...(await walk(abs)))
    } else if (e.isFile() && abs.toLowerCase().endsWith('.md') && !abs.endsWith('.bak')) {
      out.push(abs)
    }
  }
  return out
}

async function main() {
  const args = process.argv.slice(2)
  const loreRoot = path.resolve(args.find((a) => !a.startsWith('--')) ?? 'D:/Tusks-Lore')
  const apply = args.includes('--apply')
  const files = await walk(loreRoot)
  let restructured = 0
  let touchedHeadings = 0
  for (const f of files) {
    const result = await processFile(f, apply)
    if (result.action === 'preview' || result.action === 'restructured') {
      restructured += 1
      touchedHeadings += result.additions.length
      console.log(`${result.action.toUpperCase()}: ${path.basename(f)} (+${result.additions.length} headings)`)
      for (const a of result.additions) {
        console.log(`    line ${a.line}: # ${a.name}`)
      }
    } else if (result.additions === undefined) {
      // skipped — silent
    }
  }
  console.log(`\n${apply ? 'Restructured' : 'Would restructure'} ${restructured} file(s), ${touchedHeadings} heading(s) added.`)
  if (!apply) console.log('Pass --apply to write changes (originals saved to *.bak2).')
}

main().catch((err) => {
  console.error('restructure failed:', err)
  process.exit(1)
})
