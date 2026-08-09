// `/api/local-llm/probe` — kicks off a 2-test capability probe and persists
// the result in {cacheDir}/capability.json. Split from localLLM.ts because
// it imports the heavier probe runner (which in turn pulls fixtures).

import express, { type Router } from 'express'
import { runProbe } from '../localProbe/runner.js'
import { upsertProbeResult } from './localLLM.js'
import { validateLocalBaseUrl } from '../lib/validators.js'

export function probeRouter(): Router {
  const router = express.Router()

  router.post('/probe', async (req, res) => {
    const body = req.body as { baseUrl?: string; modelId?: string }
    if (typeof body.baseUrl !== 'string' || !body.baseUrl) {
      return res.status(400).json({ error: 'baseUrl is required' })
    }
    if (typeof body.modelId !== 'string' || !body.modelId) {
      return res.status(400).json({ error: 'modelId is required' })
    }
    // Validate at the route boundary so a public-host baseUrl never
    // reaches the runner. Runner re-checks at the fetch site for
    // defence in depth.
    try {
      await validateLocalBaseUrl(body.baseUrl)
    } catch (err) {
      return res.status(400).json({ error: (err as Error).message })
    }
    try {
      const result = await runProbe({ baseUrl: body.baseUrl, modelId: body.modelId })
      await upsertProbeResult(result)
      res.json(result)
    } catch (err) {
      console.error('[api/local-llm/probe] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  return router
}
