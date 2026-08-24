// Server-internal endpoint that returns the decrypted provider keys to the
// React app so the in-browser SDKs (Gemini / Claude / OpenAI) can use them.
//
// Security notes:
//   - The Express server only binds to localhost. The keys never leave the
//     user's machine.
//   - This trades clean separation for not introducing a server-side LLM
//     proxy (the local LLMs already have one — see /api/local/*). The
//     proper-isolation alternative would be to route every cloud call
//     through the server as well; that's a future enhancement.
//   - Use of `KeyBundle` here is read-only. Writes go through /api/providers.

import express, { type Router } from 'express'
import { loadKeys } from '../crypto/keyStore.js'
import { slog } from '../lib/slog.js'

export function providerKeysRouter(): Router {
  const router = express.Router()

  router.get('/', async (_req, res) => {
    try {
      const bundle = await loadKeys()
      // Log which slots are configured (booleans only — never the key bytes).
      // Lets the user verify in the terminal that the singletons got built
      // from the slots they expect.
      slog('server', {
        event: 'provider_keys_loaded',
        haveGemini: !!bundle.gemini,
        haveGeminiFallback: !!bundle.geminiFallback,
        haveOpenRouter: !!bundle.openrouter,
      })
      res.json(bundle)
    } catch (err) {
      console.error('[api/provider-keys GET] failed:', err)
      slog('server', { event: 'provider_keys_error', error: (err as Error).message })
      res.status(500).json({ error: (err as Error).message })
    }
  })

  return router
}
