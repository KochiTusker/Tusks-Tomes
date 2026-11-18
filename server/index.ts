import express from 'express'
import multer from 'multer'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { repoRoot } from './platform/repoRoot.js'
import { createServer as createHttpServer } from 'node:http'
import {
  docxBufferToMarkdown,
  autoApplyFrontmatter,
  loreRouter,
  detectLore,
  initAliasIndexManager,
  vaultRouter,
} from './features/lore/index.js'
import { configDir, migrateLegacyAppData } from './platform/appData.js'
import ffmpegStatic from 'ffmpeg-static'

// The multitrack upload pipeline probes audio durations via ffmpeg before
// handing files to Whisper. Point FFMPEG_PATH at the bundled per-platform
// binary from ffmpeg-static so users don't need a system install. If
// FFMPEG_PATH is already set (user has a preferred binary), respect it.
if (!process.env.FFMPEG_PATH && ffmpegStatic) {
  process.env.FFMPEG_PATH = ffmpegStatic as unknown as string
}

import { glossaryRouter, speakersRouter } from './features/corrections/index.js'
import { providersRouter } from './features/providers/routes/providers.js'
import {
  openrouterModelsRouter,
  providerKeysRouter,
  profilesRouter,
} from './features/providers/index.js'
import {
  diagnosticsRouter,
  diagnoseRouter,
  settingsRouter,
  systemRouter,
  updaterRouter,
} from './features/maintenance/index.js'
import { slog } from './platform/slog.js'
import { routingRouter } from './features/routing/index.js'
import { runsRouter } from './features/pipeline/index.js'
import { sessionsRouter, uploadGate as parseUploadGate } from './features/transcription/index.js'
import { chronicleRouter, chronicleLibraryRouter } from './features/library/index.js'
import { addonsRouter } from './platform/routes/addons.js'
import { loadAddons } from './addons/loader.js'
import { docsAssets, docsRouter } from './features/help/index.js'
import { loopbackOnly } from './platform/loopbackGate.js'
import { hostAllowlist } from './platform/hostAllowlist.js'
import { lanWriteGate, parseLanWritesEnv } from './platform/lanWriteGate.js'
import { warnIfNodeUnsupported } from './platform/nodeRuntime.js'
import {
  bootReadiness,
  elapsedSeconds,
  readinessGate,
  setBootPhase,
  step,
  uptimeMs,
  type ReadinessSource,
} from './platform/readiness.js'

const ROOT = repoRoot()

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
// TUSKS_LAN_WRITES=1. See server/platform/lanWriteGate.ts.
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
 *
 * `readiness` is what start() passes so the app can answer "starting"
 * until every start-up step has run. Without it the gate is not
 * registered and every route is open from the first request, which is
 * what a test building the app on its own wants.
 */
export function createApiApp(opts: {
  host: string
  port: number
  lanWritesEnabled: boolean
  isProd?: boolean
  bootId?: string
  readiness?: ReadinessSource
}): express.Express {
  const { host, port, lanWritesEnabled, readiness } = opts
  const isProductionMode = opts.isProd ?? false
  const bootId = opts.bootId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

  const app = express()

  // DNS-rebinding defence. See server/platform/hostAllowlist.ts header.
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

  // LAN-write gate. See server/platform/lanWriteGate.ts header.
  app.use('/api', lanWriteGate({ enabled: lanWritesEnabled }))

  // Readiness gate. After the security gates — a request the host or
  // origin checks would refuse is refused whether or not the server is
  // ready — and before every router, so nothing is served half-built.
  // See server/platform/readiness.ts for what it answers.
  if (readiness) app.use(readinessGate(readiness))

  // Body parser AFTER the gates so a 403'd request doesn't pay 20 MB
  // of JSON parsing first.
  app.use(express.json({ limit: '20mb' }))

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 },
  })

  // Answers from the moment the port is bound. `ready` and `phase` are
  // what the launchers and the starting page poll; a caller that only
  // wants to know the server exists can keep reading `ok`.
  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      mode: isProductionMode ? 'production' : 'development',
      ready: readiness ? readiness.isReady() : true,
      phase: readiness ? readiness.phase() : 'ready',
      uptimeMs: uptimeMs(),
    })
  })

  app.get('/api/boot', (_req, res) => {
    res.json({ bootId })
  })

  app.use('/api/glossary', glossaryRouter())
  app.use('/api/speakers', speakersRouter())

  // CREDENTIAL-CARRYING + HOST-MUTATING ROUTES — loopback-only.
  // See server/platform/loopbackGate.ts header. Audit Rule 6 enforces.
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
  // The images those docs embed, at the same path the docs site uses.
  app.use('/docs/assets', docsAssets(ROOT))
  app.use('/api/lore', loreRouter())
  app.use('/api/openrouter', openrouterModelsRouter())
  app.use('/api/settings', settingsRouter())
  app.use('/api/system', systemRouter())
  app.use('/api/vault', vaultRouter())

  // Parse routes share the system-wide in-flight upload cap with
  // /api/sessions/{upload,append}-multitrack. Without this, a LAN
  // attacker with TUSKS_LAN_WRITES=1 could spam 20 MB documents through
  // the parser (CPU + memory bound) without any aggregate throttling.
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
  readiness: bootReadiness,
})
const httpServer = createHttpServer(app)

// Local LLM routes (/api/local/* + /api/local-llm/*) are owned by the
// providers feature and mounted with the other feature routes from
// server/addons/featureRoutes.ts.

/** The version from package.json, for the first line of output. Read
 *  from disk rather than imported: package.json sits outside the server
 *  compilation root. A missing or unreadable file must not stop the app,
 *  so it degrades to a banner without a number. */
async function readAppVersion(): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(ROOT, 'package.json'), 'utf8')
    const version = (JSON.parse(raw) as { version?: unknown }).version
    return typeof version === 'string' ? version : null
  } catch {
    return null
  }
}

/** Longest the READY line waits on Vite's warm-up. The warm-up compiles
 *  the entry module and, after an update, rebuilds the dependency cache;
 *  measured at a few seconds warm and about twenty cold. A machine that is
 *  still going at this point has a real problem, and holding the READY
 *  line back forever would hide it behind a page that never changes —
 *  better to open the app and let the first page load show what is wrong. */
const WARMUP_CAP_MS = 90_000

async function start() {
  // The first line goes out before any work, so the window a launcher
  // opened is never blank while the config probe and the port bind run.
  const version = await readAppVersion()
  // eslint-disable-next-line no-console
  console.log(`\n  Tusk's Tomes${version ? ` v${version}` : ''} — starting`)
  // Before any start-up work, so it shows even when a later step fails.
  await warnIfNodeUnsupported()
  const totalSteps = isProd ? 3 : 5

  // Step 1 — Config dir must exist AND be writable. The keystore, addons
  // toggle file, routing.json, etc. all need write access. If we skip
  // this and configDir is read-only (corporate machine, copied user
  // profile, etc.), every settings save downstream fails with a cryptic
  // EACCES that the user never connects back to permissions. Fail loudly
  // up front with a fix-it message instead.
  step(1, totalSteps, 'checking the config folder')
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

  // Legacy app-data migration stays ahead of the port bind: once the port
  // is open a request can reach a router that reads the config dir, and
  // it must find the files where the current layout puts them.
  await migrateLegacyAppData()

  // Wire the error handler on httpServer before binding; otherwise
  // EADDRINUSE shows up as an unhandled "error" event with no actionable
  // message.
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

  // Bind now, before add-ons, lore or Vite. Everything after this point
  // is answered by the readiness gate until it finishes, so a launcher or
  // an early browser tab sees "starting" rather than a refused connection,
  // and a port-in-use error stops the process before any of that work.
  await new Promise<void>((resolve) => httpServer.listen(PORT, HOST, resolve))
  const shown = HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST
  const url = `http://${shown}:${PORT}`
  // eslint-disable-next-line no-console
  console.log(`  Tusk's Tomes — ${url} (starting…)`)
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

  // Step 2 — add-ons whose prerequisites are already satisfied. Must run
  // before Vite / static middleware so add-on routes are registered before
  // the catch-all SPA handler.
  setBootPhase('addons')
  step(2, totalSteps, 'loading add-ons')
  await loadAddons(app)

  // Step 3 — lore. Loads the persisted alias index if present, builds a
  // fresh one otherwise, and subscribes to doc-cache invalidations so
  // writes to the lore folder trigger a debounced rebuild. Tolerates a
  // missing lore folder — the manager treats `null` as "no index" and the
  // pipeline falls back to compactKb. The node_modules check sits here
  // too: if it has something to say, it should say it before Vite tries
  // to import whatever is missing.
  setBootPhase('lore')
  step(3, totalSteps, 'reading the lore folder')
  await warnIfNodeModulesStale()
  try {
    const loreStatus = await detectLore()
    await initAliasIndexManager(loreStatus.found ? loreStatus.loreRoot ?? null : null)
  } catch (err) {
    console.warn('[server] alias-index manager init failed:', err)
  }

  if (isProd) {
    const distDir = path.join(ROOT, 'dist')
    app.use(express.static(distDir))
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'))
    })
  } else {
    // Step 4 — Vite. Its dependency optimiser runs inside createServer and
    // prints its own line ("Re-optimizing dependencies…") when the
    // lockfile has changed since the last start, which is the one case
    // this step takes longer than a moment. The step line goes out first
    // so that message reads as part of a step, not a stall.
    setBootPhase('vite')
    step(4, totalSteps, 'preparing the interface (takes longer after an update)')
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

    // Step 5 — compile the entry module now rather than on the first
    // request, and hold READY until it is done: a browser that opens on
    // READY then gets the app, not a blank page waiting on a transform.
    // Capped so a compile that never returns cannot hold the app hostage.
    step(5, totalSteps, 'compiling the interface for its first request')
    let capTimer: NodeJS.Timeout | undefined
    const cap = new Promise<'cap'>((resolve) => {
      capTimer = setTimeout(() => resolve('cap'), WARMUP_CAP_MS)
    })
    const warm = vite
      .warmupRequest('/src/main.tsx')
      .then(() => 'done' as const)
      .catch((err: unknown) => {
        console.warn(
          '[startup] warm-up did not complete; the first page load will compile instead:',
          (err as Error)?.message ?? err,
        )
        return 'done' as const
      })
    const outcome = await Promise.race([warm, cap])
    clearTimeout(capTimer)
    if (outcome === 'cap') {
      console.warn(
        `[startup] the interface was still compiling after ${WARMUP_CAP_MS / 1000}s; opening anyway. ` +
          'If the page stays blank, stop the app, run npm install --no-audit --no-fund, and start again.',
      )
    }
  }

  setBootPhase('ready')
  const seconds = elapsedSeconds()
  // eslint-disable-next-line no-console
  console.log(`\n  READY in ${seconds}s — ${url}\n`)
  slog('server', { event: 'server_ready', port: PORT, host: HOST, prod: isProd, seconds: Number(seconds) })
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
