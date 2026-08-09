// React-side client for /api/profiles. Per-provider model profile (phase1-4
// model + caching toggles).

export type CloudProvider = 'gemini' | 'claude' | 'openai' | 'claudeCode' | 'codex'

export type ProviderProfile = {
  phase1Model: string
  phase2Model: string
  phase3Model: string
  phase4Model: string
  /**
   * Optional override for the Phase 6 (Condense) model. If absent the
   * runner falls back to the Phase 3 model — both phases generate
   * long-form prose so the same model is usually appropriate.
   */
  phase6Model?: string
  useContextCache?: boolean
  useCacheControl?: boolean
}

export type ProfilesDocument = {
  version: 1
  profiles: Record<CloudProvider, ProviderProfile>
}

export async function getProfiles(): Promise<ProfilesDocument> {
  const res = await fetch('/api/profiles')
  if (!res.ok) throw new Error(`GET /api/profiles failed: HTTP ${res.status}`)
  return (await res.json()) as ProfilesDocument
}

export async function putProfiles(doc: ProfilesDocument): Promise<ProfilesDocument> {
  const res = await fetch('/api/profiles', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(doc),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`PUT /api/profiles failed: HTTP ${res.status}. ${body.slice(0, 300)}`)
  }
  return (await res.json()) as ProfilesDocument
}

export function modelForPhase(profile: ProviderProfile, phase: 1 | 2 | 3 | 4 | 6): string {
  switch (phase) {
    case 1:
      return profile.phase1Model
    case 2:
      return profile.phase2Model
    case 3:
      return profile.phase3Model
    case 4:
      return profile.phase4Model
    case 6:
      return profile.phase6Model ?? profile.phase3Model
  }
}
