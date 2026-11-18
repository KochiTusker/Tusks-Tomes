// Persist a finished chronicle (plus extras / condensed) as a markdown
// file inside the repo, so each session's output lives alongside the
// project tree and can be browsed / committed like any other file.
//
// Layout (relative to repo root):
//   Sessions/<campaign>/<campaign> - Session <n>.md
//
// The file is named after the user's own campaign and nothing else, so two
// campaigns never share a label.

import express, { type Router } from 'express'
import path from 'node:path'
import { repoRoot } from '../../../platform/repoRoot.js'
import { promises as fs } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { sanitizeSegment } from '../../../platform/validators.js'
import {
  renderChronicleDocx,
  type ChronicleDocxArgs,
  type CondenseOutput,
  type ExtrasOutput,
} from '../services/docxRenderer.js'
import { asyncRoute } from '../../../platform/asyncRoute.js'

const REPO_ROOT = repoRoot()

/** The file name a saved chronicle is written under. Both segments must
 *  already be sanitised. A variant (reforge / iteration copy) gets its own
 *  name so it never overwrites the canonical Session N export or a prior
 *  variant. */
export function sessionFileName(safeCampaign: string, sessionNumber: number, safeVariant = ''): string {
  const base = `${safeCampaign} - Session ${Math.floor(sessionNumber)}`
  return safeVariant ? `${base} - ${safeVariant}.md` : `${base}.md`
}

export function chronicleRouter(): Router {
  const router = express.Router()

  router.post('/save', asyncRoute('chronicle/save', async (req, res) => {
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

    const safeVariant = typeof variant === 'string' ? sanitizeSegment(variant) : ''
    const absPath = path.join(dir, sessionFileName(safeCampaign, sn, safeVariant))

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
  }))

  // Render a chronicle (full or condensed) as a formatted .docx and stream it
  // straight back as a download. Unlike /save and the Lore export, this needs
  // no Lore folder — it's the "Download .docx" button's backend, available on
  // any run. Reuses the same renderer the Lore export uses so the formatting
  // is identical.
  router.post('/docx', asyncRoute('chronicle/docx', async (req, res) => {
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
  }))

  return router
}
