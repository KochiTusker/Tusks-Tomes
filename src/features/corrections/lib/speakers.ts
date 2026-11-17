// React-side client for /api/speakers: an in-memory cache with subscribe(),
// so the editor and the upload pipeline stay in sync without bouncing through
// localStorage.

import { createDocClient } from '@/platform/docClient'
import type { Speaker, SpeakersDocument } from '@shared/contracts/speakers'

export type { Speaker, SpeakersDocument }

const client = createDocClient<SpeakersDocument>({
  path: '/api/speakers',
  normalise: (doc) => ({
    version: 1,
    speakers: doc.speakers ?? [],
  }),
})

export const getSpeakers = client.get
export const putSpeakers = client.put
export const subscribeSpeakers = client.subscribe

// The lookup lives in shared/speakers/identity.ts, where the server uses the
// same one to label a session's tracks.
export { findSpeakerFor } from '@shared/speakers/identity'
