// Client wrapper for the /api/runs/* endpoints. Backs the resume banner
// and the rate-limit dialog's "Pause and save for later" option.

import type { RunCheckpoint, RunCheckpointSummary } from './runCheckpoint'

const BASE = '/api/runs'

export async function listRuns(): Promise<RunCheckpointSummary[]> {
  const res = await fetch(BASE)
  if (!res.ok) throw new Error(`GET ${BASE} failed: HTTP ${res.status}`)
  const body = (await res.json()) as { runs: RunCheckpointSummary[] }
  return body.runs ?? []
}

export async function loadRun(runId: string): Promise<RunCheckpoint | null> {
  const res = await fetch(`${BASE}/${encodeURIComponent(runId)}`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GET ${BASE}/${runId} failed: HTTP ${res.status}`)
  return (await res.json()) as RunCheckpoint
}

export type SaveRunResult =
  | { ok: true; runId: string }
  | { ok: false; reason: 'too_large' | 'network' | 'unknown'; message: string }

export async function saveRun(checkpoint: RunCheckpoint): Promise<SaveRunResult> {
  try {
    const res = await fetch(`${BASE}/${encodeURIComponent(checkpoint.runId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(checkpoint),
    })
    if (res.ok) {
      return { ok: true, runId: checkpoint.runId }
    }
    if (res.status === 413) {
      return {
        ok: false,
        reason: 'too_large',
        message:
          'Checkpoint exceeded the disk-storage cap. Use "Stop and export" instead — your in-progress output stays in the browser.',
      }
    }
    return {
      ok: false,
      reason: 'unknown',
      message: `Save failed: HTTP ${res.status}`,
    }
  } catch (err) {
    return {
      ok: false,
      reason: 'network',
      message: (err as Error).message,
    }
  }
}

export async function deleteRun(runId: string): Promise<void> {
  const res = await fetch(`${BASE}/${encodeURIComponent(runId)}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`DELETE ${BASE}/${runId} failed: HTTP ${res.status}`)
}
