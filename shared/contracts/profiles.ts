// Per-provider model profiles, as stored and as sent over /api/profiles.

import type { CloudProvider } from './providers.js'

export type ProviderProfile = {
  phase1Model: string
  phase2Model: string
  phase3Model: string
  phase4Model: string
  /**
   * Optional override for the Phase 6 (Condense) model. If absent the
   * runner falls back to the Phase 3 model: both phases generate
   * long-form prose so the same model is usually appropriate.
   */
  phase6Model?: string
}

export type ProfilesDocument = {
  version: 1
  profiles: Record<CloudProvider, ProviderProfile>
}
