import { MODEL_FLASH, MODEL_PRO } from '../constants'
import type { ProviderId, ProviderSettings, Tier } from './types'

const LS_KEY = 'provider_settings'

import { safeSet } from '../storage'

export const PROVIDER_SETTINGS_EVENT = 'sbts:provider-settings-changed'

const DEFAULT_SETTINGS: ProviderSettings = {
  providerId: 'gemini',
  proModel: MODEL_PRO,
  flashModel: MODEL_FLASH,
}

export function getProviderSettings(): ProviderSettings {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return DEFAULT_SETTINGS
    const parsed = JSON.parse(raw) as Partial<ProviderSettings>
    return {
      providerId: parsed.providerId ?? DEFAULT_SETTINGS.providerId,
      proModel: parsed.proModel ?? DEFAULT_SETTINGS.proModel,
      flashModel: parsed.flashModel ?? DEFAULT_SETTINGS.flashModel,
      baseUrl: parsed.baseUrl,
      // CRITICAL: must propagate auth + hardware. Earlier code dropped these
      // on the floor — tokens written by the UI never made it back out, so
      // the proxy sent unauthenticated requests and Unsloth returned 401.
      auth: parsed.auth,
      hardware: parsed.hardware,
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function setProviderSettings(next: ProviderSettings): void {
  // Same JSON format; the write now goes through the quota guard.
  safeSet(LS_KEY, next)
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(PROVIDER_SETTINGS_EVENT, { detail: next }))
  }
}

export function getCurrentProviderId(): ProviderId {
  return getProviderSettings().providerId
}

export function isLocalProvider(id: ProviderId = getCurrentProviderId()): boolean {
  return id === 'ollama' || id === 'lmstudio' || id === 'unsloth'
}

export function getModelForTier(tier: Tier): string {
  const s = getProviderSettings()
  return tier === 'pro' ? s.proModel : s.flashModel
}


