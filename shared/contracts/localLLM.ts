// The local-runner capability probe, as stored and as sent over /api/local-llm.

export type Backend = 'ollama' | 'lmstudio' | 'llamacpp' | 'unsloth'

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
