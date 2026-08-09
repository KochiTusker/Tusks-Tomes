// Tests for the whisper.cpp bridge router.
//
// The bridge exists because we deliberately do NOT ship a binary — the user
// supplies one. That makes two behaviours load-bearing, and both are pinned
// here:
//
//   1. Path validation. binaryPath/modelPath come from user input and are
//      spawned, so a relative path (resolved against whatever cwd the server
//      happens to have) must be rejected outright.
//   2. Honest reporting. Someone who downloads an official whisper.cpp release
//      expecting AMD acceleration gets a CPU-only build. The status summary
//      must say so plainly rather than reporting a cheerful "ready".

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockSpawn, resetSpawnMock, spawnCalls, whenCommand } from '../testing/spawnMock.js'
import { withRouter } from '../testing/httpFixture.js'
import path from 'node:path'

vi.mock('node:child_process', () => mockSpawn())

// Isolate config + model stat from the real machine.
const store: Record<string, unknown> = {}
let modelSize = 0
vi.mock('../appData.js', async () => {
  const actual = await vi.importActual<typeof import('../appData.js')>('../appData.js')
  return {
    ...actual,
    configDir: () => '/tmp/tt-test-config',
    readJson: async (p: string, dflt: unknown) => store[p] ?? dflt,
    writeJson: async (p: string, v: unknown) => {
      store[p] = v
    },
  }
})

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    default: actual,
    promises: {
      ...actual.promises,
      stat: async () =>
        modelSize > 0 ? { size: modelSize, isFile: () => true } : Promise.reject(new Error('ENOENT')),
    },
  }
})

// Built with path.join so the key matches whisperCppConfigPath() byte for
// byte — on Windows that's a backslash separator, and a hand-written
// forward-slash string silently misses, making every status read return the
// not-configured default.
const CFG = path.join('/tmp/tt-test-config', 'whisper-cpp.json')

/** A realistic --help banner: whisper.cpp prints system_info to stderr. */
const helpOutput = (systeminfo: string) =>
  `usage: whisper-cli [options] file0.wav\n` +
  `  -m, --model FNAME    model path\n` +
  `whisper.cpp v1.9.2\n` +
  `system_info: ${systeminfo}\n`

beforeEach(() => {
  resetSpawnMock()
  for (const k of Object.keys(store)) delete store[k]
  modelSize = 0
  vi.resetModules()
})

async function getStatus() {
  const { whisperCppRouter } = await import('./whisperCpp.js')
  return withRouter('/api/whisper-cpp', whisperCppRouter(), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/status`)
    expect(res.status).toBe(200)
    return res.json()
  })
}

async function postConfig(body: unknown) {
  const { whisperCppRouter } = await import('./whisperCpp.js')
  return withRouter('/api/whisper-cpp', whisperCppRouter(), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: res.status, body: await res.json() }
  })
}

describe('POST /config path validation', () => {
  it('rejects a relative binary path', async () => {
    // These paths get spawned. A relative one resolves against whatever cwd
    // the server has, which is neither predictable nor auditable.
    const { status, body } = await postConfig({ binaryPath: './whisper-cli', modelPath: '/m/ggml.bin' })
    expect(status).toBe(400)
    expect(body.error).toMatch(/absolute/i)
  })

  it('rejects a relative model path', async () => {
    const { status } = await postConfig({ binaryPath: '/opt/whisper-cli', modelPath: 'ggml.bin' })
    expect(status).toBe(400)
  })

  it('accepts absolute paths', async () => {
    whenCommand('/opt/whisper-cli', () => ({ code: 0, stdout: helpOutput('VULKAN = 1') }))
    const { status } = await postConfig({ binaryPath: '/opt/whisper-cli', modelPath: '/m/ggml.bin' })
    expect(status).toBe(200)
  })
})

describe('GET /status', () => {
  it('reports not-configured before setup, without spawning anything', async () => {
    const s = await getStatus()
    expect(s.configured).toBe(false)
    expect(s.summary).toMatch(/not set up/i)
    expect(spawnCalls()).toHaveLength(0)
  })

  it('spawns the binary with shell:false and a neutral cwd', async () => {
    // The path is user-supplied config: it must never be concatenated into a
    // shell string, and the process must not resolve relative paths against
    // the project tree.
    store[CFG] = { binaryPath: '/opt/whisper-cli', modelPath: '/m/ggml.bin' }
    whenCommand('/opt/whisper-cli', () => ({ code: 0, stdout: helpOutput('VULKAN = 1') }))
    await getStatus()
    const call = spawnCalls().find((c) => c.command === '/opt/whisper-cli')
    expect(call?.options.shell).toBe(false)
    expect(String(call?.options.cwd)).not.toContain('Tusks-Tomes')
  })

  it('warns plainly when the build is CPU-only', async () => {
    // The exact case this bridge exists to surface.
    store[CFG] = { binaryPath: '/opt/whisper-cli', modelPath: '/m/ggml.bin' }
    modelSize = 1_500_000_000
    whenCommand('/opt/whisper-cli', () => ({ code: 0, stdout: helpOutput('AVX = 1 | BLAS = 1 | VULKAN = 0 | CUDA = 0') }))
    const s = await getStatus()
    expect(s.backends.cpuOnly).toBe(true)
    expect(s.summary).toMatch(/CPU-only/i)
    expect(s.summary).toMatch(/will not use your graphics card/i)
  })

  it('confirms GPU acceleration when a real backend is compiled in', async () => {
    store[CFG] = { binaryPath: '/opt/whisper-cli', modelPath: '/m/ggml.bin' }
    modelSize = 1_500_000_000
    whenCommand('/opt/whisper-cli', () => ({ code: 0, stdout: helpOutput('AVX = 1 | VULKAN = 1') }))
    const s = await getStatus()
    expect(s.binaryOk).toBe(true)
    expect(s.modelOk).toBe(true)
    expect(s.summary).toMatch(/GPU acceleration via Vulkan/i)
  })

  it('flags a model file too small to be real weights', async () => {
    // Catches a Git-LFS pointer or a truncated download, which would
    // otherwise fail deep inside the binary with an opaque error.
    store[CFG] = { binaryPath: '/opt/whisper-cli', modelPath: '/m/ggml.bin' }
    modelSize = 1024
    whenCommand('/opt/whisper-cli', () => ({ code: 0, stdout: helpOutput('VULKAN = 1') }))
    const s = await getStatus()
    expect(s.modelOk).toBe(false)
    expect(s.summary).toMatch(/model file is missing or too small/i)
  })

  it('reports a binary that will not run, without throwing', async () => {
    store[CFG] = { binaryPath: '/opt/whisper-cli', modelPath: '/m/ggml.bin' }
    const enoent = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
    whenCommand('/opt/whisper-cli', () => ({ code: -1, emitError: enoent }))
    const s = await getStatus()
    expect(s.binaryOk).toBe(false)
    expect(s.summary).toMatch(/didn't run/i)
  })

  it("does not accept output from something that isn't whisper.cpp", async () => {
    // Guards against pointing the bridge at an arbitrary executable.
    store[CFG] = { binaryPath: '/opt/not-whisper', modelPath: '/m/ggml.bin' }
    whenCommand('/opt/not-whisper', () => ({ code: 0, stdout: 'hello from some other program' }))
    const s = await getStatus()
    expect(s.binaryOk).toBe(false)
  })
})
