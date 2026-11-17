import type { Express } from 'express'
import {
  whisperInstalled,
  runSetup,
  venvDir,
  registerLiveImpl,
  getLiveSessionState,
  refreshLiveSbv,
  whisperRouter,
  uploadRouter,
  transcribeRouter,
} from '../features/transcription/index.js'
import { promises as fs } from 'node:fs'

export type LogEntry = { stream: 'stdout' | 'stderr'; line: string }
export type LogEmitter = (entry: LogEntry) => void

/**
 * An installable module: a real installation with real prerequisites (today:
 * the audio add-on's Python venv, ~1.5 GB). It has a lifecycle: isReady()
 * gates mounting, install()/uninstall() manage the payload, and the user can
 * toggle it off in addons.json without uninstalling.
 *
 * Features that ship with the app and always mount are not modules; they
 * register their own routes (see `featureRoutes.ts`). Only something with a
 * prerequisite belongs here, so a feature cannot be uninstalled by accident:
 * the old personas uninstall deleted the user's authored personas.json.
 */
export type AddonDefinition = {
  /** The only kind left; kept so the add-on routes can tell a module from a feature by shape. */
  kind: 'install'
  /** Machine-stable identifier used in API paths and UI keys. */
  name: string
  /** Human-readable name shown in the UI. */
  displayName: string
  /** One-line description shown in the UI. */
  description: string
  /** When true, the UI shows an "Experimental" disclaimer. */
  wip: boolean
  /** Optional /api/docs slug for this module's user-facing doc. */
  docSlug?: string
  /** Mounts Express routes at startup. */
  registerRoutes: (app: Express) => void
  /** Returns true if the add-on's prerequisites are satisfied. Called on
   *  every server start — the sole source of truth for "installed". */
  isReady: () => Promise<boolean>
  /** Satisfies prerequisites (e.g. installs a Python venv). Streams log
   *  lines via the emitter; resolves with the setup exit code. */
  install: (emit: LogEmitter) => Promise<number>
  /** Removes prerequisites so the add-on won't load on next restart. */
  uninstall: () => Promise<void>
}

export const ADDON_REGISTRY: AddonDefinition[] = [
  {
    kind: 'install',
    name: 'audio-addon',
    displayName: 'Audio Transcription',
    description:
      'Multitrack Craig recording upload and local Whisper transcription pipeline. ' +
      'Downloads a Python virtual environment (~1.5 GB). Requires Python 3.10–3.12 on your PATH; ' +
      'transcription speed needs an NVIDIA GPU (CPU works, but a 3-hour session takes hours).',
    wip: true,
    docSlug: 'docs-extras-audio-transcription',
    async isReady() {
      // Filesystem facts only. Whether the venv actually imports
      // faster-whisper is checked again at request time (status endpoint,
      // transcription worker), so spawning Python here would only make
      // start-up wait on a child process that can hang — and the routes
      // mounted on this answer already cope with a broken venv.
      const s = await whisperInstalled()
      return s.installed
    },
    async install(emit) {
      return await runSetup(emit)
    },
    async uninstall() {
      await fs.rm(venvDir(), { recursive: true, force: true })
    },
    registerRoutes(app) {
      registerLiveImpl(getLiveSessionState, refreshLiveSbv)
      app.use('/api/sessions', transcribeRouter())
      app.use('/api/sessions', uploadRouter())
      app.use('/api/whisper', whisperRouter())
    },
  },
]
