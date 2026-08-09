// Tests for the transcribe route. Pins the rejectInvalidId guard on
// the two `:id`-bearing endpoints (Phase 3.1 consolidation surface).

import { describe, expect, it, vi } from 'vitest'
import { withRouter } from '../testing/httpFixture.js'

// The route imports './whisper/sessionPipeline.js' which has heavy
// side-effects on import (ffmpeg path setup, process.env reads). Mock
// it so the test focuses only on the validation surface.
vi.mock('../whisper/sessionPipeline.js', () => ({
  processSession: vi.fn().mockResolvedValue({ progress: 0 }),
  getSessionProgress: vi.fn().mockReturnValue({ progress: 0.5 }),
}))

describe('POST /:id/transcribe — invalid id rejection', () => {
  const malicious = [
    '../etc',
    '..%2Fetc',
    'a/b',
    'a\\b',
    '..',
    'a b c',
    '', // empty id won't match the route anyway, but verify shape
    'x'.repeat(65), // oversize
    'a\nb',
  ]
  for (const id of malicious) {
    it(`rejects ${JSON.stringify(id)} → 400`, async () => {
      const { transcribeRouter } = await import('./transcribe.js')
      await withRouter('/api/sessions', transcribeRouter(), async (baseUrl) => {
        const res = await fetch(`${baseUrl}/${encodeURIComponent(id)}/transcribe`, {
          method: 'POST',
        })
        // 400 for invalid id, or 404 if Express path-to-regexp couldn't
        // match the route shape at all (e.g. empty segment) — either
        // way, no 5xx, no transcription kicked off.
        expect([400, 404]).toContain(res.status)
      })
    })
  }

  it('accepts a valid id → 202 (processing started)', async () => {
    const { transcribeRouter } = await import('./transcribe.js')
    await withRouter('/api/sessions', transcribeRouter(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/valid-session-id-123/transcribe`, { method: 'POST' })
      expect(res.status).toBe(202)
    })
  })
})

describe('GET /:id/transcribe/status — invalid id rejection', () => {
  for (const id of ['../etc', 'a/b', '..']) {
    it(`rejects ${JSON.stringify(id)} → 400 or 404`, async () => {
      const { transcribeRouter } = await import('./transcribe.js')
      await withRouter('/api/sessions', transcribeRouter(), async (baseUrl) => {
        const res = await fetch(`${baseUrl}/${encodeURIComponent(id)}/transcribe/status`)
        expect([400, 404]).toContain(res.status)
      })
    })
  }

  it('valid id returns the progress payload', async () => {
    const { transcribeRouter } = await import('./transcribe.js')
    await withRouter('/api/sessions', transcribeRouter(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/valid-id-456/transcribe/status`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.progress).toBe(0.5)
    })
  })
})
