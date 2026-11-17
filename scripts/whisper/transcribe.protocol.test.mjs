// Protocol tests for the Whisper sidecar (scripts/whisper/transcribe.py).
//
// The Node-side worker reads the sidecar's stdout as line-delimited JSON and
// keys on `kind`. The contract it relies on is easy to break from the Python
// side without noticing — a stray print() before the ready envelope, a
// progress line leaking into one-shot mode, the ready envelope echoing the
// device that was *asked for* rather than the one the model landed on — and
// none of that is visible from the TypeScript tests, which stub the child
// process. So these tests run the real script under a real interpreter.
//
// faster-whisper, CTranslate2 and torch are replaced by stub packages written
// to a temp directory and put first on PYTHONPATH. That keeps the run hermetic
// (no model weights, no GPU, a fraction of a second) and lets the stubs pin
// the one thing that matters here: the model reports `cpu` when `cuda` was
// requested, so the envelopes must say `cpu`.

import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(HERE, 'transcribe.py')

/** Find a Python 3 interpreter the way a user's shell would. */
function findPython() {
  const candidates =
    process.platform === 'win32'
      ? [
          ['py', ['-3']],
          ['python', []],
          ['python3', []],
        ]
      : [
          ['python3', []],
          ['python', []],
          ['py', ['-3']],
        ]
  for (const [cmd, args] of candidates) {
    let r
    try {
      r = spawnSync(cmd, [...args, '-c', 'import sys; print(sys.version_info[0])'], {
        encoding: 'utf8',
        timeout: 10_000,
      })
    } catch {
      continue
    }
    if (r.status === 0 && r.stdout.trim() === '3') return { cmd, args }
  }
  return null
}

const python = findPython()
if (!python) {
  console.warn(
    '[transcribe.protocol.test] skipped: no Python 3 interpreter found on PATH (tried py -3, python, python3).'
  )
}

// Stub packages. Only the surface transcribe.py touches is implemented.
//
// The segments are yielded lazily with a 0.4 s pause between them, so the
// three of them arrive over ~0.8 s of wall clock while spanning 2.5 s of
// simulated audio. That is enough for the first progress envelope to fire
// and too little for all three to, which is what makes the throttle
// observable rather than assumed.
const STUB_FASTER_WHISPER = `
import time
from types import SimpleNamespace

__version__ = "0.0.0-stub"


class _Backend:
    # What CTranslate2 exposes: the device the model resolved to.
    device = "cpu"
    compute_type = "int8"


class WhisperModel:
    def __init__(self, model_id, device="cuda", compute_type="default", **kwargs):
        self.model_id = model_id
        self.requested_device = device
        self.model = _Backend()

    def transcribe(self, audio, **kwargs):
        info = SimpleNamespace(duration=2.5, language=kwargs.get("language") or "en")

        def gen():
            ends = [0.8, 1.7, 2.5]
            start = 0.0
            for i, end in enumerate(ends):
                if i:
                    time.sleep(0.4)
                yield SimpleNamespace(
                    start=start,
                    end=end,
                    text=f"segment {i + 1}",
                    words=[SimpleNamespace(start=start, end=end, word=f"w{i + 1}", probability=0.9)],
                    avg_logprob=-0.1,
                )
                start = end

        return gen(), info
`

const STUB_CTRANSLATE2 = `
__version__ = "0.0.0-stub"


def get_cuda_device_count():
    return 0
`

const STUB_TORCH_HEALTHY = `
from types import SimpleNamespace

__version__ = "0.0.0-stub"
version = SimpleNamespace(cuda=None)
backends = SimpleNamespace(cudnn=SimpleNamespace(benchmark=True, deterministic=False))
`

const STUB_TORCH_BROKEN = `
raise ImportError("stub torch is deliberately unimportable")
`

function writePackage(root, name, source) {
  const dir = path.join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, '__init__.py'), source, 'utf8')
}

/** Run the script to completion with `stdinText` written and then closed. */
function runScript(args, { pythonPath, stdinText = '' }) {
  return new Promise((resolve, reject) => {
    const child = spawn(python.cmd, [...python.args, SCRIPT, ...args], {
      env: {
        ...process.env,
        PYTHONPATH: pythonPath,
        PYTHONUNBUFFERED: '1',
        PYTHONIOENCODING: 'utf-8',
      },
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (b) => (stdout += b.toString('utf8')))
    child.stderr.on('data', (b) => (stderr += b.toString('utf8')))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(stdinText)
  })
}

function parseEnvelopes(stdout) {
  return stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

describe.skipIf(!python)(
  'transcribe.py protocol (needs a Python 3 interpreter on PATH: py -3, python or python3)',
  () => {
    let root
    let healthyPath
    let brokenTorchPath
    let audioPath

    beforeAll(() => {
      root = mkdtempSync(path.join(tmpdir(), 'tusks-whisper-protocol-'))
      const healthy = path.join(root, 'stubs')
      const broken = path.join(root, 'stubs-broken-torch')
      writePackage(healthy, 'faster_whisper', STUB_FASTER_WHISPER)
      writePackage(healthy, 'ctranslate2', STUB_CTRANSLATE2)
      writePackage(healthy, 'torch', STUB_TORCH_HEALTHY)
      writePackage(broken, 'torch', STUB_TORCH_BROKEN)
      healthyPath = healthy
      // The broken torch shadows the healthy one; everything else resolves
      // from the healthy set.
      brokenTorchPath = [broken, healthy].join(path.delimiter)
      audioPath = path.join(root, 'utterance.flac')
      writeFileSync(audioPath, '')
    })

    afterAll(() => {
      if (root) rmSync(root, { recursive: true, force: true })
    })

    it('--serve announces loading, reports the real device, streams throttled progress, answers once', async () => {
      const request = {
        id: 'req-1',
        audio: audioPath,
        speakerId: 's1',
        speakerDisplay: 'Narrator',
        initialPrompt: '',
      }
      const { code, stdout, stderr } = await runScript(
        ['--serve', '--device', 'cuda', '--model', 'stub-model', '--compute-type', 'int8_float16'],
        { pythonPath: healthyPath, stdinText: JSON.stringify(request) + '\n' }
      )
      expect(code, stderr).toBe(0)

      const envelopes = parseEnvelopes(stdout)
      const kinds = envelopes.map((e) => e.kind)

      // Order: the two loading stages, then ready, then progress, then the
      // single response. Nothing else may appear on stdout.
      expect(kinds.slice(0, 3)).toEqual(['loading', 'loading', 'ready'])
      expect(envelopes[0]).toEqual({ kind: 'loading', stage: 'import' })
      expect(envelopes[1]).toEqual({ kind: 'loading', stage: 'model' })
      expect(kinds.at(-1)).toBe('response')
      expect(kinds.slice(3, -1).every((k) => k === 'progress')).toBe(true)
      expect(new Set(kinds)).toEqual(new Set(['loading', 'ready', 'progress', 'response']))

      // Ready carries the device the model actually loaded on — `cuda` was
      // requested, the stub landed on `cpu`, and `cpu` is the truth.
      const ready = envelopes[2]
      expect(ready.device).toBe('cpu')
      expect(ready.model).toBe('stub-model')
      expect(ready.computeType).toBe('int8_float16')
      expect(ready.versions).toEqual({
        faster_whisper: '0.0.0-stub',
        ctranslate2: '0.0.0-stub',
        torch: '0.0.0-stub',
        cuda: null,
      })
      expect(ready.cudaDevices).toBe(0)

      // Progress: at least one, tied to the request, monotonic, and fewer
      // than the three segments — a once-per-second throttle cannot emit
      // for all three when they arrive 0.4 s apart.
      const progress = envelopes.filter((e) => e.kind === 'progress')
      expect(progress.length).toBeGreaterThanOrEqual(1)
      expect(progress.length).toBeLessThanOrEqual(2)
      for (const p of progress) {
        expect(p.id).toBe('req-1')
        expect(p.durationMs).toBe(2500)
        expect(p.processedMs).toBeGreaterThan(0)
        expect(p.processedMs).toBeLessThanOrEqual(2500)
      }
      for (let i = 1; i < progress.length; i++) {
        expect(progress[i].processedMs).toBeGreaterThan(progress[i - 1].processedMs)
      }

      // Exactly one response, and it agrees with ready about the device.
      const responses = envelopes.filter((e) => e.kind === 'response')
      expect(responses).toHaveLength(1)
      const [response] = responses
      expect(response.id).toBe('req-1')
      expect(response.ok).toBe(true)
      expect(response.result.device).toBe('cpu')
      expect(response.result.model).toBe('stub-model')
      expect(response.result.durationMs).toBe(2500)
      expect(response.result.speakerId).toBe('s1')
      expect(response.result.speakerDisplay).toBe('Narrator')
      expect(response.result.segments).toHaveLength(3)
      expect(response.result.segments.map((s) => s.endMs)).toEqual([800, 1700, 2500])
    })

    it('--serve warns on stderr when torch cannot be imported, and still becomes ready', async () => {
      const { code, stdout, stderr } = await runScript(
        ['--serve', '--device', 'cuda', '--model', 'stub-model'],
        { pythonPath: brokenTorchPath, stdinText: '' }
      )
      expect(code, stderr).toBe(0)
      expect(stderr).toMatch(/WARNING: torch failed to import/)
      expect(stderr).toMatch(/GPU path may be unavailable/)

      const envelopes = parseEnvelopes(stdout)
      const ready = envelopes.find((e) => e.kind === 'ready')
      expect(ready).toBeDefined()
      expect(ready.device).toBe('cpu')
      expect(ready.versions.torch).toBeNull()
      expect(ready.versions.cuda).toBeNull()
      expect(ready.versions.faster_whisper).toBe('0.0.0-stub')
    })

    it('one-shot mode prints a single JSON document and no progress lines', async () => {
      const { code, stdout, stderr } = await runScript(
        ['--audio', audioPath, '--device', 'cuda', '--model', 'stub-model', '--speaker-id', 's1'],
        { pythonPath: healthyPath }
      )
      expect(code, stderr).toBe(0)

      // One document: JSON.parse over the whole of stdout only succeeds if
      // nothing else was printed around it.
      const doc = JSON.parse(stdout)
      expect(doc.kind).toBeUndefined()
      expect(stdout).not.toMatch(/"kind"\s*:\s*"progress"/)
      expect(stdout.trim().split(/\r?\n/)).toHaveLength(1)
      expect(doc.speakerId).toBe('s1')
      expect(doc.model).toBe('stub-model')
      expect(doc.durationMs).toBe(2500)
      expect(doc.segments).toHaveLength(3)
      expect(doc.segments.map((s) => s.text)).toEqual(['segment 1', 'segment 2', 'segment 3'])
    })
  }
)
