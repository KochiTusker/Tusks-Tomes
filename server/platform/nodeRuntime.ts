// Tells someone whose Node.js is older than the app supports, once per start.
//
// Setup refuses an old Node, but an install that predates a raised minimum
// never runs setup again: the in-app updater pulls and leaves npm install to
// the user, and npm only warns about engine ranges. This is what reaches them.
//
// Warn only. The app may well still run on the older Node, and refusing to
// start would lock someone out of their sessions over a version number.
//
// The minimum and the install advice come from scripts/setup/node-version.mjs,
// the module setup and the updater read too. It is loaded by path at run time
// rather than imported: the built server (dist-server/) has no copy of
// scripts/, so a static import would resolve to a file that isn't there.

import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { repoRoot } from './repoRoot.js'
import { slog } from './slog.js'

/** The part of scripts/setup/node-version.mjs the server uses. */
type NodeVersionModule = {
  MIN_NODE_MAJOR: number
  nodeUpgradeAdvice: (version: string, platform: string) => string[] | null
}

async function loadNodeVersionModule(): Promise<NodeVersionModule | null> {
  try {
    const file = path.join(repoRoot(), 'scripts', 'setup', 'node-version.mjs')
    return (await import(pathToFileURL(file).href)) as NodeVersionModule
  } catch {
    // No scripts/ beside the server, or it failed to load. Not knowing the
    // minimum is no reason to stop the app starting.
    return null
  }
}

/**
 * Prints a boxed warning to the console and records `node_unsupported` in the
 * diagnostics log when `version` is older than the supported minimum.
 * Returns whether it warned. `version` and `platform` default to the running
 * process.
 */
export async function warnIfNodeUnsupported(
  opts: { version?: string; platform?: NodeJS.Platform } = {},
): Promise<boolean> {
  const version = opts.version ?? process.versions.node
  const platform = opts.platform ?? process.platform
  const nodeVersion = await loadNodeVersionModule()
  const advice = nodeVersion?.nodeUpgradeAdvice(version, platform)
  if (!nodeVersion || !advice) return false

  const rule = '  ============================================================'
  console.warn(
    [
      '',
      rule,
      `   ! Node.js ${version} is older than Tusk's Tomes supports`,
      rule,
      ...advice.map((line) => `   ${line}`),
      '',
      '   The app keeps running, but parts of it may fail on this Node.js.',
      '   To upgrade: stop this server (Ctrl+C), install the newer Node.js,',
      '   then start the app again from a new terminal window.',
      rule,
      '',
    ].join('\n'),
  )
  slog('server', { event: 'node_unsupported', node: version, minimum: nodeVersion.MIN_NODE_MAJOR })
  return true
}
