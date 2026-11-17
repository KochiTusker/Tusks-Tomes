// React-side client for /api/glossary. Caches the document in memory so
// pipeline runs and the editor don't both hit the server, and notifies
// subscribers when the cache changes (after a save or external refresh).

import { createDocClient } from '@/platform/docClient'
import type { GlossaryDocument } from '@shared/contracts/glossary'

export type { GlossaryDocument }

const client = createDocClient<GlossaryDocument>({
  path: '/api/glossary',
  normalise: (doc) => ({
    version: 1,
    safeReplacements: doc.safeReplacements ?? [],
    contextualHints: doc.contextualHints ?? [],
  }),
})

export const getGlossary = client.get
export const putGlossary = client.put
export const subscribeGlossary = client.subscribe
