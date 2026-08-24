// Tests for transcription engine selection.
//
// `chooseEngine` decides what every audio upload runs through. The failure it
// guards against is silent in both directions: routing to whisper.cpp when the
// bridge isn't ready fails the run, and quietly staying on faster-whisper when
// the user has configured whisper.cpp looks like "the add-on does nothing".
// Neither surfaces as an obvious error, so the policy is pinned here.

import { describe, expect, it } from 'vitest'
import { chooseEngine } from './invoke.js'

const ready = {
  cppAddonLoaded: true,
  cppConfigured: true,
  cppBinaryOk: true,
  cppModelOk: true,
}

describe('chooseEngine', () => {
  it('uses whisper.cpp only when everything checks out', () => {
    expect(chooseEngine(ready)).toBe('whisper-cpp')
  })

  it('stays on faster-whisper when the add-on is not enabled', () => {
    // The default for the overwhelming majority of installs.
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
