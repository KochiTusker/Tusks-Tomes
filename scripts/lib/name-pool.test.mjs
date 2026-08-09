// Tests for the fixture-name rotation.
//
// NOTE FOR ANYONE EDITING: every name here is invented. This is tracked source,
// and the suite it belongs to exists to keep real people's names out of tracked
// source. Use `Bram`, `Zephyrine`, etc.

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadNamePool, loadRotationState, nextAssignment, saveRotationState } from './name-pool.mjs'

const dirs = []
function repoWith({ pool, priv } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'namepool-'))
  dirs.push(dir)
  if (pool !== undefined) writeFileSync(path.join(dir, '.name-pool'), pool, 'utf8')
  if (priv !== undefined) writeFileSync(path.join(dir, '.private-names'), priv, 'utf8')
  return dir
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true })
})

const POOL = ['Zephyrine', 'Bram', 'Coledge', 'Ilta', 'Lorcan', 'Sorrel', 'Wynn', 'Tamsin']

describe('pool loading refuses to mix placeholders with real people', () => {
  it('THROWS when a pool name is also on the private denylist', () => {
    // Rotating a real person's name into a fixture would be the original bug,
    // automated and repeating every release. Throw rather than filter: a silent
    // filter shrinks the pool toward empty while every gate still reports OK.
    const dir = repoWith({ pool: 'Bram\nColedge\n', priv: 'Coledge\n' })
    expect(() => loadNamePool(dir)).toThrow(/also in \.private-names/)
  })

  it('matches the denylist case-insensitively', () => {
    const dir = repoWith({ pool: 'Bram\n', priv: 'bram\n' })
    expect(() => loadNamePool(dir)).toThrow(/also in \.private-names/)
  })

  it('THROWS on duplicate entries', () => {
    // A duplicate can hand one name to two slots, which merges two characters
    // in the fixtures — a behaviour change, not a rename.
    const dir = repoWith({ pool: 'Bram\nColedge\nbram\n' })
    expect(() => loadNamePool(dir)).toThrow(/duplicate/i)
  })

  it('reports absent rather than throwing when there is no pool', () => {
    expect(loadNamePool(repoWith({}))).toEqual({ names: [], present: false })
  })

  it('loads a clean pool, ignoring comments and blanks', () => {
    const dir = repoWith({ pool: '# heading\n\nBram\n  Coledge  \n', priv: 'Someone\n' })
    expect(loadNamePool(dir)).toEqual({ names: ['Bram', 'Coledge'], present: true })
  })
})

describe('assignment invariants', () => {
  const slots = ['pc1', 'pc2', 'pc3']

  it('gives every slot a distinct name', () => {
    const a = nextAssignment(slots, POOL, {}, 1)
    expect(new Set(Object.values(a)).size).toBe(slots.length)
  })

  it('reuses NOTHING from the previous release', () => {
    // A name that survived a rotation would be the one fixed point in a
    // churning set — exactly the thing an observer would flag as real.
    const first = nextAssignment(slots, POOL, {}, 1)
    const second = nextAssignment(slots, POOL, first, 2)
    for (const name of Object.values(second)) {
      expect(Object.values(first)).not.toContain(name)
    }
  })

  it('is deterministic for a given seed, so a rotation can be reviewed', () => {
    expect(nextAssignment(slots, POOL, {}, 42)).toEqual(nextAssignment(slots, POOL, {}, 42))
  })

  it('produces different assignments for different seeds', () => {
    expect(nextAssignment(slots, POOL, {}, 1)).not.toEqual(nextAssignment(slots, POOL, {}, 2))
  })

  it('THROWS when the pool cannot fill every slot without reuse', () => {
    // Silently reusing would quietly break the no-carryover property that the
    // whole scheme rests on.
    const prev = { pc1: 'Bram', pc2: 'Coledge' }
    expect(() => nextAssignment(slots, ['Bram', 'Coledge', 'Ilta'], prev, 1)).toThrow(
      /not used last release/,
    )
  })
})

describe('rotation state round-trips', () => {
  it('saves and reloads an assignment', () => {
    const dir = repoWith({})
    saveRotationState(dir, { seed: 3, forRelease: '9.9.9', assignment: { pc1: 'Bram' } })
    expect(loadRotationState(dir)).toEqual({
      seed: 3,
      forRelease: '9.9.9',
      assignment: { pc1: 'Bram' },
    })
  })

  it('returns null before the first rotation', () => {
    expect(loadRotationState(repoWith({}))).toBeNull()
  })
})

describe('substitution changes names and nothing else', () => {
  // The property the whole scheme depends on: a rotation diff must be pure
  // renaming. This models the two-phase sentinel substitution the rotation
  // script performs, and asserts that normalising both sides by slot collapses
  // them to the same string — i.e. nothing but names moved.
  //
  // Two real bugs this shape catches, both of which shipped and were found the
  // hard way: a sentinel that is a prefix of another sentinel (the short one is
  // replaced first and mangles the long one's tail), and a swap where the new
  // name for one slot is the current name of a different slot.
  const SLOTS = ['pc1', 'pc2', 'pc3']
  const sentinel = (s) => `__ROT_${s}__`

  function rotate(text, current, next) {
    let out = text
    for (const s of SLOTS) {
      out = out.replace(new RegExp(`(?<!\\w)${current[s]}(?!\\w)`, 'g'), sentinel(s))
      const lower = current[s].toLowerCase()
      if (lower !== current[s]) {
        out = out.replace(new RegExp(`(?<!\\w)${lower}(?!\\w)`, 'g'), sentinel(`${s}__lc`))
      }
    }
    // Longest sentinel first — see the note in rotate-names.mjs.
    for (const s of SLOTS) out = out.split(sentinel(`${s}__lc`)).join(next[s].toLowerCase())
    for (const s of SLOTS) out = out.split(sentinel(s)).join(next[s])
    return out
  }

  // Word-boundary aware, exactly like the rotation. A plain split/join would
  // rewrite `Bram` inside `Bramble` and then report the untouched word as a
  // violation — the normaliser has to model the substitution faithfully or the
  // proof measures the normaliser rather than the rotation.
  const normalise = (line, map) => {
    let out = line
    const ordered = [...SLOTS].sort((a, b) => map[b].length - map[a].length)
    for (const s of ordered) {
      out = out.replace(new RegExp(`(?<!\\w)${map[s]}(?!\\w)`, 'g'), `<${s}>`)
      out = out.replace(new RegExp(`(?<!\\w)${map[s].toLowerCase()}(?!\\w)`, 'g'), `<${s}>`)
    }
    return out
  }

  const CURRENT = { pc1: 'Bram', pc2: 'Coledge', pc3: 'Ilta' }
  const SOURCE = [
    "  speakers: ['Bram', 'Coledge', 'Ilta'],",
    '  [Bram (Coledge)] I cast light.',
    "  expect(index.aliases['bram']).toBe('Bram Vale')",
    '  // Bram is a placeholder; Bramble is a plant and must not change.',
    '  const bramConfig = { coledgeMode: true }',
  ].join('\n')

  it('substitutes every occurrence, in both cases', () => {
    const next = { pc1: 'Lorcan', pc2: 'Wynn', pc3: 'Tamsin' }
    const out = rotate(SOURCE, CURRENT, next)
    expect(out).toContain("speakers: ['Lorcan', 'Wynn', 'Tamsin']")
    expect(out).toContain('[Lorcan (Wynn)]')
    expect(out).toContain("aliases['lorcan']")
    expect(out).toContain("'Lorcan Vale'")
  })

  it('leaves longer words containing a name alone', () => {
    const out = rotate(SOURCE, CURRENT, { pc1: 'Lorcan', pc2: 'Wynn', pc3: 'Tamsin' })
    expect(out).toContain('Bramble is a plant')
    expect(out).toContain('bramConfig')
    expect(out).toContain('coledgeMode')
  })

  it('handles a swap, where one slot takes another slot\'s current name', () => {
    // The case a naive sequential replace gets wrong: pc1 becomes what pc2 is
    // now, so a one-pass rewrite would process pc2's occurrences twice and
    // merge the two characters.
    const next = { pc1: 'Coledge', pc2: 'Bram', pc3: 'Tamsin' }
    const out = rotate(SOURCE, CURRENT, next)
    expect(out).toContain('[Coledge (Bram)]')
    expect(out).toContain("speakers: ['Coledge', 'Bram', 'Tamsin']")
  })

  it('every changed line differs ONLY by a name — the load-bearing property', () => {
    const next = { pc1: 'Coledge', pc2: 'Bram', pc3: 'Tamsin' }
    const before = SOURCE.split('\n')
    const after = rotate(SOURCE, CURRENT, next).split('\n')
    expect(after).toHaveLength(before.length)
    for (let i = 0; i < before.length; i++) {
      expect(normalise(after[i], next)).toBe(normalise(before[i], CURRENT))
    }
  })

  it('never leaves a sentinel behind', () => {
    const out = rotate(SOURCE, CURRENT, { pc1: 'Lorcan', pc2: 'Wynn', pc3: 'Tamsin' })
    expect(out).not.toMatch(/__ROT_/)
    expect(out).not.toMatch(/lc__/)
  })
})
