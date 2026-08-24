/** @vitest-environment jsdom */
// Connection probes: present and absent fixtures for each, with the
// status and remedy the row will render. The codex fixture pins a real
// server quirk — /api/codex/status reports authenticated:true even when
// the CLI is not installed, so the installed check MUST come first.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  probeClaudeCode,
  probeCodex,
  probeLocalRunners,
  probeWhisperCpp,
} from './connections'

function mockFetchJson(byUrl: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      for (const [frag, body] of Object.entries(byUrl)) {
        if (String(url).includes(frag)) {
          return { ok: true, json: async () => body } as Response
        }
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response
    }),
  )
}

afterEach(() => vi.unstubAllGlobals())

describe('probeClaudeCode', () => {
  it('connected when installed and signed in', async () => {
    mockFetchJson({ '/api/claude-code/status': { installed: true, version: '2.1.229', authenticated: true } })
    const r = await probeClaudeCode()
    expect(r.state).toBe('connected')
    expect(r.detail).toContain('2.1.229')
    expect(r.remedy).toBeUndefined()
  })
  it('attention with a login remedy when installed but signed out', async () => {
    mockFetchJson({ '/api/claude-code/status': { installed: true, version: '2.1.229', authenticated: false } })
    const r = await probeClaudeCode()
    expect(r.state).toBe('attention')
    expect(r.remedy).toContain('claude login')
  })
  it('absent with an install remedy when the CLI is missing', async () => {
    mockFetchJson({ '/api/claude-code/status': { installed: false, version: null, authenticated: false } })
    const r = await probeClaudeCode()
    expect(r.state).toBe('absent')
    expect(r.remedy).toContain('Install')
  })
})

describe('a failed probe is never reported as absent', () => {
  // The regression this pins: a long-lived server exhausted Windows'
  // ability to spawn (0xC0000142), every CLI check returned installed:false,
  // and the UI told the user a working CLI "was not found on this machine".
  it('claude: probeFailed wins over installed:false', async () => {
    mockFetchJson({ '/api/claude-code/status': {
      installed: false, version: null, authenticated: true,
      probeFailed: "the check could not start (0xc0000142) — restarting Tusk's Tomes usually clears this",
    } })
    const r = await probeClaudeCode()
    expect(r.state).toBe('unknown')
    expect(r.detail).toContain('Could not check')
    expect(r.remedy).toContain('says nothing about whether it is installed')
  })
  it('codex: probeFailed wins over installed:false', async () => {
    mockFetchJson({ '/api/codex/status': {
      installed: false, version: null, authenticated: true, probeFailed: 'the check timed out',
    } })
    const r = await probeCodex()
    expect(r.state).toBe('unknown')
  })
})

describe('probeCodex', () => {
  it('absent wins over the authenticated:true quirk the live server returns', async () => {
    // Verbatim from the running server on 2026-08-19 with no codex CLI.
    mockFetchJson({
      '/api/codex/status': {
        installed: false,
        version: null,
        authenticated: true,
        models: ['default', 'gpt-5-codex'],
      },
    })
    const r = await probeCodex()
    expect(r.state).toBe('absent')
    expect(r.remedy).toContain('@openai/codex')
  })
  it('connected when genuinely installed and signed in', async () => {
    mockFetchJson({ '/api/codex/status': { installed: true, version: '0.9.1', authenticated: true } })
    const r = await probeCodex()
    expect(r.state).toBe('connected')
  })
})

describe('probeLocalRunners', () => {
  it('absent with a start-a-runner remedy when nothing answers', async () => {
    mockFetchJson({ '/api/local-llm/detect': { backends: [
      { name: 'ollama', baseUrl: 'http://localhost:11434', reachable: false, models: [] },
    ] } })
    const r = await probeLocalRunners()
    expect(r.state).toBe('absent')
    expect(r.remedy).toMatch(/Ollama/)
  })
  it('connected with runner names and a model count', async () => {
    mockFetchJson({ '/api/local-llm/detect': { backends: [
      { name: 'ollama', baseUrl: 'http://localhost:11434', reachable: true, models: ['qwen3:30b', 'llama4'] },
      { name: 'lmstudio', baseUrl: 'http://localhost:1234', reachable: false, models: [] },
    ] } })
    const r = await probeLocalRunners()
    expect(r.state).toBe('connected')
    expect(r.detail).toContain('ollama')
    expect(r.detail).toContain('2 models')
  })
})

describe('probeWhisperCpp', () => {
  it('absent when never configured — verbatim live shape', async () => {
    mockFetchJson({ '/api/whisper-cpp/status': {
      configured: false, binaryPath: null, modelPath: null, binaryOk: false,
      version: null, modelOk: false, modelSizeMb: null, backends: null,
      summary: 'Not set up yet — point this at your whisper.cpp binary and a model file.',
    } })
    const r = await probeWhisperCpp()
    expect(r.state).toBe('absent')
  })
  it('attention when a saved path stopped resolving', async () => {
    mockFetchJson({ '/api/whisper-cpp/status': {
      configured: true, binaryOk: false, modelOk: true, summary: 'binary missing at saved path',
    } })
    const r = await probeWhisperCpp()
    expect(r.state).toBe('attention')
    expect(r.remedy).toContain('path')
  })
  it('connected when both paths verify', async () => {
    mockFetchJson({ '/api/whisper-cpp/status': {
      configured: true, binaryOk: true, modelOk: true, summary: 'whisper-cli 1.7 · large-v3 (2.9 GB)',
    } })
    const r = await probeWhisperCpp()
    expect(r.state).toBe('connected')
    expect(r.detail).toContain('large-v3')
  })
})
