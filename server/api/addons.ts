import express, { type Router } from 'express'
import { ADDON_REGISTRY, type LogEntry } from '../addons/registry.js'
import {
  isAddonConfigEnabled,
  isAddonLoaded,
  readAddonsConfig,
  writeAddonsConfig,
} from '../addons/loader.js'

export function addonsRouter(): Router {
  const router = express.Router()

  // List all registered add-ons with their current status.
  //   - `enabled`       : prerequisites installed (isReady()).
  //   - `configEnabled` : user hasn't toggled this add-on off.
  //   - `loaded`        : routes are mounted in the current process.
  //   - `readyError`    : populated when isReady() threw — the message
  //                       includes the add-on name + raw exception text +
  //                       recovery hint, so the UI can surface "Add-on
  //                       <name> failed prereq check, try reinstalling".
  // The first three diverge between install/uninstall/toggle and the next
  // server restart; the UI uses `loaded` for visibility decisions and
  // shows a "Restart required" pill when they don't line up.
  router.get('/', async (_req, res) => {
    try {
      const config = await readAddonsConfig()
      const addons = await Promise.all(
        ADDON_REGISTRY.map(async (addon) => {
          let ready = false
          let readyError: string | undefined
          try {
            ready = await addon.isReady()
          } catch (err) {
            // One addon's prereq check failing must NOT mask other addons.
            // Capture the failure inline so the UI can surface it next to
            // the row instead of returning HTTP 500 for the whole list.
            const original = (err as Error).message ?? String(err)
            readyError =
              `Add-on "${addon.name}" failed its readiness check: ${original}. ` +
              'Try: Settings → Add-ons → uninstall + reinstall, or restart the dev server. ' +
              'If the problem persists, check `.diagnose/latest.md` for the full stack trace.'
            // eslint-disable-next-line no-console
            console.error(`[addons] ${addon.name}.isReady() threw:`, err)
          }
          return {
            name: addon.name,
            displayName: addon.displayName,
            description: addon.description,
            wip: addon.wip,
            docSlug: addon.docSlug,
            enabled: ready,
            readyError,
            configEnabled: isAddonConfigEnabled(addon.name, config),
            loaded: isAddonLoaded(addon.name),
          }
        })
      )
      res.json({ addons })
    } catch (err) {
      // Outer catch: config read failure or something else non-addon-specific.
      res.status(500).json({
        error:
          `Failed to enumerate add-ons: ${(err as Error).message}. ` +
          'This usually means the config directory is unreadable. ' +
          'Check folder permissions on the Tusks-Tomes config folder, then restart.',
      })
    }
  })

  // Toggle an add-on on/off without uninstalling. Persists to
  // {configDir}/addons.json; takes effect at next server restart (UI
  // surfaces the "Restart required" pill in the meantime).
  router.patch('/:name', async (req, res) => {
    const addon = ADDON_REGISTRY.find((a) => a.name === req.params.name)
    if (!addon) return res.status(404).json({ error: `Unknown add-on: ${req.params.name}` })

    const body = req.body as { configEnabled?: unknown }
    if (typeof body?.configEnabled !== 'boolean') {
      return res.status(400).json({ error: '`configEnabled` must be a boolean' })
    }
    try {
      const config = await readAddonsConfig()
      config[addon.name] = { ...config[addon.name], configEnabled: body.configEnabled }
      await writeAddonsConfig(config)
      res.json({ ok: true, name: addon.name, configEnabled: body.configEnabled })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // Install an add-on — streams SSE progress (same pattern as /api/whisper/setup).
  // POST (not GET) so a drive-by `<img src=…>` can't trigger the install.
  // Client consumes the SSE response via `fetch().body.getReader()`.
  router.post('/:name/install', async (req, res) => {
    const addon = ADDON_REGISTRY.find((a) => a.name === req.params.name)
    if (!addon) return res.status(404).json({ error: `Unknown add-on: ${req.params.name}` })

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders?.()

    try {
      const exitCode = await addon.install((entry: LogEntry) => {
        res.write(`event: line\n`)
        res.write(`data: ${JSON.stringify(entry)}\n\n`)
      })
      res.write(`event: done\n`)
      res.write(`data: ${JSON.stringify({ exitCode })}\n\n`)
    } catch (err) {
      res.write(`event: error\n`)
      res.write(`data: ${JSON.stringify({ error: (err as Error).message })}\n\n`)
    } finally {
      res.end()
    }
  })

  // Uninstall an add-on (removes prerequisites so it won't load on next restart).
  router.delete('/:name', async (req, res) => {
    const addon = ADDON_REGISTRY.find((a) => a.name === req.params.name)
    if (!addon) return res.status(404).json({ error: `Unknown add-on: ${req.params.name}` })
    try {
      await addon.uninstall()
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  return router
}
