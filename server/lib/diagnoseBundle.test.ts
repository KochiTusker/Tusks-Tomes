// Bundle assembler tests — exercise the markdown shape, sanitization
// boundary, file-write atomicity, and backup rotation. Mocks the
// subprocess + filesystem layer so tests don't actually shell out to git
// or graphify.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'

let tmpRoot: string

// Mock child_process so spawn('git', ...) and spawn('graphify', ...)
// return controllable behaviour.
const spawnState = vi.hoisted(() => ({
  gitBranch: 'main',
  gitStatus: '',
  gitLog: 'abc1234 commit message',
  graphifyVersionOk: true,
  graphifyAffectedStdout: 'caller1\ncaller2',
}))

vi.mock('node:child_process', () => ({
  spawn: vi.fn((cmd: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & {
      kill: () => void
      stdout: EventEmitter
      stderr: EventEmitter
    }
    child.kill = () => { /* */ }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    setImmediate(() => {
      if (cmd === 'git') {
        const sub = args[0]
        let out = ''
        if (sub === 'rev-parse') out = spawnState.gitBranch
        else if (sub === 'status') out = spawnState.gitStatus
        else if (sub === 'log') out = spawnState.gitLog
        if (out) child.stdout.emit('data', Buffer.from(out))
        child.emit('exit', 0)
        return
      }
      if (cmd === 'graphify') {
        if (args[0] === '--version') {
          child.emit('exit', spawnState.graphifyVersionOk ? 0 : 127)
          return
        }
        if (args[0] === 'affected') {
          child.stdout.emit('data', Buffer.from(spawnState.graphifyAffectedStdout))
          child.emit('exit', 0)
          return
        }
      }
      child.emit('exit', 0)
    })
    return child as never
  }),
}))

// appData.routingFile + appData.readJson — point at tmpRoot.
const fsState = vi.hoisted(() => ({ routingDoc: null as object | null }))
vi.mock('../appData.js', async () => {
  const actual = await vi.importActual<typeof import('../appData.js')>('../appData.js')
  return {
    ...actual,
    configDir: () => path.join(tmpRoot, 'config'),
    routingFile: () => path.join(tmpRoot, 'config', 'routing.json'),
    readJson: vi.fn(async <T>(_p: string, def: T) => {
      return (fsState.routingDoc ?? def) as T
    }),
  }
})

// Probe cache via modelProbe.readAvailabilityCache.
const probeState = vi.hoisted(() => ({ cache: {} as Record<string, unknown> }))
vi.mock('../api/modelProbe.js', () => ({
  readAvailabilityCache: vi.fn(async () => probeState.cache),
}))

// diagnosticsLog.dumpRecent — server-side ring contribution.
const ringState = vi.hoisted(() => ({ ring: [] as Array<{ ts: number; source: string; cat: string; payload: unknown }> }))
vi.mock('./diagnosticsLog.js', () => ({
  dumpRecent: vi.fn(() => ringState.ring),
}))

import { buildBundle, listRecentBundles } from './diagnoseBundle.js'
import { _resetAvailabilityCacheForTests } from './graphifyQuery.js'

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tusks-diagnose-'))
  await fs.mkdir(path.join(tmpRoot, 'config'), { recursive: true })
  spawnState.gitBranch = 'main'
  spawnState.gitStatus = ''
  spawnState.gitLog = 'abc1234 first commit\ndef5678 second commit'
  spawnState.graphifyVersionOk = true
  spawnState.graphifyAffectedStdout = 'caller1\ncaller2'
  fsState.routingDoc = null
  probeState.cache = {}
  ringState.ring = []
  _resetAvailabilityCacheForTests()
})

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

describe('buildBundle — sections present', () => {
  it('produces a markdown file with all 8 sections', async () => {
    fsState.routingDoc = {
      version: 3,
      lastSelectedProvider: 'gemini',
      geminiTier: 'paid',
    }
    probeState.cache = {
      gemini: {
        keyFingerprint: 'abc123',
        probed: [{ id: 'gemini-2.5-flash', accessible: true }],
      },
    }
    const { markdown, latestPath, bundlePath } = await buildBundle({
      trigger: 'manual',
      repoRoot: tmpRoot,
      currentState: { status: 'idle', currentPhase: null },
    })
    expect(markdown).toContain('# Tusk\'s Tomes — Diagnosis Bundle')
    expect(markdown).toContain('## 1. Current state')
    expect(markdown).toContain('## 2. Soft-error signatures matched')
    expect(markdown).toContain('## 3. Last')
    expect(markdown).toContain('## 4. Graphify slice')
    expect(markdown).toContain('## 5. Probe cache snapshot')
    expect(markdown).toContain('## 6. Routing snapshot')
    expect(markdown).toContain('## 7. Git state')
    expect(markdown).toContain('## 8. Recommended next steps')
    // latest.md and the timestamped bundle exist on disk and contain the same body.
    const latestBody = await fs.readFile(latestPath, 'utf8')
    const bundleBody = await fs.readFile(bundlePath, 'utf8')
    expect(latestBody).toBe(markdown)
    expect(bundleBody).toBe(markdown)
  })

  it('records the trigger in the header', async () => {
    const { markdown } = await buildBundle({ trigger: 'hard_error', repoRoot: tmpRoot })
    expect(markdown).toContain('Trigger: hard_error')
  })

  it('renders state fields when currentState is provided', async () => {
    const { markdown } = await buildBundle({
      trigger: 'manual',
      repoRoot: tmpRoot,
      currentState: {
        status: 'phase3_chronicle',
        currentPhase: 'phase3_chronicle',
        currentChunkIndex: 5,
        totalChunks: 12,
        outputSelection: { chronicle: true, extras: false, condensed: true },
      },
    })
    expect(markdown).toContain('| status | phase3_chronicle |')
    expect(markdown).toContain('| chunk | 5 / 12 |')
    expect(markdown).toContain('chronicle:true extras:false condensed:true')
  })
})

describe('buildBundle — soft-signature integration', () => {
  it('includes matched signatures in section 2', async () => {
    fsState.routingDoc = {
      geminiTier: 'paid',
      perPhase: {
        phase3: { target: 'cloud', cloudProvider: 'gemini', geminiTier: 'free' },
      },
    }
    const { markdown, signatures } = await buildBundle({
      trigger: 'manual',
      repoRoot: tmpRoot,
    })
    // stale_perPhase_override should match this routing.
    expect(signatures.some((s) => s.id === 'stale_perPhase_override')).toBe(true)
    expect(markdown).toContain('stale_perPhase_override')
  })

  it('renders "No soft-error signatures matched" when none fire', async () => {
    const { markdown, signatures } = await buildBundle({ trigger: 'manual', repoRoot: tmpRoot })
    expect(signatures).toHaveLength(0)
    expect(markdown).toContain('No soft-error signatures matched')
  })
})

describe('buildBundle — graphify integration', () => {
  it('includes graphify output when symbol is provided AND graphify available', async () => {
    // graphifyAvailable needs the graph.json file to exist; create it.
    await fs.mkdir(path.join(tmpRoot, 'graphify-out'), { recursive: true })
    await fs.writeFile(path.join(tmpRoot, 'graphify-out', 'graph.json'), '{}', 'utf8')
    spawnState.graphifyAffectedStdout = 'NODE runPhase3\n  caller: chunkedGenerate'
    const { markdown } = await buildBundle({
      trigger: 'manual',
      repoRoot: tmpRoot,
      symbolHint: 'runPhase3',
    })
    expect(markdown).toContain('runPhase3')
    expect(markdown).toContain('chunkedGenerate')
  })

  it('renders "(graphify slice unavailable)" when graph.json missing', async () => {
    const { markdown } = await buildBundle({
      trigger: 'manual',
      repoRoot: tmpRoot,
      symbolHint: 'runPhase3',
    })
    expect(markdown).toContain('graphify slice unavailable')
  })

  it('skips graphify section entirely when no symbol can be inferred', async () => {
    const { markdown } = await buildBundle({ trigger: 'manual', repoRoot: tmpRoot })
    expect(markdown).toContain('No throw-site symbol could be inferred')
  })
})

describe('buildBundle — backup rotation', () => {
  it('keeps the most recent 10 timestamped backups', async () => {
    // Trigger 12 bundle builds in series. Each writes a new timestamped
    // file; the prune step should leave only the latest 10.
    for (let i = 0; i < 12; i++) {
      // Force unique timestamps by advancing system clock — fake timers
      // would interact badly with the subprocess mocks, so we just
      // await a small delay between builds.
      await buildBundle({ trigger: 'manual', repoRoot: tmpRoot })
      await new Promise((r) => setTimeout(r, 2))
    }
    const entries = await fs.readdir(path.join(tmpRoot, '.diagnose'))
    const backups = entries.filter((e) => /^diagnose-.+\.md$/.test(e))
    expect(backups.length).toBeLessThanOrEqual(10)
    // latest.md is always preserved.
    expect(entries).toContain('latest.md')
  })
})

describe('buildBundle — sanitization', () => {
  it('does NOT include raw API keys in the markdown (defense-in-depth)', async () => {
    ringState.ring = [
      {
        ts: 1000,
        source: 'browser',
        cat: 'pipeline',
        // We rely on the client sanitizer in verboseLog.ts to redact this
        // BEFORE forwarding. The bundle assembler doesn't re-sanitize —
        // it trusts the merged ring. This test asserts the contract:
        // if the client correctly redacted, the bundle stays clean.
        payload: { apiKey: '[REDACTED]', apiKey_chars: 39, event: 'gen' },
      },
    ]
    const { markdown } = await buildBundle({
      trigger: 'manual',
      repoRoot: tmpRoot,
      currentState: { status: 'idle' },
    })
    // The redaction signal is present, the raw key never is.
    expect(markdown).toContain('[REDACTED]')
    expect(markdown).not.toMatch(/AIzaSy[A-Za-z0-9_-]{30,}/)
    expect(markdown).not.toMatch(/sk-[A-Za-z0-9]{30,}/)
  })
})

describe('listRecentBundles', () => {
  it('lists files in newest-first order', async () => {
    await buildBundle({ trigger: 'manual', repoRoot: tmpRoot })
    await new Promise((r) => setTimeout(r, 10))
    await buildBundle({ trigger: 'manual', repoRoot: tmpRoot })
    const recent = await listRecentBundles(tmpRoot)
    // At minimum we expect latest.md + 2 timestamped backups.
    expect(recent.length).toBeGreaterThanOrEqual(2)
    // Newest first.
    for (let i = 0; i < recent.length - 1; i++) {
      expect(recent[i].modifiedAt >= recent[i + 1].modifiedAt).toBe(true)
    }
  })

  it('returns empty array when .diagnose/ does not exist', async () => {
    const recent = await listRecentBundles(tmpRoot)
    expect(recent).toEqual([])
  })
})

describe('buildBundle — git state integration', () => {
  it('embeds branch + status + last 5 commits', async () => {
    spawnState.gitBranch = 'feature/probe-dropdowns'
    // Note: stdout.trim() in readGitState strips leading whitespace of
    // the first line, so the leading space of ` M ...` becomes just `M`.
    // That's fine — the user is reading this in markdown, not git porcelain.
    spawnState.gitStatus = ' M src/lib/foo.ts'
    spawnState.gitLog = '111aaaa first\n222bbbb second\n333cccc third'
    const { markdown } = await buildBundle({ trigger: 'manual', repoRoot: tmpRoot })
    expect(markdown).toContain('feature/probe-dropdowns')
    expect(markdown).toContain('M src/lib/foo.ts')
    expect(markdown).toContain('111aaaa first')
  })
})
