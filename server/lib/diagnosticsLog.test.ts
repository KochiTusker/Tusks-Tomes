// Tests for the server-side diagnostics ring + pretty-printer + file writer.
// The appData module is mocked so each test runs against a per-test tmpdir
// — the user's real ~/.config/tusks-tomes/diagnostics.log is never touched.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let tmpDir: string

// vi.mock has to be declared at the top level (hoisted). We control the
// returned path via a mutable variable that beforeEach updates.
vi.mock('../appData.js', async () => {
  const actual = await vi.importActual<typeof import('../appData.js')>('../appData.js')
  return {
    ...actual,
    configDir: () => tmpDir,
  }
})

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tusks-diag-'))
  // Reset the module's internal state (ring + config cache + file stream).
  const mod = await import('./diagnosticsLog.js')
  await mod._resetForTests()
})

afterEach(async () => {
  // Close the file stream before removing the tmpdir, otherwise Windows
  // refuses to delete the directory with an open handle.
  const mod = await import('./diagnosticsLog.js')
  await mod._resetForTests()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('diagnosticsLog — ring buffer', () => {
  it('caps the ring at 500 entries (oldest dropped)', async () => {
    const mod = await import('./diagnosticsLog.js')
    for (let i = 0; i < 600; i++) {
      await mod.ingest([{ cat: 'pipeline', payload: { i } }], 'browser')
    }
    const entries = mod.dumpRecent({ count: 9999 })
    expect(entries).toHaveLength(500)
    expect((entries[0].payload as { i: number }).i).toBe(100)
    expect((entries[499].payload as { i: number }).i).toBe(599)
  })

  it('default source is applied when entry has none', async () => {
    const mod = await import('./diagnosticsLog.js')
    await mod.ingest([{ cat: 'pipeline', payload: { x: 1 } }], 'browser')
    await mod.ingest([{ cat: 'server', payload: { y: 2 } }], 'server')
    const entries = mod.dumpRecent()
    expect(entries[0].source).toBe('browser')
    expect(entries[1].source).toBe('server')
  })

  it('per-entry source overrides the default', async () => {
    const mod = await import('./diagnosticsLog.js')
    await mod.ingest([{ cat: 'pipeline', source: 'server', payload: {} }], 'browser')
    const entries = mod.dumpRecent()
    expect(entries[0].source).toBe('server')
  })

  it('dumpRecent filters by category', async () => {
    const mod = await import('./diagnosticsLog.js')
    await mod.ingest([{ cat: 'pipeline', payload: { i: 1 } }], 'browser')
    await mod.ingest([{ cat: 'gemini', payload: { i: 2 } }], 'browser')
    await mod.ingest([{ cat: 'pipeline', payload: { i: 3 } }], 'browser')
    const only = mod.dumpRecent({ cat: 'gemini' })
    expect(only).toHaveLength(1)
    expect((only[0].payload as { i: number }).i).toBe(2)
  })

  it('clearRing wipes everything', async () => {
    const mod = await import('./diagnosticsLog.js')
    await mod.ingest([{ cat: 'pipeline', payload: { i: 1 } }], 'browser')
    expect(mod.dumpRecent()).toHaveLength(1)
    mod.clearRing()
    expect(mod.dumpRecent()).toHaveLength(0)
  })
})

describe('diagnosticsLog — pretty printer', () => {
  it('produces a single-line ANSI-tagged string with timestamp + category', async () => {
    const mod = await import('./diagnosticsLog.js')
    const out = mod.formatPretty({
      ts: Date.UTC(2026, 4, 24, 12, 34, 56, 789),
      source: 'browser',
      cat: 'gemini',
      payload: { event: 'hard_zero_detected', pattern: 'limit:0', model: 'gemini-2.5-pro' },
    })
    expect(out).toContain('[12:34:56.789]')
    expect(out).toContain('[tusk:gemini]')
    expect(out).toContain('event=')
    expect(out).toContain('hard_zero_detected')
    expect(out).toContain('pattern=')
    expect(out).toContain('"limit:0"')
    // ANSI escape for blue (gemini's color).
    expect(out).toContain('\x1b[34m')
    // Reset code.
    expect(out).toContain('\x1b[0m')
    // No newlines — single-line guarantee.
    expect(out).not.toContain('\n')
  })

  it('marks server-source entries with a "(server)" suffix on the tag', async () => {
    const mod = await import('./diagnosticsLog.js')
    const out = mod.formatPretty({
      ts: Date.now(),
      source: 'server',
      cat: 'routing',
      payload: { event: 'putRouting' },
    })
    expect(out).toContain('(server)')
  })

  it('truncates long string payloads to ~200 chars with an ellipsis', async () => {
    const mod = await import('./diagnosticsLog.js')
    const big = 'x'.repeat(500)
    const out = mod.formatPretty({
      ts: Date.now(),
      source: 'browser',
      cat: 'pipeline',
      payload: { text: big },
    })
    expect(out).toContain('…')
    expect(out.length).toBeLessThan(700)
  })

  it('puts `event` field first when flattening an object', async () => {
    const mod = await import('./diagnosticsLog.js')
    const out = mod.flattenPayload({ z: 1, a: 2, event: 'thing', m: 3 })
    expect(out.indexOf('event=')).toBe(0)
  })

  it('handles nested objects with dotted paths', async () => {
    const mod = await import('./diagnosticsLog.js')
    const out = mod.flattenPayload({ event: 'x', limits: { rpm: 10, tpm: 250_000 } })
    expect(out).toContain('limits.rpm=10')
    expect(out).toContain('limits.tpm=250000')
  })

  it('handles null + undefined + booleans + numbers gracefully', async () => {
    const mod = await import('./diagnosticsLog.js')
    expect(mod.flattenPayload(null)).toBe('null')
    expect(mod.flattenPayload(undefined)).toBe('null')
    expect(mod.flattenPayload(true)).toBe('true')
    expect(mod.flattenPayload(42)).toBe('42')
  })
})

describe('diagnosticsLog — JSON Lines file writer', () => {
  it('does NOT create the file when file forwarding is off', async () => {
    const mod = await import('./diagnosticsLog.js')
    await mod.setForwarding({ terminal: false, file: false })
    await mod.ingest([{ cat: 'pipeline', payload: { i: 1 } }], 'browser')
    const exists = await fs.stat(mod.logFilePath()).then(() => true).catch(() => false)
    expect(exists).toBe(false)
  })

  it('appends one JSON object per line when file forwarding is on', async () => {
    const mod = await import('./diagnosticsLog.js')
    await mod.setForwarding({ file: true })
    await mod.ingest([{ cat: 'pipeline', payload: { i: 1 } }], 'browser')
    await mod.ingest([{ cat: 'gemini', payload: { i: 2 } }], 'browser')
    // Give the write stream a tick to drain.
    await new Promise((r) => setTimeout(r, 100))
    const content = await fs.readFile(mod.logFilePath(), 'utf8')
    const lines = content.trim().split('\n').filter(Boolean)
    expect(lines).toHaveLength(2)
    const first = JSON.parse(lines[0])
    expect(first.cat).toBe('pipeline')
    expect(first.payload).toEqual({ i: 1 })
    const second = JSON.parse(lines[1])
    expect(second.cat).toBe('gemini')
  })

  it('clearLogFile truncates the file', async () => {
    const mod = await import('./diagnosticsLog.js')
    await mod.setForwarding({ file: true })
    await mod.ingest([{ cat: 'pipeline', payload: { i: 1 } }], 'browser')
    await new Promise((r) => setTimeout(r, 100))
    await mod.clearLogFile()
    const content = await fs.readFile(mod.logFilePath(), 'utf8').catch(() => '')
    expect(content).toBe('')
  })

  it('reopens lazily after clear when file forwarding is still on', async () => {
    const mod = await import('./diagnosticsLog.js')
    await mod.setForwarding({ file: true })
    await mod.ingest([{ cat: 'pipeline', payload: { first: true } }], 'browser')
    await new Promise((r) => setTimeout(r, 100))
    await mod.clearLogFile()
    await mod.ingest([{ cat: 'pipeline', payload: { second: true } }], 'browser')
    await new Promise((r) => setTimeout(r, 100))
    const content = await fs.readFile(mod.logFilePath(), 'utf8')
    expect(content.includes('second')).toBe(true)
    expect(content.includes('first')).toBe(false)
  })

  it('closes the file stream when file forwarding is toggled off', async () => {
    const mod = await import('./diagnosticsLog.js')
    await mod.setForwarding({ file: true })
    await mod.ingest([{ cat: 'pipeline', payload: { i: 1 } }], 'browser')
    await new Promise((r) => setTimeout(r, 100))
    await mod.setForwarding({ file: false })
    await mod.ingest([{ cat: 'pipeline', payload: { i: 2 } }], 'browser')
    await new Promise((r) => setTimeout(r, 100))
    const content = await fs.readFile(mod.logFilePath(), 'utf8')
    const lines = content.trim().split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]).payload).toEqual({ i: 1 })
  })
})

describe('diagnosticsLog — config persistence', () => {
  it('writes diagnostics-config.json on setForwarding', async () => {
    const mod = await import('./diagnosticsLog.js')
    await mod.setForwarding({ terminal: true, file: false })
    const configPath = path.join(tmpDir, 'diagnostics-config.json')
    const content = await fs.readFile(configPath, 'utf8')
    const parsed = JSON.parse(content)
    expect(parsed).toEqual({ terminal: true, file: false })
  })

  it('getForwarding returns the persisted config', async () => {
    const mod = await import('./diagnosticsLog.js')
    await mod.setForwarding({ terminal: true, file: true })
    const cfg = await mod.getForwarding()
    expect(cfg).toEqual({ terminal: true, file: true })
  })

  it('defaults to both off when no config file exists', async () => {
    const mod = await import('./diagnosticsLog.js')
    const cfg = await mod.getForwarding()
    expect(cfg).toEqual({ terminal: false, file: false })
  })
})
