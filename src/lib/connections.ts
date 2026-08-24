// Connection probes — one shape for "is this thing reachable, and if not,
// what does the user do about it?".
//
// Every probe answers with the same four fields so one row component can
// render all of them. Probes only wrap detection that already exists
// (the CLI status endpoints, the local-runner detector, the whisper.cpp
// status route); none of them invents a new source of truth.

import { detectLocalBackends } from './localLLM'

export type ConnectionState =
  /** Present and usable right now. */
  | 'connected'
  /** Present but needs one more step (e.g. installed, not signed in). */
  | 'attention'
  /** Not found — the row shows how to get it. */
  | 'absent'
  /** The check itself could not run. Distinct from 'absent' on purpose:
   *  claiming a working CLI is missing is worse than admitting we could
   *  not look, and it sent a real user hunting for a problem that was
   *  never on their machine. */
  | 'unknown'

export type ConnectionProbeResult = {
  state: ConnectionState
  /** One line of live detail: version, count, path — the specific truth. */
  detail: string
  /** Shown when state !== 'connected': the next step, as an instruction. */
  remedy?: string
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as T
}

type CliStatus = {
  installed: boolean
  version: string | null
  authenticated: boolean
  /** Set when the probe could not run at all — see server/api/claudeCode.ts. */
  probeFailed?: string
}

export async function probeClaudeCode(): Promise<ConnectionProbeResult> {
  const s = await getJson<CliStatus>('/api/claude-code/status')
  if (s.probeFailed) {
    return {
      state: 'unknown',
      detail: `Could not check for the claude CLI — ${s.probeFailed}.`,
      remedy: 'This says nothing about whether it is installed. Try the refresh arrow.',
    }
  }
  if (!s.installed) {
    return {
      state: 'absent',
      detail: 'The claude CLI was not found on this machine.',
      remedy: 'Install Claude Code, run `claude login`, then check again.',
    }
  }
  if (!s.authenticated) {
    return {
      state: 'attention',
      detail: `CLI ${s.version ?? 'installed'} — no signed-in session found.`,
      remedy: 'Run `claude login` in a terminal, then check again.',
    }
  }
  return { state: 'connected', detail: `CLI ${s.version ?? 'installed'}, signed in.` }
}

export async function probeCodex(): Promise<ConnectionProbeResult> {
  const s = await getJson<CliStatus>('/api/codex/status')
  if (s.probeFailed) {
    return {
      state: 'unknown',
      detail: `Could not check for the codex CLI — ${s.probeFailed}.`,
      remedy: 'This says nothing about whether it is installed. Try the refresh arrow.',
    }
  }
  if (!s.installed) {
    return {
      state: 'absent',
      detail: 'The codex CLI was not found on this machine.',
      remedy: 'Install it (npm i -g @openai/codex), run `codex login`, then check again.',
    }
  }
  if (!s.authenticated) {
    return {
      state: 'attention',
      detail: `CLI ${s.version ?? 'installed'} — no signed-in session found.`,
      remedy: 'Run `codex login` in a terminal, then check again.',
    }
  }
  return { state: 'connected', detail: `CLI ${s.version ?? 'installed'}, signed in.` }
}

export async function probeLocalRunners(): Promise<ConnectionProbeResult> {
  const backends = await detectLocalBackends()
  const up = backends.filter((b) => b.reachable)
  if (up.length === 0) {
    return {
      state: 'absent',
      detail: 'No runner answered on the usual ports.',
      remedy: 'Start Ollama, LM Studio or Unsloth Studio, then check again.',
    }
  }
  const names = up.map((b) => b.name).join(', ')
  const models = up.reduce((n, b) => n + (b.models?.length ?? 0), 0)
  return {
    state: 'connected',
    detail: `${names} — ${models} model${models === 1 ? '' : 's'} available.`,
  }
}

type WhisperCppStatus = {
  configured: boolean
  binaryOk?: boolean
  modelOk?: boolean
  summary?: string
}

export async function probeWhisperCpp(): Promise<ConnectionProbeResult> {
  const s = await getJson<WhisperCppStatus>('/api/whisper-cpp/status')
  if (!s.configured) {
    return {
      state: 'absent',
      detail: 'Not set up — no binary or model paths saved yet.',
      remedy: 'Point the panel at your whisper.cpp build and a model file.',
    }
  }
  if (s.binaryOk === false || s.modelOk === false) {
    return {
      state: 'attention',
      detail: s.summary ?? 'A saved path no longer resolves.',
      remedy: 'Fix the binary or model path below.',
    }
  }
  return { state: 'connected', detail: s.summary ?? 'Binary and model verified.' }
}
