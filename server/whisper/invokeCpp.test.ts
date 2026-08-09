// Tests for the whisper.cpp transcription bridge.
//
// SCOPE: these test what TUSK'S TOMES is responsible for, not what the user
// is. We can't test whether someone's self-compiled binary is fast, or whether
// their driver works — that's theirs. What we own is:
//
//   1. Invoking it correctly (the right flags; a wrong one still produces *a*
//      transcript, so this drifts silently).
//   2. Spawning it safely (no shell, absolute path, neutral cwd).
//   3. Returning EXACTLY the same object shape as the faster-whisper sidecar,
//      so the Upload/Sessions UI works with no changes at all.
//   4. Translating failures into something a user can act on.
//
// Point 3 is the one that makes "hook it straight into the UI" true, so it is
// asserted against the real TranscribeResult contract rather than by eye.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { mockSpawn, resetSpawnMock, spawnCalls, whenCommand } from '../testing/spawnMock.js'
import { buildWhisperCppArgs, explainFailure } from './invokeCpp.js'

vi.mock('node:child_process', () => mockSpawn())

// The binary writes JSON to a file, so the bridge reads it back. Fake that
// file rather than the process.
let jsonOnDisk: string | null = null
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    default: actual,
    promises: {
      ...actual.promises,
      readFile: async (p: string, enc?: unknown) =>
        String(p).includes('tusks-whispercpp-') && jsonOnDisk !== null
          ? jsonOnDisk
          : actual.promises.readFile(p as never, enc as never),
      rm: async () => undefined,
      stat: async () => ({ size: 1_500_000_000, isFile: () => true }),
    },
  }
})

const CFG = path.join('/tmp/tt-cpp-config', 'whisper-cpp.json')
const store: Record<string, unknown> = {
  [CFG]: { binaryPath: '/opt/whisper-cli', modelPath: '/models/ggml-large-v3.bin' },
}
vi.mock('../appData.js', async () => {
  const actual = await vi.importActual<typeof import('../appData.js')>('../appData.js')
  return {
    ...actual,
    configDir: () => '/tmp/tt-cpp-config',
    readJson: async (p: string, dflt: unknown) => store[p] ?? dflt,
    writeJson: async () => undefined,
  }
})

const HELP = 'usage: whisper-cli\n  -m, --model FNAME\nwhisper.cpp v1.9.2\nsystem_info: AVX = 1 | VULKAN = 1\n'

const TRANSCRIPT = JSON.stringify({
  result: { language: 'en' },
  transcription: [
    {
      text: ' The bard rolled a one.',
      offsets: { from: 0, to: 1800 },
      tokens: [
        { text: ' The', offsets: { from: 0, to: 300 }, p: 0.99 },
        { text: ' bard', offsets: { from: 300, to: 700 }, p: 0.97 },
        { text: ' rolled', offsets: { from: 700, to: 1200 }, p: 0.95 },
        { text: ' a', offsets: { from: 1200, to: 1400 }, p: 0.99 },
        { text: ' one', offsets: { from: 1400, to: 1700 }, p: 0.96 },
        { text: '.', offsets: { from: 1700, to: 1800 }, p: 0.7 },
      ],
    },
  ],
})

beforeEach(() => {
  resetSpawnMock()
  jsonOnDisk = TRANSCRIPT
  vi.resetModules()
  // Both the status probe (--help) and the transcription run use this binary.
  whenCommand('/opt/whisper-cli', () => ({ code: 0, stdout: HELP }))
})

async function run(overrides: Record<string, unknown> = {}) {
  const { transcribeFileWithWhisperCpp } = await import('./invokeCpp.js')
  return transcribeFileWithWhisperCpp({ audio: '/audio/session.wav', ...overrides } as never)
}

describe('argument construction (our responsibility)', () => {
  const base = {
    binaryPath: '/opt/whisper-cli',
    modelPath: '/models/ggml-large-v3.bin',
    audioPath: '/audio/session.wav',
    outputBase: '/tmp/out',
  }

  it('requests token-level JSON, not plain JSON', () => {
    // --output-json omits tokens, which silently costs word timings, which
    // liveQueue uses to split utterances on silence gaps.
    const args = buildWhisperCppArgs(base)
    expect(args).toContain('--output-json-full')
    expect(args).not.toContain('--output-json')
  })

  it('disables cross-segment context, matching the faster-whisper sidecar', () => {
    // The sidecar sets condition_on_previous_text=False. Without the
    // equivalent here, whisper.cpp loops on repeated phrases.
    expect(buildWhisperCppArgs(base)).toContain('--no-context')
  })

  it('passes model, audio and output as separate argv entries', () => {
    const args = buildWhisperCppArgs(base)
    expect(args[args.indexOf('--model') + 1]).toBe('/models/ggml-large-v3.bin')
    expect(args[args.indexOf('--file') + 1]).toBe('/audio/session.wav')
    expect(args[args.indexOf('--output-file') + 1]).toBe('/tmp/out')
  })

  it('defaults to auto language detection and honours an explicit one', () => {
    expect(buildWhisperCppArgs(base)[buildWhisperCppArgs(base).indexOf('--language') + 1]).toBe('auto')
    const en = buildWhisperCppArgs({ ...base, language: 'en' })
    expect(en[en.indexOf('--language') + 1]).toBe('en')
  })

  it('only passes a prompt when there is one', () => {
    expect(buildWhisperCppArgs(base)).not.toContain('--prompt')
    expect(buildWhisperCppArgs({ ...base, initialPrompt: '  ' })).not.toContain('--prompt')
    expect(buildWhisperCppArgs({ ...base, initialPrompt: 'Seoyeon, Yuzuki' })).toContain('--prompt')
  })

  it('keeps paths with spaces as single argv entries', () => {
    // Never shell-quoted, never concatenated — this is why shell:false matters.
    const args = buildWhisperCppArgs({ ...base, audioPath: 'C:\\My Sessions\\game one.wav' })
    expect(args).toContain('C:\\My Sessions\\game one.wav')
  })
})

describe('safe invocation (our responsibility)', () => {
  it('spawns with shell:false, an absolute binary, and a neutral cwd', async () => {
    await run()
    const call = spawnCalls().find((c) => c.args.includes('--output-json-full'))
    expect(call).toBeTruthy()
    expect(call?.options.shell).toBe(false)
    expect(path.isAbsolute(String(call?.command))).toBe(true)
    expect(String(call?.options.cwd)).toBe(os.tmpdir())
  })

  it('never puts the audio path on a shell command line', async () => {
    await run({ audio: '/audio/a; rm -rf ~.wav' })
    const call = spawnCalls().find((c) => c.args.includes('--output-json-full'))
    // Present as its own argv entry, and shell disabled — so the shell
    // metacharacter is inert.
    expect(call?.args).toContain('/audio/a; rm -rf ~.wav')
    expect(call?.options.shell).toBe(false)
  })
})

describe('output contract — this is what makes the UI work unchanged', () => {
  it('returns every field TranscribeResult declares', async () => {
    const r = await run({ speakerId: 'u_1', speakerDisplay: 'Yuzuki' })
    // Same keys the faster-whisper sidecar produces. If this drifts, the
    // Sessions tab and speaker mapping break in places far from here.
    expect(Object.keys(r).sort()).toEqual(
      ['device', 'durationMs', 'elapsedMs', 'language', 'model', 'segments', 'speakerDisplay', 'speakerId'].sort(),
    )
  })

  it('carries speaker identity through, so per-speaker attribution survives', async () => {
    const r = await run({ speakerId: 'u_7', speakerDisplay: 'Seoyeon' })
    expect(r.speakerId).toBe('u_7')
    expect(r.speakerDisplay).toBe('Seoyeon')
  })

  it('produces segments with word timings', async () => {
    const r = await run()
    expect(r.segments).toHaveLength(1)
    expect(r.segments[0].text).toBe('The bard rolled a one.')
    expect(r.segments[0].words.map((w) => w.text)).toEqual(['The', 'bard', 'rolled', 'a', 'one.'])
    expect(r.segments[0].words[0]).toHaveProperty('startMs')
    expect(r.segments[0].words[0]).toHaveProperty('confidence')
  })

  it('reports duration and detected language', async () => {
    const r = await run()
    expect(r.durationMs).toBe(1800)
    expect(r.language).toBe('en')
  })

  it('reports the GPU backend actually in use as the device', async () => {
    // Surfaces in the Sessions tab: a user who compiled for Vulkan should see
    // that, not a generic "cuda" inherited from the other engine.
    const r = await run()
    expect(r.device).toBe('vulkan')
  })

  it('names the model from the file the user chose', async () => {
    const r = await run()
    expect(r.model).toBe('ggml-large-v3.bin')
  })
})

describe('failure translation (our responsibility)', () => {
  it('explains a model that will not load', () => {
    expect(explainFailure(1, 'whisper_init: failed to load model')).toMatch(/GGML .bin|Git-LFS/i)
  })

  it('explains GPU out-of-memory with an actionable suggestion', () => {
    expect(explainFailure(1, 'vk::DeviceOutOfMemory')).toMatch(/smaller model/i)
  })

  it('explains a Vulkan device failure as a driver problem', () => {
    expect(explainFailure(1, 'ERROR: vulkan device lost')).toMatch(/driver/i)
  })

  it('falls back to the exit code and tail of output', () => {
    const msg = explainFailure(9, 'something unexpected happened')
    expect(msg).toMatch(/exited with code 9/)
    expect(msg).toMatch(/something unexpected/)
  })

  it('throws a useful error when the binary produced no output file', async () => {
    jsonOnDisk = null
    // The handler receives the whole SpawnCall, not the argv array — the
    // status probe (--help) and the transcription run share a binary, so they
    // have to be told apart by inspecting call.args.
    whenCommand('/opt/whisper-cli', (call) =>
      call.args.includes('--help') ? { code: 0, stdout: HELP } : { code: 1, stderr: 'failed to load model' },
    )
    await expect(run()).rejects.toThrow(/GGML .bin|Git-LFS/i)
  })
})
