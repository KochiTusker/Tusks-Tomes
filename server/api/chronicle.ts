// Persist a finished chronicle (plus extras / condensed) as a markdown
// file inside the repo, so each session's output lives alongside the
// project tree and can be browsed / committed like any other file.
//
// Layout (relative to repo root):
//   Sessions/<campaign>/Silence Beyond the Sea - <campaign> - Session <n>.md
//
// The "Silence Beyond the Sea" prefix is a user-facing branding choice
// (the app was renamed to "Tusk's Tomes" but the chronicle outputs keep
// the original campaign label).

import express, { type Router } from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promises as fs } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { sanitizeSegment } from '../lib/validators.js'
import {
  renderChronicleDocx,
  type ChronicleDocxArgs,
  type CondenseOutput,
  type ExtrasOutput,
} from '../lore/docxRenderer.js'

const FILENAME_PREFIX = 'Silence Beyond the Sea'

// `__dirname` here resolves to either `server/api/` (dev via tsx) or
// `dist-server/api/` (built). Two levels up is the repo root in both
// cases — matches the ROOT calculation in `server/index.ts`.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..')

export function chronicleRouter(): Router {
  const router = express.Router()

  router.post('/save', async (req, res) => {
    try {
      const { campaign, sessionNumber, content, variant } = req.body as {
        campaign?: string
        sessionNumber?: number
        content?: string
        /** Optional filename discriminator. When set (e.g. a reforge / iteration
         *  copy), it's appended to the filename so the new version lands as its
         *  OWN file instead of overwriting the canonical session export — every
         *  copy is then kept on disk until the user deletes it. */
        variant?: string
      }

      const safeCampaign = sanitizeSegment(campaign ?? '')
      if (!safeCampaign) {
        return res
          .status(400)
          .json({ error: 'campaign is required to save a chronicle' })
      }
      const sn = Number(sessionNumber)
      if (!Number.isFinite(sn) || sn <= 0) {
        return res
          .status(400)
          .json({ error: 'sessionNumber must be a positive integer' })
      }
      if (typeof content !== 'string' || !content.trim()) {
        return res.status(400).json({ error: 'content is required' })
      }

      const dir = path.join(REPO_ROOT, 'Sessions', safeCampaign)
      await fs.mkdir(dir, { recursive: true })

      // A variant (reforge / iteration copy) gets its own filename so it never
      // overwrites the canonical Session N export or a prior variant.
      const safeVariant = typeof variant === 'string' ? sanitizeSegment(variant) : ''
      const fileName = safeVariant
        ? `${FILENAME_PREFIX} - ${safeCampaign} - Session ${Math.floor(sn)} - ${safeVariant}.md`
        : `${FILENAME_PREFIX} - ${safeCampaign} - Session ${Math.floor(sn)}.md`
      const absPath = path.join(dir, fileName)

      // Atomic write: a crash mid-flush leaves the previous file intact
      // rather than truncating it. Same pattern as appData.writeJson.
      const tmp = `${absPath}.${randomBytes(6).toString('hex')}.tmp`
      await fs.writeFile(tmp, content, 'utf8')
      await fs.rename(tmp, absPath)

      res.json({
        ok: true,
        path: path.relative(REPO_ROOT, absPath).split(path.sep).join('/'),
        absPath,
      })
    } catch (err) {
      console.error('[chronicle/save] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // Render a chronicle (full or condensed) as a formatted .docx and stream it
  // straight back as a download. Unlike /save and the Lore export, this needs
  // no Lore folder — it's the "Download .docx" button's backend, available on
  // any run. Reuses the same renderer the Lore export uses so the formatting
  // is identical.
  router.post('/docx', async (req, res) => {
    try {
      const { campaign, sessionNumber, chronicle, extras, condensed, mode } =
        req.body as {
          campaign?: string
          sessionNumber?: number
          chronicle?: string
          extras?: ExtrasOutput | null
          condensed?: CondenseOutput | null
          mode?: 'full' | 'condensed'
        }

      if (typeof chronicle !== 'string' || !chronicle.trim()) {
        return res.status(400).json({ error: 'chronicle is required' })
      }
      const sn = Number(sessionNumber)
      const safeSession = Number.isFinite(sn) && sn > 0 ? Math.floor(sn) : 0
      const safeMode: ChronicleDocxArgs['mode'] = mode === 'condensed' ? 'condensed' : 'full'

      const buffer = await renderChronicleDocx({
        campaign: typeof campaign === 'string' ? campaign : '',
        sessionNumber: safeSession,
        chronicle,
        extras: extras ?? null,
        condensed: condensed ?? null,
        mode: safeMode,
      })

      const baseName = `${sanitizeSegment(campaign ?? '') || 'campaign'}-session-${safeSession}${safeMode === 'condensed' ? '-condensed' : ''}`
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      )
      res.setHeader('Content-Disposition', `attachment; filename="${baseName}.docx"`)
      res.send(buffer)
    } catch (err) {
      console.error('[chronicle/docx] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  return router
}
