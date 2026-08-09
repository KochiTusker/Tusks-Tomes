// Provider registry. Pipeline phases call `getActiveProvider()` to obtain
// the LLMProvider matching the user's current selection (cloud Gemini /
// Claude / OpenAI / local backend) and invoke `provider.generate(...)`.
//
// Cloud-provider keys come from the encrypted server-side keystore (Step 6).
// Call `ensureProvidersInitialized()` before the first run; subsequent
// `getActiveProvider()` calls return the cached singleton bound to those
// keys. After the user edits a key, call `refreshProviders()` to re-read.

import { ClaudeProvider } from './claude'
import { ClaudeCodeProvider } from './claudeCode'
import { CodexProvider } from './codex'
import { GeminiProvider, type GeminiTier } from './gemini'
import { LocalProviderAdapter } from './localAdapter'
import { OpenAIProvider } from './openai'
import { getCurrentProviderId, isLocalProvider } from './settings'
import type { LLMProvider, ProviderName } from './llm'
import { vlog } from '../verboseLog'

type CloudKeys = {
  gemini?: string
  geminiFallback?: string
  claude?: string
  openai?: string
}

let cloudKeys: CloudKeys | null = null
// One Gemini singleton per tier. The 'auto' instance has both keys and
// auto-fails over; the 'paid' / 'free' instances are locked to a single
// key so the user's explicit choice can never silently spend the wrong
// budget.
let geminiAuto: GeminiProvider | null = null
let geminiPaid: GeminiProvider | null = null
let geminiFree: GeminiProvider | null = null
let claudeSingleton: ClaudeProvider | null = null
let openaiSingleton: OpenAIProvider | null = null
let localSingleton: LocalProviderAdapter | null = null
let claudeCodeSingleton: ClaudeCodeProvider | null = null
let codexSingleton: CodexProvider | null = null
let initializing: Promise<void> | null = null

async function fetchKeys(): Promise<CloudKeys> {
  try {
    const res = await fetch('/api/provider-keys')
    if (!res.ok) throw new Error(`GET /api/provider-keys failed: HTTP ${res.status}`)
    return (await res.json()) as CloudKeys
  } catch (err) {
    console.warn('[providers] Failed to load keys from server:', err)
    return {}
  }
}

function rebuild(keys: CloudKeys): void {
  cloudKeys = keys
  vlog('refresh', {
    event: 'rebuild_singletons',
    haveGemini: !!keys.gemini,
    haveGeminiFallback: !!keys.geminiFallback,
    haveClaude: !!keys.claude,
    haveOpenAI: !!keys.openai,
  })
  geminiAuto = new GeminiProvider({
    primaryKey: keys.gemini,
    fallbackKey: keys.geminiFallback ?? null,
    tier: 'auto',
  })
  geminiPaid = new GeminiProvider({
    primaryKey: keys.gemini,
    fallbackKey: null,
    tier: 'paid',
  })
  geminiFree = new GeminiProvider({
    primaryKey: undefined,
    fallbackKey: keys.geminiFallback ?? null,
    tier: 'free',
  })
  claudeSingleton = new ClaudeProvider({ apiKey: keys.claude })
  openaiSingleton = new OpenAIProvider({ apiKey: keys.openai })
  localSingleton = new LocalProviderAdapter()
  claudeCodeSingleton = new ClaudeCodeProvider()
  codexSingleton = new CodexProvider()
}

export async function ensureProvidersInitialized(): Promise<void> {
  if (cloudKeys) return
  if (initializing) return initializing
  initializing = (async () => {
    try {
      const keys = await fetchKeys()
      rebuild(keys)
    } finally {
      initializing = null
    }
  })()
  return initializing
}

/** v1.1.0 — broadcast event fired after `refreshProviders()` rebuilds the
 *  singletons. Listeners can react to the change (e.g. RefinementTool
 *  warns if a pipeline run is in progress and the active provider's key
 *  was just swapped). Detail includes which key slots changed so the UI
 *  can highlight specifically which providers were affected. */
export const PROVIDERS_CHANGED_EVENT = 'sbts:providers-changed'

export type ProvidersChangedDetail = {
  /** Which key slots flipped between configured / not configured. Empty
   *  on the first init (cloudKeys was null and is now set). */
  changedKeys: Array<keyof CloudKeys>
}

export async function refreshProviders(): Promise<void> {
  const previous = cloudKeys
  cloudKeys = null
  await ensureProvidersInitialized()
  if (typeof window !== 'undefined') {
    const next = cloudKeys as CloudKeys | null
    const changed: Array<keyof CloudKeys> = []
    if (previous && next) {
      for (const slot of ['gemini', 'geminiFallback', 'claude', 'openai'] as const) {
        if (Boolean(previous[slot]) !== Boolean(next[slot]) || previous[slot] !== next[slot]) {
          changed.push(slot)
        }
      }
    }
    const detail: ProvidersChangedDetail = { changedKeys: changed }
    window.dispatchEvent(new CustomEvent(PROVIDERS_CHANGED_EVENT, { detail }))
  }
}

function geminiProvider(tier: GeminiTier = 'auto'): GeminiProvider {
  if (tier === 'paid') {
    if (!geminiPaid) geminiPaid = new GeminiProvider({ tier: 'paid' })
    return geminiPaid
  }
  if (tier === 'free') {
    if (!geminiFree) geminiFree = new GeminiProvider({ tier: 'free' })
    return geminiFree
  }
  if (!geminiAuto) geminiAuto = new GeminiProvider({ tier: 'auto' })
  return geminiAuto
}

function claudeProvider(): ClaudeProvider {
  if (!claudeSingleton) claudeSingleton = new ClaudeProvider()
  return claudeSingleton
}

function openaiProvider(): OpenAIProvider {
  if (!openaiSingleton) openaiSingleton = new OpenAIProvider()
  return openaiSingleton
}

function localProvider(): LocalProviderAdapter {
  if (!localSingleton) localSingleton = new LocalProviderAdapter()
  return localSingleton
}

function claudeCodeProvider(): ClaudeCodeProvider {
  if (!claudeCodeSingleton) claudeCodeSingleton = new ClaudeCodeProvider()
  return claudeCodeSingleton
}

function codexProvider(): CodexProvider {
  if (!codexSingleton) codexSingleton = new CodexProvider()
  return codexSingleton
}

/**
 * Resolve the provider for an explicit name. All four are wired today.
 */
export function getProvider(name: ProviderName): LLMProvider {
  switch (name) {
    case 'gemini':
      return geminiProvider()
    case 'claude':
      return claudeProvider()
    case 'openai':
      return openaiProvider()
    case 'local':
      return localProvider()
    case 'claudeCode':
      return claudeCodeProvider()
    case 'codex':
      return codexProvider()
  }
}

/**
 * Tier-aware cloud-provider resolver. Used by the pipeline at run start so
 * a single ProviderSelectModal choice resolves through to the right
 * GeminiProvider singleton (paid vs free vs auto).
 */
export function getCloudProvider(
  name: 'gemini' | 'claude' | 'openai' | 'claudeCode' | 'codex',
  opts?: { geminiTier?: GeminiTier }
): LLMProvider {
  if (name === 'gemini') return geminiProvider(opts?.geminiTier ?? 'auto')
  if (name === 'claude') return claudeProvider()
  if (name === 'claudeCode') return claudeCodeProvider()
  // Codex must resolve BEFORE the openai fall-through — the tail return is
  // a fall-through, and letting 'codex' hit it would silently route a
  // subscription user onto API-key billing.
  if (name === 'codex') return codexProvider()
  return openaiProvider()
}

/** Resolve the provider matching the user's currently-selected provider id.
 *  Delegates to `getProvider()` so all four provider IDs (gemini, claude,
 *  openai, local) route to the correct singleton. Earlier versions of this
 *  function hard-coded Gemini for any non-local selection, which silently
 *  routed Claude- and OpenAI-configured users to Gemini regardless of their
 *  pick — a critical bug surfaced in the Phase H audit. */
export function getActiveProvider(): LLMProvider {
  return getProvider(getActiveProviderName())
}

export type { GeminiTier } from './gemini'

export function getActiveProviderName(): ProviderName {
  return isLocalProvider() ? 'local' : (getCurrentProviderId() as ProviderName)
}

/** Provider IDs the user could feasibly run today (cloud key configured / local always). */
export function listAvailableProviders(): ProviderName[] {
  const out: ProviderName[] = []
  if (geminiProvider().hasKey()) out.push('gemini')
  if (claudeProvider().hasKey()) out.push('claude')
  if (openaiProvider().hasKey()) out.push('openai')
  out.push('local')
  return out
}

export type {
  LLMProvider,
  GenerateRequest,
  GenerateResponse,
  Usage,
  GenerateOptions,
  ProviderName,
} from './llm'
