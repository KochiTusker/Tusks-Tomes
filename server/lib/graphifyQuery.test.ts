// graphifyQuery — subprocess + filesystem mocked. We never invoke the
// real `graphify` binary in tests; this verifies the argv construction,
// graceful-degrade paths, and stack-frame symbol extraction.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

// Hoist a mutable mock factory so each test can swap behaviour.
const spawnState = vi.hoisted(() => ({
  shouldFailVersion: false,
  shouldFailAffected: false,
  affectedStdout: '',
  affectedExitCode: 0,
  capturedArgv: [] as string[],
}))

vi.mock('node:child_process', () => ({
  spawn: vi.fn((cmd: string, args: string[]) => {
    spawnState.capturedArgv = args
    const child = new EventEmitter() as EventEmitter & {
      kill: () => void
      stdout: EventEmitter
      stderr: EventEmitter
    }
    child.kill = () => { /* */ }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    setImmediate(() => {
      if (args[0] === '--version') {
        child.emit('exit', spawnState.shouldFailVersion ? 127 : 0)
        return
      }
      if (args[0] === 'affected') {
        if (spawnState.shouldFailAffected) {
          child.emit('exit', spawnState.affectedExitCode)
          return
        }
        child.stdout.emit('data', Buffer.from(spawnState.affectedStdout))
        child.emit('exit', 0)
      }
    })
    return child as never
  }),
}))

// fs.stat is mocked so we can simulate the graph.json presence/absence.
const fsState = vi.hoisted(() => ({ graphExists: true }))
vi.mock('node:fs', () => ({
  promises: {
    stat: vi.fn(async () => {
      if (!fsState.graphExists) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException
        err.code = 'ENOENT'
        throw err
      }
      return { isFile: () => true } as never
    }),
  },
}))

import {
  _resetAvailabilityCacheForTests,
  affectedSlice,
  extractSymbolFromStack,
  isAvailable,
} from './graphifyQuery.js'

beforeEach(() => {
  spawnState.shouldFailVersion = false
  spawnState.shouldFailAffected = false
  spawnState.affectedStdout = ''
  spawnState.affectedExitCode = 0
  spawnState.capturedArgv = []
  fsState.graphExists = true
  _resetAvailabilityCacheForTests()
})

afterEach(() => {
  _resetAvailabilityCacheForTests()
})

describe('isAvailable', () => {
  it('returns ok:true when CLI succeeds AND graph.json exists', async () => {
    const result = await isAvailable()
    expect(result.ok).toBe(true)
  })

  it('returns ok:false when CLI is missing', async () => {
    spawnState.shouldFailVersion = true
    const result = await isAvailable()
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('graphify CLI not on PATH')
  })

  it('returns ok:false when graph.json is missing', async () => {
    fsState.graphExists = false
    const result = await isAvailable()
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('graph.json missing')
  })

  it('caches the result for the process lifetime', async () => {
    const first = await isAvailable()
    fsState.graphExists = false // changes shouldn't matter — cached
    spawnState.shouldFailVersion = true
    const second = await isAvailable()
    expect(second).toEqual(first)
  })
})

describe('affectedSlice', () => {
  it('returns null when graphify is unavailable', async () => {
    spawnState.shouldFailVersion = true
    const result = await affectedSlice('runPhase3')
    expect(result).toBeNull()
  })

  it('passes the right argv to spawn (affected, depth, budget, --graph)', async () => {
    spawnState.affectedStdout = 'slice output here'
    await affectedSlice('runPhase3', { depth: 3, budget: 1200 })
    expect(spawnState.capturedArgv).toEqual([
      'affected',
      'runPhase3',
      '--depth', '3',
      '--budget', '1200',
      '--graph', expect.stringContaining('graph.json'),
    ])
  })

  it('returns the trimmed stdout on success', async () => {
    spawnState.affectedStdout = '  \nslice content\n  '
    const result = await affectedSlice('runPhase3')
    expect(result).toBe('slice content')
  })

  it('returns null for a symbol with shell-unsafe characters', async () => {
    const result = await affectedSlice('rm -rf /')
    expect(result).toBeNull()
    // Spawn should not have been called for the affected subcommand.
    expect(spawnState.capturedArgv[0]).not.toBe('affected')
  })

  it('returns null on a non-zero exit (no stderr to surface)', async () => {
    spawnState.shouldFailAffected = true
    spawnState.affectedExitCode = 1
    const result = await affectedSlice('runPhase3')
    expect(result).toBeNull()
  })

  it('returns null when stdout is empty (no slice content)', async () => {
    spawnState.affectedStdout = ''
    const result = await affectedSlice('runPhase3')
    expect(result).toBeNull()
  })
})

describe('extractSymbolFromStack', () => {
  it('extracts the first `at <name>` frame', () => {
    const stack = `Error: boom
    at handlePipelineError (src/components/RefinementTool.tsx:281:7)
    at runWithSession (src/components/RefinementTool.tsx:300:11)`
    expect(extractSymbolFromStack(stack)).toBe('handlePipelineError')
  })

  it('skips Object / process / Promise frames', () => {
    const stack = `Error: boom
    at Object.<anonymous> (foo:1:1)
    at Promise.then (<anonymous>)
    at runPhase3 (src/lib/pipeline.ts:42:1)`
    expect(extractSymbolFromStack(stack)).toBe('runPhase3')
  })

  it('returns null on undefined / empty stack', () => {
    expect(extractSymbolFromStack(undefined)).toBeNull()
    expect(extractSymbolFromStack('')).toBeNull()
  })

  it('returns null when no usable frame', () => {
    expect(extractSymbolFromStack('not a stack trace')).toBeNull()
  })

  it('handles dotted names (Class.method)', () => {
    const stack = `Error: boom
    at GeminiProvider.generate (src/lib/providers/gemini.ts:620:5)`
    expect(extractSymbolFromStack(stack)).toBe('GeminiProvider.generate')
  })
})
