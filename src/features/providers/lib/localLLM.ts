// React-side client for local-LLM detection + probes. Wraps the server
// endpoints at /api/local-llm/*.

import { apiJson } from '@/platform/apiClient'
import type { Backend, ProbeResult } from '@shared/contracts/localLLM'

export type { Backend, ProbeResult }

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

export async function detectLocalBackends(): Promise<LocalBackendInfo[]> {
  const json = await apiJson<{ backends: LocalBackendInfo[] }>('/api/local-llm/detect', {
    errorMode: 'status',
    errorPrefix: 'detect',
  })
  return json.backends
}

export async function getProbeResults(): Promise<ProbeResult[]> {
  const json = await apiJson<{ results: ProbeResult[] }>('/api/local-llm/probes', {
    errorMode: 'status',
    errorPrefix: 'probes',
  })
  return json.results
}

export async function runProbe(args: { baseUrl: string; modelId: string }): Promise<ProbeResult> {
  const result = await apiJson<ProbeResult>('/api/local-llm/probe', {
    method: 'POST',
    body: args,
    errorMode: 'text',
    bodySlice: 400,
    errorPrefix: 'probe',
  })
  emit()
  return result
}

export async function getUnslothConfig(): Promise<UnslothConfigStatus> {
  return apiJson<UnslothConfigStatus>('/api/local-llm/unsloth-config', {
    errorMode: 'status',
    errorPrefix: 'unsloth-config',
  })
}

export async function putUnslothConfig(config: UnslothConfigInput): Promise<UnslothConfigStatus> {
  const status = await apiJson<UnslothConfigStatus>('/api/local-llm/unsloth-config', {
    method: 'PUT',
    body: config,
    errorMode: 'text',
    bodySlice: 300,
    errorPrefix: 'unsloth-config save',
  })
  emit()
  return status
}

export async function clearUnslothConfig(): Promise<UnslothConfigStatus> {
  const status = await apiJson<UnslothConfigStatus>('/api/local-llm/unsloth-config', {
    method: 'DELETE',
    errorMode: 'status',
    errorPrefix: 'unsloth-config clear',
  })
  emit()
  return status
}

/** Notify subscribers without changing any state — used after Detect again. */
export function notifyLocalLLMRefreshed(): void {
  emit()
}
