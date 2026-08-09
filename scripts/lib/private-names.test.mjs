// Tests for the private-name layer.
//
// NOTE FOR ANYONE EDITING: every name in this file is invented. The layer
// under test exists to keep real people's names out of tracked source, and a
// test file is tracked source. Use `Testperson`, `Zephyrine`, etc. Never paste
// a real name in here to "check it works" — run the layer locally instead.

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PRIVATE_NAMES_FILE,
  loadPrivateNames,
  nameMatcher,
  resolvePrivateNames,
  scanContentForPrivateNames,
  scanLinesForPrivateNames,
} from './private-names.mjs'
import { scanLinesForSpeakerNames } from './personal-info-scanner.mjs'

const NAMES = ['Zephyrine', 'Bram', "Ta'ir", 'Coledge']

const dirs = []
function repoWith(contents) {
  const dir = mkdtempSync(path.join(tmpdir(), 'privnames-'))
  dirs.push(dir)
  if (contents !== null) writeFileSync(path.join(dir, PRIVATE_NAMES_FILE), contents, 'utf8')
  return dir
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true })
})

describe('loading the denylist', () => {
  it('reads one name per line, ignoring comments and blanks', () => {
    const dir = repoWith('# a comment\n\nZephyrine\n  Bram  \n\n# another\nColedge\n')
    expect(loadPrivateNames(dir)).toEqual({
      names: ['Zephyrine', 'Bram', 'Coledge'],
      present: true,
    })
  })

  it('reports absent rather than throwing when there is no list', () => {
    expect(loadPrivateNames(repoWith(null))).toEqual({ names: [], present: false })
  })
})

describe('the asymmetry: warn locally, block on publish', () => {
  // A denylist that silently no-ops when its file is missing is worse than no
  // denylist, because the green tick still appears. But contributors have no
  // list and must still be able to build. So absence warns everywhere except
  // the one gate only the maintainer runs.
  it('warns, and does not throw, when the list is missing and not required', () => {
    const r = resolvePrivateNames(repoWith(null))
    expect(r.names).toEqual([])
    expect(r.warning).toMatch(/INACTIVE/)
  })

  it('THROWS when the list is missing and required', () => {
    expect(() => resolvePrivateNames(repoWith(null), { requireList: true })).toThrow(
      /not found/,
    )
  })

  it('warns when the list exists but is empty — an empty gate is still no gate', () => {
    expect(resolvePrivateNames(repoWith('# nothing yet\n')).warning).toMatch(/inactive/i)
  })

  it('returns no warning once the list has entries', () => {
    expect(resolvePrivateNames(repoWith('Zephyrine\n')).warning).toBeNull()
  })
})

describe('matching', () => {
  it('catches the shape that actually shipped — a name in a speaker tag', () => {
    const hits = scanLinesForPrivateNames('f.mjs', '[Grendal (Bram)] I cast light.', NAMES)
    expect(hits).toHaveLength(1)
    expect(hits[0].layer).toBe('private-name')
  })

  it('catches a name anywhere, not just in a speaker tag', () => {
    // The `speaker` layer covers the tag format. This layer is the backstop
    // for a name in a comment, a variable, a commit message, or prose.
    expect(scanLinesForPrivateNames('f.ts', '// thanks to Bram for the repro', NAMES)).toHaveLength(1)
    expect(scanLinesForPrivateNames('f.ts', 'const bramConfig = {}', NAMES)).toHaveLength(0)
  })

  it('is case-insensitive', () => {
    expect(scanLinesForPrivateNames('f.ts', 'zephyrine said so', NAMES)).toHaveLength(1)
  })

  it('handles apostrophes in names', () => {
    expect(scanLinesForPrivateNames('f.ts', "Ta'ir rolled a nat 20", NAMES)).toHaveLength(1)
  })

  it.each([
    ['Bramble is a plant', 'Bram inside Bramble'],
    ['Coledgework begins', 'Coledge inside a longer word'],
    ['a zephyrines flock', 'trailing letters'],
    ["Ta'irs", 'possessive extension'],
  ])('does not fire on %s (%s)', (line) => {
    expect(scanLinesForPrivateNames('f.ts', line, NAMES)).toHaveLength(0)
  })

  it('reports the line number so the hit can be found', () => {
    const hits = scanLinesForPrivateNames('f.ts', 'clean\nclean\nBram here\n', NAMES)
    expect(hits[0].line).toBe(3)
    expect(hits[0].detail).toContain('line 3')
  })

  it('does not scan the denylist itself, or its template', () => {
    // Otherwise the list is permanently self-flagging and the gate never passes.
    expect(scanLinesForPrivateNames('.private-names', 'Bram\n', NAMES)).toEqual([])
    expect(scanLinesForPrivateNames('.private-names.example', 'Bram\n', NAMES)).toEqual([])
  })

  it('is inert with an empty list rather than matching everything', () => {
    expect(scanLinesForPrivateNames('f.ts', 'Bram', [])).toEqual([])
  })

  it('escapes regex metacharacters in a name', () => {
    // A name is user data. `nameMatcher` must not let it compile as a pattern.
    expect(() => nameMatcher('A.B*C')).not.toThrow()
    expect(scanLinesForPrivateNames('f.ts', 'AxBxC', ['A.B*C'])).toEqual([])
  })
})

describe('markdown links are not speaker tags', () => {
  // `[Text (parenthetical)](url)` is byte-identical to a speaker tag up to the
  // closing bracket. This blocked a real publish: the generated llms.txt links
  // to the add-on docs, and three of those titles carry a parenthetical.
  // Worth pinning, because the finding named a product feature rather than a
  // person — exactly the shape that trains someone to reach for --no-verify.
  it.each([
    '- [Claude Code (your subscription)](https://example.test/claude-code/)',
    '- [Codex (your ChatGPT subscription)](https://example.test/codex/)',
    '| [Obsidian Vault Lore (read-only)](docs/add-ons/obsidian-vault.md) |',
  ])('does not flag %s', (line) => {
    expect(scanLinesForSpeakerNames('llms.txt', line)).toEqual([])
  })

  it('still flags a genuine speaker tag on the same kind of line', () => {
    expect(scanLinesForSpeakerNames('f.md', '[Someone (Jane)] said a thing')).toHaveLength(1)
  })
})

describe('diff scanning for the push gate', () => {
  const diff = [
    'commit abc1234567890',
    '--- a/f.mjs',
    '+++ b/f.mjs',
    '+[Grendal (Bram)] added line',
    '-[Grendal (Bram)] removed line',
    ' [Grendal (Bram)] context line',
  ].join('\n')

  it('flags an added line', () => {
    const hits = scanContentForPrivateNames(diff, NAMES)
    expect(hits).toHaveLength(1)
    expect(hits[0].file).toBe('f.mjs')
    expect(hits[0].commit).toBe('abc1234')
  })

  it('ignores removed and context lines — deleting a name is the fix', () => {
    // Without this, the commit that REMEDIATES a leak is blocked by the gate
    // that was supposed to prevent it.
    const hits = scanContentForPrivateNames(diff, NAMES)
    expect(hits.every((h) => !h.detail.includes('removed'))).toBe(true)
  })
})
