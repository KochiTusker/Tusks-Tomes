import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import {
  LORE_MARKER_FILENAME,
  LORE_MARKER_VERSION,
  detectLore,
  createLoreFolder,
} from './detection'

// Tests build a fresh temp parent containing a fake repo root and
// (optionally) a sibling lore folder. We tell the detector where the
// "repo root" is by overriding the env var, since the SIBLING_CANDIDATES
// lookup is anchored on `<repoRoot>/..`. The env-var override path is
// what most tests exercise; the test name makes the path explicit.

let WORK: string
let REPO: string

beforeEach(async () => {
  WORK = await fs.mkdtemp(path.join(tmpdir(), 'lore-test-'))
  REPO = path.join(WORK, 'Tusks-Tomes')
  await fs.mkdir(REPO, { recursive: true })
  // Mute console.warn / console.error during tests since detectLore /
  // createLoreFolder don't log, but be defensive in case future helpers do.
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  delete process.env.TUSKS_LORE_DIR
  vi.restoreAllMocks()
  await fs.rm(WORK, { recursive: true, force: true })
})

describe('detectLore', () => {
  it('returns found=false with helpful notes when nothing is detected', async () => {
    const status = await detectLore({ repoRoot: REPO })
    expect(status.found).toBe(false)
    expect(status.source).toBe('none')
    expect(status.notes?.length).toBeGreaterThan(0)
  })

  it('finds a folder pointed at by TUSKS_LORE_DIR when it has a valid marker', async () => {
    const target = path.join(WORK, 'custom-lore')
    await fs.mkdir(path.join(target, 'Sessions'), { recursive: true })
    await fs.writeFile(
      path.join(target, LORE_MARKER_FILENAME),
      JSON.stringify({ version: LORE_MARKER_VERSION, createdAt: new Date().toISOString() }),
    )
    process.env.TUSKS_LORE_DIR = target

    const status = await detectLore({ repoRoot: REPO })
    expect(status.found).toBe(true)
    expect(status.source).toBe('env')
    expect(status.loreRoot).toBe(target)
    expect(status.sessionsDir).toBe(path.join(target, 'Sessions'))
  })

  it('rejects an env-pointed folder when the marker is missing', async () => {
    const target = path.join(WORK, 'no-marker')
    await fs.mkdir(path.join(target, 'Sessions'), { recursive: true })
    process.env.TUSKS_LORE_DIR = target

    const status = await detectLore({ repoRoot: REPO })
    expect(status.found).toBe(false)
    expect(status.notes?.some((n) => n.includes('marker'))).toBe(true)
  })

  it('rejects a marker with no version field', async () => {
    const target = path.join(WORK, 'bad-marker')
    await fs.mkdir(target, { recursive: true })
    await fs.writeFile(path.join(target, LORE_MARKER_FILENAME), JSON.stringify({ foo: 'bar' }))
    process.env.TUSKS_LORE_DIR = target

    const status = await detectLore({ repoRoot: REPO })
    expect(status.found).toBe(false)
  })

  it('counts existing .docx files in Sessions/ recursively', async () => {
    const target = path.join(WORK, 'lore-with-sessions')
    const campaignDir = path.join(target, 'Sessions', 'Krome')
    await fs.mkdir(campaignDir, { recursive: true })
    await fs.writeFile(
      path.join(target, LORE_MARKER_FILENAME),
      JSON.stringify({ version: LORE_MARKER_VERSION, createdAt: new Date().toISOString() }),
    )
    await fs.writeFile(path.join(campaignDir, 'Session-01-full.docx'), 'pretend docx')
    await fs.writeFile(path.join(campaignDir, 'Session-02-condensed.docx'), 'pretend docx')
    await fs.writeFile(path.join(campaignDir, 'notes.txt'), 'should be ignored')
    process.env.TUSKS_LORE_DIR = target

    const status = await detectLore({ repoRoot: REPO })
    expect(status.found).toBe(true)
    expect(status.sessionsCount).toBe(2)
  })
})

describe('createLoreFolder', () => {
  // Tests target an isolated temp directory via `TUSKS_LORE_DIR` (now
  // honoured by `defaultLorePath()`). A prior version of this test ran
  // against the real `<worktree>/../Tusks-Lore` sibling and its `finally`
  // block recursively removed that path on cleanup — which deleted the
  // user's actual lore folder when the test ran unsupervised (e.g. as
  // part of `npm test`). The TUSKS_LORE_DIR redirect + the defensive
  // tmpdir() assertion below make a repeat impossible. **Do not** remove
  // the `expect(loreRoot.startsWith(...))` guard without auditing where
  // the cleanup runs.

  it('creates the redirected folder with marker + Sessions/, and is idempotent', async () => {
    const target = path.join(WORK, 'create-lore-target')
    process.env.TUSKS_LORE_DIR = target

    const first = await createLoreFolder()
    expect(first.found).toBe(true)
    expect(first.loreRoot).toBe(target)
    expect(first.sessionsDir).toBe(path.join(target, 'Sessions'))

    // Defensive: the cleanup logic in `afterEach` will fs.rm `WORK`.
    // If `defaultLorePath()` ever regresses to ignore TUSKS_LORE_DIR,
    // `first.loreRoot` will escape to the real sibling path and this
    // assertion fires BEFORE the rm runs.
    expect(first.loreRoot!.startsWith(tmpdir())).toBe(true)

    const markerPath = path.join(first.loreRoot!, LORE_MARKER_FILENAME)
    const marker1 = JSON.parse(await fs.readFile(markerPath, 'utf8'))
    expect(marker1.version).toBe(LORE_MARKER_VERSION)

    // Second call must not overwrite the marker — read it back and
    // verify createdAt is unchanged.
    await new Promise((r) => setTimeout(r, 20))
    const second = await createLoreFolder()
    expect(second.loreRoot).toBe(first.loreRoot)
    const marker2 = JSON.parse(await fs.readFile(markerPath, 'utf8'))
    expect(marker2.createdAt).toBe(marker1.createdAt)
    // afterEach() removes WORK; no per-test cleanup needed.
  })
})
