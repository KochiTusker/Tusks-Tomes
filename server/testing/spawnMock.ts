// Shared child_process.spawn mocking harness for vitest tests.
//
// Why this exists: the codebase has multiple spawn call sites
// (server/api/updater.ts → git, server/api/localProxy.ts → ollama/lms/
// unsloth, scripts/* → various) and none of them were testable before
// this helper landed. Without a primitive, each test would re-invent
// the wheel and the result is what we got: spawn-shell-false flipped to
// true without any test catching it, because no test inspected the
// spawn call.
//
// Usage in a test file:
//
//     import { mockSpawn, whenCommand, spawnCalls, resetSpawnMock } from
//       '../testing/spawnMock.js'
//     import { vi, beforeEach, afterEach, expect } from 'vitest'
//
//     vi.mock('node:child_process', () => mockSpawn())
//     beforeEach(() => resetSpawnMock())
//
//     it('spawns ollama with shell:true', async () => {
//       whenCommand('ollama', () => ({ code: 0 }))
//       await import('../api/localProxy.js')
//       // … exercise the route …
//       expect(spawnCalls()[0].options.shell).toBe(true)
//     })

import { EventEmitter } from 'node:events'
import { vi } from 'vitest'

export type SpawnCall = {
  command: string
  args: readonly string[]
  options: { shell?: boolean | string; cwd?: string; env?: Record<string, string>; detached?: boolean; stdio?: unknown }
}

export type SpawnResult = {
  code: number
  stdout?: string
  stderr?: string
  emitError?: Error
  /** When set, the lifecycle (stdout/close) fires after this many ms via
   *  setTimeout instead of on the next microtask. Lets tests simulate a
   *  slow child so abort/early-close handling can be exercised. */
  delayMs?: number
  /** When set, the child's stdin emits this error instead of running the
   *  normal lifecycle — simulating a CLI that exits before draining the
   *  prompt (EPIPE / EOF), which is what happens when it is not logged in. */
  stdinError?: Error
}

const calls: SpawnCall[] = []
const handlers = new Map<string, (call: SpawnCall) => SpawnResult>()

function makeChild(result: SpawnResult): EventEmitter & {
  stdout: EventEmitter
  stderr: EventEmitter
  stdin: EventEmitter & { write: (chunk: unknown) => boolean; end: () => void }
  pid: number
  unref: () => void
  kill: () => void
} {
  const child = new EventEmitter() as ReturnType<typeof makeChild>
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  // stdin is a real EventEmitter: production code attaches an 'error'
  // listener to catch the async EPIPE that happens when a CLI exits before
  // draining a large prompt. A bare object made that throw in every test.
  const stdin = new EventEmitter() as ReturnType<typeof makeChild>['stdin']
  stdin.write = () => true
  stdin.end = () => undefined
  child.stdin = stdin
  child.pid = 1234
  child.unref = () => undefined
  child.kill = () => undefined
  // Fire the lifecycle on the next microtask so callers attaching
  // listeners synchronously after spawn(...) still see the events. When
  // delayMs is set, defer to a timer instead so tests can simulate a slow
  // child (and exercise abort / early-close handling in the interim).
  const fire = () => {
    if (result.emitError) {
      child.emit('error', result.emitError)
      return
    }
    if (result.stdinError) {
      child.stdin.emit('error', result.stdinError)
      return
    }
    if (result.stdout) child.stdout.emit('data', Buffer.from(result.stdout))
    if (result.stderr) child.stderr.emit('data', Buffer.from(result.stderr))
    child.emit('close', result.code)
    child.emit('exit', result.code)
  }
  if (result.delayMs && result.delayMs > 0) setTimeout(fire, result.delayMs)
  else queueMicrotask(fire)
  return child
}

/** Returns an object suitable for `vi.mock('node:child_process', () => mockSpawn())`. */
export function mockSpawn(): { spawn: ReturnType<typeof vi.fn>; spawnSync: ReturnType<typeof vi.fn> } {
  return {
    spawn: vi.fn((command: string, args: readonly string[] = [], options: SpawnCall['options'] = {}) => {
      const call: SpawnCall = { command, args, options }
      calls.push(call)
      const handler = handlers.get(command) ?? ((): SpawnResult => ({ code: 0 }))
      return makeChild(handler(call))
    }),
    spawnSync: vi.fn((command: string, args: readonly string[] = [], options: SpawnCall['options'] = {}) => {
      const call: SpawnCall = { command, args, options }
      calls.push(call)
      const handler = handlers.get(command) ?? ((): SpawnResult => ({ code: 0 }))
      const result = handler(call)
      return {
        pid: 1234,
        status: result.code,
        stdout: Buffer.from(result.stdout ?? ''),
        stderr: Buffer.from(result.stderr ?? ''),
        signal: null,
        output: [null, Buffer.from(result.stdout ?? ''), Buffer.from(result.stderr ?? '')],
      }
    }),
  }
}

/** Register a scripted response for a specific command. The handler
 *  receives the actual call (so it can inspect args) and returns the
 *  exit code + optional stdout/stderr. Unregistered commands default
 *  to { code: 0 }. */
export function whenCommand(name: string, handler: (call: SpawnCall) => SpawnResult): void {
  handlers.set(name, handler)
}

/** All spawn calls observed since the last `resetSpawnMock()`. */
export function spawnCalls(): readonly SpawnCall[] {
  return calls.slice()
}

/** Reset between tests — clears both calls and handlers. */
export function resetSpawnMock(): void {
  calls.length = 0
  handlers.clear()
}
