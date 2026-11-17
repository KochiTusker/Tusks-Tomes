// Tests for transcription engine selection.
//
// `chooseEngine` decides what every audio upload runs through. The failure it
// guards against is silent in both directions: routing to whisper.cpp when the
// bridge isn't ready fails the run, and quietly staying on faster-whisper when
// the user has configured whisper.cpp looks like "the add-on does nothing".
// Neither surfaces as an obvious error, so the policy is pinned here.
//
// `activeEngine` applies that policy to live configuration. Two things are
// pinned there: that configuration alone is enough (no install marker, no
// toggle — a bridge that checks out is used), and that the probe behind it
// is cached, because probing means running the user's binary and a session
// drain asks hundreds of times in a row.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WhisperCppStatus } from '../../routes/whisperCpp.js'
import { activeEngine, chooseEngine, invalidateWhisperCppStatus } from './invoke.js'

const statusMock = vi.hoisted(() => vi.fn<() => Promise<WhisperCppStatus>>())

vi.mock('../../routes/whisperCpp.js', () => ({
  whisperCppStatus: statusMock,
  // The marker file older releases wrote is absent here, and the bridge is
  // still chosen below: configuration is the whole of the rule.
}))

const ready = {
  cppAddonLoaded: true,
  cppConfigured: true,
  cppBinaryOk: true,
  cppModelOk: true,
}

const configuredAndWorking: WhisperCppStatus = {
  configured: true,
  binaryPath: '/opt/whisper-cli',
  modelPath: '/models/ggml-large-v3.bin',
  binaryOk: true,
  version: '1.9.2',
  modelOk: true,
  modelSizeMb: 3000,
  backends: {
    vulkan: true,
    cuda: false,
    metal: false,
    coreml: false,
    openvino: false,
    blas: false,
    cpuOnly: false,
    raw: 'system_info: AVX = 1 | VULKAN = 1',
  },
  summary: 'Ready, with GPU acceleration via Vulkan.',
}

const unconfigured: WhisperCppStatus = {
  configured: false,
  binaryPath: null,
  modelPath: null,
  binaryOk: false,
  version: null,
  modelOk: false,
  modelSizeMb: null,
  backends: null,
  summary: 'Not set up yet.',
}

describe('chooseEngine', () => {
  it('uses whisper.cpp only when everything checks out', () => {
    expect(chooseEngine(ready)).toBe('whisper-cpp')
  })

  it('stays on faster-whisper when the add-on is not mounted', () => {
    // The bridge is a builtin today, so this input is always true in
    // production; the policy still has to hold if that ever changes.
    expect(chooseEngine({ ...ready, cppAddonLoaded: false })).toBe('faster-whisper')
  })

  it('falls back while the user is mid-setup', () => {
    // Enabled but no paths entered yet. Someone part-way through configuring
    // should still be able to transcribe rather than hitting a wall.
    expect(chooseEngine({ ...ready, cppConfigured: false })).toBe('faster-whisper')
  })

  it('falls back when the binary does not run', () => {
    // A wrong path or a non-executable file must not take transcription down.
    expect(chooseEngine({ ...ready, cppBinaryOk: false })).toBe('faster-whisper')
  })

  it('falls back when the model is missing or bogus', () => {
    // Usually a Git-LFS pointer rather than real weights.
    expect(chooseEngine({ ...ready, cppModelOk: false })).toBe('faster-whisper')
  })

  it('requires ALL four conditions, not merely most of them', () => {
    // Guards against the check being loosened to something like
    // "configured || binaryOk" during a future refactor.
    const keys = ['cppAddonLoaded', 'cppConfigured', 'cppBinaryOk', 'cppModelOk'] as const
    for (const k of keys) {
      expect(chooseEngine({ ...ready, [k]: false })).toBe('faster-whisper')
    }
  })

  it('is deterministic and side-effect free', () => {
    const input = { ...ready }
    expect(chooseEngine(input)).toBe(chooseEngine(input))
    expect(input).toEqual(ready)
  })
})

describe('activeEngine', () => {
  beforeEach(() => {
    statusMock.mockReset()
    invalidateWhisperCppStatus()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('chooses whisper.cpp on configuration alone — no install marker required', async () => {
    statusMock.mockResolvedValue(configuredAndWorking)
    expect(await activeEngine()).toBe('whisper-cpp')
  })

  it('stays on faster-whisper while the bridge is unconfigured', async () => {
    statusMock.mockResolvedValue(unconfigured)
    expect(await activeEngine()).toBe('faster-whisper')
  })

  it('probes once for a run of calls inside the TTL', async () => {
    statusMock.mockResolvedValue(configuredAndWorking)
    await activeEngine()
    await activeEngine()
    await activeEngine()
    expect(statusMock).toHaveBeenCalledTimes(1)
  })

  it('coalesces concurrent callers onto one probe', async () => {
    statusMock.mockResolvedValue(configuredAndWorking)
    const engines = await Promise.all([activeEngine(), activeEngine(), activeEngine()])
    expect(engines).toEqual(['whisper-cpp', 'whisper-cpp', 'whisper-cpp'])
    expect(statusMock).toHaveBeenCalledTimes(1)
  })

  it('probes again once the TTL has passed', async () => {
    vi.useFakeTimers()
    statusMock.mockResolvedValue(configuredAndWorking)
    await activeEngine()
    vi.setSystemTime(Date.now() + 31_000)
    await activeEngine()
    expect(statusMock).toHaveBeenCalledTimes(2)
  })

  it('re-probes straight away after invalidation', async () => {
    statusMock.mockResolvedValue(unconfigured)
    expect(await activeEngine()).toBe('faster-whisper')
    // The user has just saved the paths in Settings.
    statusMock.mockResolvedValue(configuredAndWorking)
    invalidateWhisperCppStatus()
    expect(await activeEngine()).toBe('whisper-cpp')
    expect(statusMock).toHaveBeenCalledTimes(2)
  })

  it('falls back on a probe that throws, and does not remember the failure', async () => {
    statusMock.mockRejectedValueOnce(new Error('config unreadable'))
    expect(await activeEngine()).toBe('faster-whisper')
    statusMock.mockResolvedValue(configuredAndWorking)
    expect(await activeEngine()).toBe('whisper-cpp')
    expect(statusMock).toHaveBeenCalledTimes(2)
  })
})
