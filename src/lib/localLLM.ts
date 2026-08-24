// React-side client for local-LLM detection + probes. Wraps the server
// endpoints at /api/local-llm/*.

export type Backend = 'ollama' | 'lmstudio' | 'llamacpp' | 'unsloth'

export type LocalBackendInfo = {
  name: Backend
  baseUrl: string
  reachable: boolean
  models: string[]
  error?: string
}

export type UnslothConfigStatus = {
  configured: boolean
  baseUrl?: string
  hasUsername?: boolean
  hasPassword?: boolean
  hasBearerToken?: boolean
}

export type UnslothConfigInput = {
  baseUrl: string
  username?: string
  password?: string
  bearerToken?: string
}

const listeners = new Set<() => void>()

/** Subscribe to detection or probe changes; returns an unsubscribe callback. */
export function subscribeLocalLLM(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function emit(): void {
  for (const l of listeners) l()
}

export type EligibilitySet = {
  phase1: boolean
  phase2: boolean
  phase3: boolean
  phase4: boolean
}

export type ProbeResult = {
  modelId: string
  baseUrl: string
  backend: Backend | 'unknown'
  runAt: string
  structuredJsonScore: number
  groundingScore: number
  tokensPerSecond: number
  eligible: EligibilitySet
}

export async function detectLocalBackends(): Promise<LocalBackendInfo[]> {
  const res = await fetch('/api/local-llm/detect')
  if (!res.ok) throw new Error(`detect failed: HTTP ${res.status}`)
  const json = (await res.json()) as { backends: LocalBackendInfo[] }
  return json.backends
}

export async function getProbeResults(): Promise<ProbeResult[]> {
  const res = await fetch('/api/local-llm/probes')
  if (!res.ok) throw new Error(`probes failed: HTTP ${res.status}`)
  const json = (await res.json()) as { results: ProbeResult[] }
  return json.results
}

export async function runProbe(args: { baseUrl: string; modelId: string }): Promise<ProbeResult> {
  const res = await fetch('/api/local-llm/probe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`probe failed: HTTP ${res.status}. ${body.slice(0, 400)}`)
  }
  const result = (await res.json()) as ProbeResult
  emit()
  return result
}

export async function getUnslothConfig(): Promise<UnslothConfigStatus> {
  const res = await fetch('/api/local-llm/unsloth-config')
  if (!res.ok) throw new Error(`unsloth-config failed: HTTP ${res.status}`)
  return (await res.json()) as UnslothConfigStatus
}

export async function putUnslothConfig(config: UnslothConfigInput): Promise<UnslothConfigStatus> {
  const res = await fetch('/api/local-llm/unsloth-config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`unsloth-config save failed: HTTP ${res.status}. ${body.slice(0, 300)}`)
  }
  const status = (await res.json()) as UnslothConfigStatus
  emit()
  return status
}

export async function clearUnslothConfig(): Promise<UnslothConfigStatus> {
  const res = await fetch('/api/local-llm/unsloth-config', { method: 'DELETE' })
  if (!res.ok) throw new Error(`unsloth-config clear failed: HTTP ${res.status}`)
  const status = (await res.json()) as UnslothConfigStatus
  emit()
  return status
}

/** Notify subscribers without changing any state — used after Detect again. */
export function notifyLocalLLMRefreshed(): void {
  emit()
}
