import express from 'express'
import multer from 'multer'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer as createHttpServer } from 'node:http'
import { parsePdf } from './pdfParse.js'
import { docxBufferToMarkdown } from './lore/docxToMarkdown.js'
import { autoApplyFrontmatter } from './lore/entityExtraction.js'
import { configDir, migrateLegacyAppData } from './appData.js'
import ffmpegStatic from 'ffmpeg-static'

// The multitrack upload pipeline probes audio durations via ffmpeg before
// handing files to Whisper. Point FFMPEG_PATH at the bundled per-platform
// binary from ffmpeg-static so users don't need a system install. If
// FFMPEG_PATH is already set (user has a preferred binary), respect it.
if (!process.env.FFMPEG_PATH && ffmpegStatic) {
  process.env.FFMPEG_PATH = ffmpegStatic as unknown as string
}

import { glossaryRouter } from './api/glossary.js'
import { speakersRouter } from './api/speakers.js'
import { providersRouter } from './api/providers.js'
import { providerKeysRouter } from './api/providerKeys.js'
import { diagnosticsRouter } from './api/diagnostics.js'
import { diagnoseRouter } from './api/diagnose.js'
import { slog } from './lib/slog.js'
import { profilesRouter } from './api/profiles.js'
import { routingRouter } from './api/routing.js'
import { runsRouter } from './api/runs.js'
import { sessionsRouter } from './api/sessions.js'
import { chronicleRouter } from './api/chronicle.js'
import { chronicleLibraryRouter } from './api/chronicleLibrary.js'
import { addonsRouter } from './api/addons.js'
import { loadAddons } from './addons/loader.js'
import { docsRouter } from './api/docs.js'
import { loreRouter } from './api/lore.js'
import { detectLore } from './lore/detection.js'
import { initAliasIndexManager } from './lore/aliasIndexManager.js'
import { settingsRouter } from './api/settings.js'
import { systemRouter } from './api/system.js'
import { updaterRouter } from './api/updater.js'
import { vaultRouter } from './api/vault.js'
import { loopbackOnly } from './lib/loopbackGate.js'
import { hostAllowlist } from './lib/hostAllowlist.js'
import { lanWriteGate, parseLanWritesEnv } from './lib/lanWriteGate.js'
import { uploadGate as parseUploadGate } from './api/upload.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

/** Emit a loud warning at boot when node_modules looks out of date with
 *  package-lock.json. The in-app updater intentionally does not run npm
 *  install for the user (the dev server holds node_modules file handles
 *  and would collide), so this is the safety net that surfaces the
 *  missed manual step. Non-fatal — server boots normally either way. */
async function warnIfNodeModulesStale(): Promise<void> {
  try {
    const lockStat = await fs.stat(path.join(ROOT, 'package-lock.json'))
    const nmStat = await fs.stat(path.join(ROOT, 'node_modules', '.package-lock.json'))
    if (nmStat.mtimeMs >= lockStat.mtimeMs) return
    // eslint-disable-next-line no-console
    console.warn(
      '\n' +
      '  ============================================================\n' +
      '   ! node_modules is OUT OF DATE with package-lock.json\n' +
      '  ============================================================\n' +
      '   A previous update pulled new dependency versions, but npm\n' +
      '   install has not been run since. The app may fail to import\n' +
      '   new packages until you refresh dependencies.\n' +
      '\n' +
      '   To fix: stop this server (Ctrl+C), then run:\n' +
      '       npm install --no-audit --no-fund\n' +
      '   (on Windows from PowerShell: cmd /c npm install --no-audit --no-fund)\n' +
      '   then restart.\n' +
      '  ============================================================\n'
    )
  } catch {
    // Missing node_modules or no lock — initial setup not done, or some
    // other configuration. Different failure mode, handled elsewhere.
  }
}

const PORT = Number(process.env.PORT ?? 5173)
// Bind to loopback only by default so a malicious page on the user's LAN
// can't reach the install/launch endpoints. Set TUSKS_HOST=0.0.0.0 (or a
// specific interface IP) to opt into LAN exposure for cross-device use.
const HOST = process.env.TUSKS_HOST ?? '127.0.0.1'
// LAN writes are OFF by default even when TUSKS_HOST=0.0.0.0 is set.
// Reads from other devices (browse chronicles, view transcripts) are
// always allowed; writes (uploads, settings edits, saves) require the
// user to explicitly trust every device on the network by setting
// TUSKS_LAN_WRITES=1. See server/lib/lanWriteGate.ts.
const LAN_WRITES_ENABLED = parseLanWritesEnv(process.env.TUSKS_LAN_WRITES)
const isProd = process.env.NODE_ENV === 'production'

// Unique per process. Used by the client to detect a fresh server boot
// and wipe any stale in-progress workflow state from localStorage.
const BOOT_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

/**
 * Build the configured Express app with the full middleware chain and
 * all non-addon /api/* route mounts. Exported so integration tests can
 * exercise the REAL middleware stack instead of re-implementing it.
 *
 * The function is pure-side-effect-free: it does not bind a port, load
 * add-ons, run data migrations, or print the banner. start() below
 * does all of that around the result of this call.
 *
 * Parameters mirror the env-var inputs:
 *   - host: TUSKS_HOST (controls hostAllowlist)
 *   - port: PORT (used to build ALLOWED_ORIGINS)
 *   - lanWritesEnabled: TUSKS_LAN_WRITES parse result (controls lanWriteGate)
 *
 * For the integration tests we can call this with any combination of
 * those parameters and exercise the same middleware path the production
 * server uses.
 */
export function createApiApp(opts: {
  host: string
  port: number
  lanWritesEnabled: boolean
  isProd?: boolean
  bootId?: string
}): express.Express {
  const { host, port, lanWritesEnabled } = opts
  const isProductionMode = opts.isProd ?? false
  const bootId = opts.bootId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

  const app = express()

  // DNS-rebinding defence. See server/lib/hostAllowlist.ts header.
  app.use(hostAllowlist({ host, port }))

  // Reject cross-origin state-changing requests against /api/*. Browsers
  // attach `Origin` on every non-GET cross-origin fetch, so a present
  // `Origin` that doesn't match our listener is the drive-by-CSRF case.
  // Missing `Origin` indicates a non-browser caller (curl, smoke-test,
  // other local tooling) — allowed by design, since a malicious web page
  // cannot suppress the header.
  //
  // Same-origin-ness is platform-independent: a browser at
  // http://<host-lan-ip>:5173 has Origin and Host both equal to that
  // URL's authority, by definition. We accept that as same-origin. A
  // malicious page on evil.com posting to <host-lan-ip>:5173 has
  // Origin: http://evil.com but Host: <host-lan-ip>:5173 — mismatch,
  // reject. The lanWriteGate immediately below enforces the LAN-write
  // toggle separately; this gate just decides "is this a same-origin
  // request".
  const allowedOrigins = new Set([
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
  ])
  app.use('/api', (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      return next()
    }
    const origin = req.get('origin')
    if (!origin) return next()
    if (allowedOrigins.has(origin)) return next()
    try {
      const originHost = new URL(origin).host.toLowerCase()
      const reqHost = (req.headers.host ?? '').toLowerCase()
      if (originHost && originHost === reqHost) return next()
    } catch {
      // Malformed Origin — fall through and reject.
    }
    return res
      .status(403)
      .json({ error: `Cross-origin request from "${origin}" rejected.` })
  })

  // LAN-write gate. See server/lib/lanWriteGate.ts header.
  app.use('/api', lanWriteGate({ enabled: lanWritesEnabled }))

  // Body parser AFTER the gates so a 403'd request doesn't pay 20 MB
  // of JSON parsing first.
  app.use(express.json({ limit: '20mb' }))

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 },
  })

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, mode: isProductionMode ? 'production' : 'development' })
  })

  app.get('/api/boot', (_req, res) => {
    res.json({ bootId })
  })

  app.use('/api/glossary', glossaryRouter())
  app.use('/api/speakers', speakersRouter())

  // CREDENTIAL-CARRYING + HOST-MUTATING ROUTES — loopback-only.
  // See server/lib/loopbackGate.ts header. Audit Rule 6 enforces.
  app.use('/api/provider-keys', loopbackOnly(), providerKeysRouter())
  // Diagnostics endpoints share the keys' threat model: log payloads can
  // include key fingerprints, model ids, prompt lengths. LAN sources get
  // 403 same as /api/provider-keys.
  app.use('/api/diagnostics', loopbackOnly(), diagnosticsRouter())
  // Diagnose bundles — assembles a structured markdown file the user
  // can hand to Claude Code with a single @-mention. Behind loopback
  // because the bundle includes key fingerprints + routing snapshots.
  app.use('/api/diagnose', loopbackOnly(), diagnoseRouter())
  app.use('/api/providers', loopbackOnly(), providersRouter())
  app.use('/api/updater', loopbackOnly(), updaterRouter())

  app.use('/api/profiles', profilesRouter())
  app.use('/api/routing', routingRouter())
  app.use('/api/runs', runsRouter())
  app.use('/api/sessions', sessionsRouter())
  app.use('/api/chronicle', chronicleRouter())
  app.use('/api/chronicle-library', chronicleLibraryRouter())
  app.use('/api/addons', addonsRouter())
  app.use('/api/docs', docsRouter())
  app.use('/api/lore', loreRouter())
  app.use('/api/settings', settingsRouter())
  app.use('/api/system', systemRouter())
  app.use('/api/vault', vaultRouter())

  // Parse routes share the system-wide in-flight upload cap with
  // /api/sessions/{upload,append}-multitrack. Without this, a LAN
  // attacker with TUSKS_LAN_WRITES=1 could spam 20 MB PDFs through
  // pdfjs (CPU + memory bound) without any aggregate throttling.
  app.post('/api/parse/pdf', parseUploadGate(), upload.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
      const text = await parsePdf(req.file.buffer)
      res.json({ name: req.file.originalname, sizeBytes: req.file.size, text })
    } catch (err) {
      console.error('[parse/pdf] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  app.post('/api/parse/docx', parseUploadGate(), upload.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
      const rawMarkdown = await docxBufferToMarkdown(req.file.buffer)
      // Auto-apply YAML frontmatter so the downloaded .md is ready for the
      // alias index — saves the user a manual review step. The pipeline
      // strips frontmatter from the AI-bound KB, so the file getting bigger
      // here costs nothing on Phase 3 / Phase 6 calls.
      const filename = (req.file.originalname || 'doc.docx').replace(/\.docx$/i, '.md')
      const augmented = autoApplyFrontmatter(rawMarkdown, filename)
      res.json({
        name: req.file.originalname,
        sizeBytes: req.file.size,
        text: augmented.markdown,
        format: 'markdown',
        entitiesAutoIndexed: augmented.result.entities.length,
        headingsPromoted: augmented.result.promotedHeadings,
      })
    } catch (err) {
      console.error('[parse/docx] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  return app
}

const app = createApiApp({
  host: HOST,
  port: PORT,
  lanWritesEnabled: LAN_WRITES_ENABLED,
  isProd,
  bootId: BOOT_ID,
})
const httpServer = createHttpServer(app)

// Local LLM routes (/api/local/* + /api/local-llm/*) used to be inlined
// here but are now owned by the optional `local-llm-addon`. When the
// add-on is loaded, server/addons/registry.ts mounts the routers via
// registerRoutes(). Cloud-only pipelines never see this surface.

async function start() {
  // Pre-flight 1 — Config dir must exist AND be writable. The keystore,
  // addons toggle file, routing.json, etc. all need write access. If we
  // skip this and configDir is read-only (corporate machine, copied user
  // profile, etc.), every settings save downstream fails with a cryptic
  // EACCES that the user never connects back to permissions. Fail loudly
  // up front with a fix-it message instead.
  try {
    const dir = configDir()
    await fs.mkdir(dir, { recursive: true })
    const probe = path.join(dir, '.write-probe')
    await fs.writeFile(probe, 'ok', 'utf8')
    await fs.unlink(probe)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      '\n[startup] Config directory is not writable.\n' +
        `  Tried: ${configDir()}\n` +
        `  Reason: ${(err as Error).message}\n` +
        '  Fix: ensure the folder exists and your user account can write to it.\n' +
        '  On Windows: right-click the folder → Properties → Security → Edit → grant your user "Modify".\n' +
        '  On macOS / Linux: chmod u+rwX on the folder.\n' +
        '  Or move the project to a writable location and restart.\n',
    )
    process.exit(1)
  }

  // Pre-flight 2 — Bind the port BEFORE loading add-ons, so a port-in-use
  // error stops us before we spend time on Whisper sidecar checks etc.
  // Wire the error handler on httpServer first; otherwise EADDRINUSE shows
  // up as an unhandled "error" event with no actionable message and the
  // banner has often already printed by then.
  httpServer.on('error', (err) => {
    const errno = (err as NodeJS.ErrnoException).code
    if (errno === 'EADDRINUSE') {
      // eslint-disable-next-line no-console
      console.error(
        `\n[startup] Port ${PORT} is already in use.\n` +
          '  Fix options:\n' +
          `    A) Use a different port: set PORT=3000 in .env and restart.\n` +
          `    B) Kill the process holding ${PORT}:\n` +
          `       Windows:  netstat -ano | findstr :${PORT}   then  taskkill /PID <pid> /F\n` +
          `       macOS/Linux:  lsof -i :${PORT}   then  kill <pid>\n` +
          '    C) If another Tusk\'s Tomes instance is already running, just open http://127.0.0.1:' +
          PORT +
          '/ in your browser instead.\n',
      )
      process.exit(1)
    } else if (errno === 'EACCES') {
      // eslint-disable-next-line no-console
      console.error(
        `\n[startup] Permission denied binding port ${PORT}.\n` +
          '  Ports below 1024 are restricted on macOS / Linux — pick a port >1024 (set PORT=5173 in .env).\n',
      )
      process.exit(1)
    } else {
      // eslint-disable-next-line no-console
      console.error('[startup] HTTP server error:', err)
      process.exit(1)
    }
  })

  // Load add-ons whose prerequisites are already satisfied. Must run before
  // Vite / static middleware so add-on routes are registered before the
  // catch-all SPA handler.
  await loadAddons(app)

  if (isProd) {
    const distDir = path.join(ROOT, 'dist')
    app.use(express.static(distDir))
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'))
    })
  } else {
    const { createServer: createViteServer } = await import('vite')
    const vite = await createViteServer({
      root: ROOT,
      server: {
        middlewareMode: true,
        hmr: { server: httpServer },
      },
      appType: 'spa',
    })
    app.use(vite.middlewares)
  }

  await migrateLegacyAppData()
  await warnIfNodeModulesStale()

  // Initialise the lore alias-index manager. Loads the persisted index if
  // present, builds a fresh one otherwise, and subscribes to doc-cache
  // invalidations so writes to the lore folder trigger a debounced rebuild.
  // Tolerates a missing lore folder — the manager treats `null` as "no
  // index" and the pipeline falls back to compactKb.
  try {
    const loreStatus = await detectLore()
    await initAliasIndexManager(loreStatus.found ? loreStatus.loreRoot ?? null : null)
  } catch (err) {
    console.warn('[server] alias-index manager init failed:', err)
  }

  httpServer.listen(PORT, HOST, () => {
    // eslint-disable-next-line no-console
    const shown = HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST
    // eslint-disable-next-line no-console
    console.log(`\n  Tusk's Tomes — running at http://${shown}:${PORT}\n`)
    // Mark the diagnostic stream with a boot event so the user can see in
    // the ring when this process started — useful when correlating a bug
    // to a specific dev-server lifetime.
    slog('server', { event: 'server_started', port: PORT, host: HOST, prod: isProd })
    if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
      const writeState = LAN_WRITES_ENABLED ? 'ENABLED' : 'DISABLED (default)'
      // eslint-disable-next-line no-console
      console.log(
        `  ! LAN exposure enabled (bound to ${HOST}).\n` +
        `    Other devices on this network can READ the app (chronicles, transcripts, lists).\n` +
        `    LAN writes (uploads, settings edits, saves): ${writeState}.\n` +
        `    API keys + updater + dev-mode toggles: loopback-only (always, regardless of TUSKS_LAN_WRITES).\n` +
        (LAN_WRITES_ENABLED
          ? `    \n    ⚠  TUSKS_LAN_WRITES=1 is set. Anyone on this Wi-Fi can modify content. Trust your network.\n`
          : `    \n    To allow cross-device writes (e.g. upload from a phone), also set TUSKS_LAN_WRITES=1.\n`
        ) +
        `    To go back to host-only access, set TUSKS_HOST=127.0.0.1.\n`,
      )
    }
  })
}

// Only run start() when this module is the process entrypoint (npm run
// dev / npm start). Importing createApiApp from tests must not trigger
// the listener, addon loading, or banner. Phase 9: this guard makes the
// integration tests safe to import the real module.
function isEntryPoint(): boolean {
  try {
    const entry = process.argv[1]
    if (!entry) return false
    const entryUrl = pathToFileURL(entry).href
    return import.meta.url === entryUrl
  } catch {
    return false
  }
}

if (isEntryPoint()) {
  start().catch((err) => {
    console.error('Failed to start server:', err)
    process.exit(1)
  })
}
