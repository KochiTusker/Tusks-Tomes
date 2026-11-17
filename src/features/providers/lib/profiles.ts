// React-side client for /api/profiles. Per-provider model profile (phase1-4
// model + caching toggles).

import { apiJson } from '@/platform/apiClient'
import type { CloudProvider } from '@shared/contracts/providers'
import type { ProfilesDocument, ProviderProfile } from '@shared/contracts/profiles'

export type { CloudProvider, ProfilesDocument, ProviderProfile }

export async function getProfiles(): Promise<ProfilesDocument> {
  return apiJson<ProfilesDocument>('/api/profiles', { errorMode: 'status' })
}

export async function putProfiles(doc: ProfilesDocument): Promise<ProfilesDocument> {
  return apiJson<ProfilesDocument>('/api/profiles', {
    method: 'PUT',
    body: doc,
    errorMode: 'text',
    bodySlice: 300,
  })
}

