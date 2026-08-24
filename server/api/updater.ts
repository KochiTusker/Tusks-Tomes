// In-app self-updater API. Drives the Updater card in the Settings
// tab: a "Check for updates" button posts /api/updater/check (which
// runs `git fetch` and reports how far the local main is behind
// origin/main), and an "Apply update" button posts /api/updater/apply
// (which invokes the platform-specific update script).
//
// Safety rails:
//   - Refuses to act if the repo isn't a git checkout (ZIP installs
//     can't self-update; user has to re-download).
//   - Refuses to act if the user isn't on the main branch (won't
//     surprise feature-branch work).
//   - Refuses to apply if the working tree is dirty (won't clobber
//     uncommitted edits).
//   - Refuses non-fast-forward pulls (no surprise merge commits).
//
// Concurrency:
//   - One apply at a time, guarded by an in-process mutex. Concurrent
//     check calls are allowed since they're read-only.

import express, { type Router } from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import { platform } from 'node:os'
import {
  effectiveUpdaterRemote,
  isDevAuthRequired,
  type UpdaterRemote,
} from './settings.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..')
const IS_WIN = platform() === 'win32'

const UPDATE_SCRIPT_POSIX = path.join(REPO_ROOT, 'scripts', 'update', 'apply.sh')
const UPDATE_SCRIPT_WIN = path.join(REPO_ROOT, 'scripts', 'update', 'apply.ps1')

/** Truthy iff a `.git` directory exists at the repo root — the
 *  distinguishing marker between a git clone and a ZIP-extracted install. */
async function isGitCheckout(): Promise<boolean> {
  try {
    const stat = await fs.stat(path.join(REPO_ROOT, '.git'))
    return stat.isDirectory() || stat.isFile() // worktree pointers are files
  } catch {
    return false
  }
}

function runGit(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: IS_WIN,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (b: Buffer) => (stdout += b.toString('utf8')))
    child.stderr.on('data', (b: Buffer) => (stderr += b.toString('utf8')))
    child.on('error', (err) => resolve({ code: 1, stdout: '', stderr: err.message }))
    child.on('close', (code) =>
      resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() })
    )
  })
}

export type UpdaterCommit = {
  sha: string
  shortSha: string
  subject: string
  author: string
  date: string
}

export type UpdaterStatus = {
  /** True if the repo is a git checkout (vs ZIP install). */
  installedViaGit: boolean
  /** Current branch name. null when detached HEAD. */
  branch: string | null
  /** Working tree clean? Only meaningful when installedViaGit. */
  clean: boolean
  /** Lines from `git status --short`, capped at 50, when not clean. */
  dirtyFiles?: string[]
  /** Resolved HEAD commit. null when not a git checkout. */
  head?: UpdaterCommit
  /** Resolved <remoteName>/main commit. null when remote is unknown. */
  remoteHead?: UpdaterCommit
  /** Commits in <remoteName>/main but not in HEAD (the ones an apply
   *  would pull in). */
  pendingCommits: UpdaterCommit[]
  /** Commits in HEAD but not in <remoteName>/main (only non-zero if
   *  user has unpushed local commits — usually means they hand-edited
   *  code). */
  aheadCommits: UpdaterCommit[]
  /** ISO timestamp of the last `git fetch <remoteName> main` we observed. */
  lastFetchAt?: string
  /** Human-readable reason the apply button should be hidden/disabled. */
  blockedReason?: string
  /** True iff node_modules/.package-lock.json is older than
   *  package-lock.json — meaning a prior in-app update pulled new deps
   *  but the user hasn't run `npm install` yet. Surfaces a persistent
   *  warning banner so missed manual installs are obvious. */
  nodeModulesStale?: boolean
  /** Which git remote NAME this status was computed against. "origin" is
   *  the normal user path; "dev" is an optional pre-release
   *  remote. UI uses this to render the amber dev-mode banner. */
  remoteName: UpdaterRemote
  /** True when the persisted preference is "dev" but the in-memory
   *  session auth grant hasn't been provided yet (or was cleared by
   *  a restart). UI shows the email prompt when this is true. */
  devAuthRequired?: boolean
}

/** Compare node_modules/.package-lock.json mtime to package-lock.json
 *  mtime. The same heuristic check-deps.mjs uses for "should we run npm
 *  install". Returns true when a refresh is overdue. */
async function isNodeModulesStale(): Promise<boolean> {
  try {
    const lockStat = await fs.stat(path.join(REPO_ROOT, 'package-lock.json'))
    const nmStat = await fs.stat(path.join(REPO_ROOT, 'node_modules', '.package-lock.json'))
    // node_modules/.package-lock.json is rewritten by npm install. If it's
    // older than package-lock.json, deps were updated without npm install.
    return nmStat.mtimeMs < lockStat.mtimeMs
  } catch {
    // Missing node_modules or missing inner lock — treat as not-stale
    // (initial setup not done, separate failure mode the boot script
    // handles).
    return false
  }
}

const PRETTY_FORMAT = '%H%x09%h%x09%s%x09%an%x09%aI'

function parseCommitLines(stdout: string): UpdaterCommit[] {
  if (!stdout.trim()) return []
  return stdout
    .split('\n')
    .map((line) => {
      const [sha, shortSha, subject, author, date] = line.split('\t')
      if (!sha) return null
      return { sha, shortSha, subject: subject ?? '', author: author ?? '', date: date ?? '' }
    })
    .filter((c): c is UpdaterCommit => c !== null)
}

async function commitFor(rev: string): Promise<UpdaterCommit | undefined> {
  const r = await runGit(['log', '-1', `--pretty=format:${PRETTY_FORMAT}`, rev])
  if (r.code !== 0) return undefined
  const [hit] = parseCommitLines(r.stdout)
  return hit
}

async function getFetchTime(remote: UpdaterRemote): Promise<string | undefined> {
  // FETCH_HEAD is touched whenever git fetch runs against any remote.
  // refs/remotes/<remote>/main is rewritten only by fetches against
  // that specific remote, so it's the more accurate fallback. Try
  // both, fall back to undefined.
  for (const p of [
    path.join(REPO_ROOT, '.git', 'FETCH_HEAD'),
    path.join(REPO_ROOT, '.git', 'refs', 'remotes', remote, 'main'),
  ]) {
    try {
      const stat = await fs.stat(p)
      return stat.mtime.toISOString()
    } catch {
      /* try next */
    }
  }
  return undefined
}

async function computeStatus(remote: UpdaterRemote): Promise<UpdaterStatus> {
  const installedViaGit = await isGitCheckout()
  if (!installedViaGit) {
    return {
      installedViaGit: false,
      branch: null,
      clean: false,
      pendingCommits: [],
      aheadCommits: [],
      blockedReason:
        "This install isn't a git checkout (no .git directory). The in-app updater can't help — re-download the latest ZIP from GitHub or clone the repo with git.",
      remoteName: remote,
    }
  }

  const branchRes = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'])
  const branch = branchRes.code === 0 ? branchRes.stdout : null
  const statusRes = await runGit(['status', '--porcelain'])
  const dirtyLines = statusRes.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 50)
  const clean = dirtyLines.length === 0

  const head = await commitFor('HEAD')
  const remoteHead = await commitFor(`${remote}/main`).catch(() => undefined)
  const pendingCommits = remoteHead
    ? parseCommitLines(
        (await runGit(['log', `HEAD..${remoteHead.sha}`, `--pretty=format:${PRETTY_FORMAT}`])).stdout
      )
    : []
  const aheadCommits = remoteHead
    ? parseCommitLines(
        (await runGit(['log', `${remoteHead.sha}..HEAD`, `--pretty=format:${PRETTY_FORMAT}`])).stdout
      )
    : []

  let blockedReason: string | undefined
  if (branch !== 'main') {
    blockedReason = `You're on branch "${branch}", not "main". The updater only updates the main branch.`
  } else if (!clean) {
    blockedReason = `Working tree has ${dirtyLines.length} uncommitted change(s). Commit or stash them before updating, otherwise the pull will refuse to overwrite local edits.`
  } else if (!remoteHead) {
    blockedReason = `Couldn't resolve ${remote}/main (network down? "${remote}" remote misconfigured or you lack credentials?). Run 'git fetch ${remote}' and try again.`
  }

  return {
    installedViaGit: true,
    branch,
    clean,
    dirtyFiles: clean ? undefined : dirtyLines,
    head,
    remoteHead,
    pendingCommits,
    aheadCommits,
    lastFetchAt: await getFetchTime(remote),
    blockedReason,
    nodeModulesStale: await isNodeModulesStale(),
    remoteName: remote,
  }
}

/** Apply mutex — one update at a time. */
let applyInFlight = false

function runUpdateScript(remote: UpdaterRemote): Promise<{ code: number; output: string }> {
  // Apply scripts read TUSKS_TOMES_UPDATE_REMOTE and fall back to
  // "origin" when unset, matching the default elsewhere in the stack.
  const env = { ...process.env, TUSKS_TOMES_UPDATE_REMOTE: remote }
  return new Promise((resolve) => {
    const child = IS_WIN
      ? spawn('powershell', ['-ExecutionPolicy', 'Bypass', '-File', UPDATE_SCRIPT_WIN], {
          cwd: REPO_ROOT,
          stdio: ['ignore', 'pipe', 'pipe'],
          env,
        })
      : spawn('bash', [UPDATE_SCRIPT_POSIX], {
          cwd: REPO_ROOT,
          stdio: ['ignore', 'pipe', 'pipe'],
          env,
        })
    let output = ''
    child.stdout.on('data', (b: Buffer) => (output += b.toString('utf8')))
    child.stderr.on('data', (b: Buffer) => (output += b.toString('utf8')))
    child.on('error', (err) =>
      resolve({ code: 1, output: output + `\n[updater] spawn failed: ${err.message}` })
    )
    child.on('close', (code) => resolve({ code: code ?? 1, output }))
  })
}

export function updaterRouter(): Router {
  const router = express.Router()

  /** Read-only status, plus optionally trigger a `git fetch` first. */
  router.get('/status', async (req, res) => {
    try {
      const remote = await effectiveUpdaterRemote()
      const devAuthRequired = await isDevAuthRequired()
      if (req.query.fetch === '1') {
        await runGit(['fetch', remote, 'main'])
      }
      const status = await computeStatus(remote)
      res.json({ ...status, devAuthRequired })
    } catch (err) {
      console.error('[api/updater/status] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  /** Force a `git fetch <remote> main`, then return fresh status. */
  router.post('/check', async (_req, res) => {
    try {
      const remote = await effectiveUpdaterRemote()
      const devAuthRequired = await isDevAuthRequired()
      const fetched = await runGit(['fetch', remote, 'main'])
      const status = await computeStatus(remote)
      res.json({
        ...status,
        devAuthRequired,
        fetchOk: fetched.code === 0,
        fetchError: fetched.code === 0 ? undefined : fetched.stderr,
      })
    } catch (err) {
      console.error('[api/updater/check] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  /** Run the platform-specific apply script. Blocks while running.
   *
   *  Requires the caller to provide `confirmRemoteHead` matching the
   *  current remote HEAD sha. This is intent-capture defence in depth:
   *  the UI is expected to show "this will update to <sha>", so the
   *  client confirms it knows which sha it's pulling. A network attacker
   *  who slips a different commit in between status() and apply() is
   *  caught by the mismatch and returns 412. Full crypto verification
   *  (GPG-signed tags + `git verify-tag`) is deferred. */
  router.post('/apply', async (req, res) => {
    if (applyInFlight) {
      return res.status(409).json({ error: 'An update is already in progress.' })
    }
    try {
      const remote = await effectiveUpdaterRemote()
      const status = await computeStatus(remote)
      if (!status.installedViaGit || status.blockedReason) {
        return res.status(409).json({
          error:
            status.blockedReason ??
            "Updater can't run — this install isn't a git checkout.",
        })
      }
      if (status.pendingCommits.length === 0) {
        return res.json({
          ok: true,
          alreadyUpToDate: true,
          message: `Already up to date — HEAD is at ${status.head?.shortSha}.`,
        })
      }

      // Intent-capture against a between-status-and-apply remote-HEAD swap.
      // Require the FULL 40-char sha; the previous 7-char short-sha branch
      // collapsed the collision space to ~16M, which is brute-forceable by
      // a network attacker who can influence one specific user. UI at
      // [src/components/UpdaterCard.tsx] already sends the full sha via
      // status.remoteHead?.sha, so requiring 40 chars is no UX cost.
      const HEX40_RE = /^[a-f0-9]{40}$/
      const confirmRemoteHead = (req.body as { confirmRemoteHead?: string } | undefined)
        ?.confirmRemoteHead
      if (typeof confirmRemoteHead !== 'string' || !HEX40_RE.test(confirmRemoteHead)) {
        return res.status(412).json({
          error:
            'confirmRemoteHead required — pass the full 40-char remote HEAD sha you intend to update to.',
        })
      }
      if (confirmRemoteHead !== status.remoteHead?.sha) {
        return res.status(412).json({
          error: `confirmRemoteHead mismatch. Got ${confirmRemoteHead.slice(0, 12)}…, current remote HEAD is ${status.remoteHead?.sha}.`,
        })
      }

      applyInFlight = true
      const before = status.head?.sha
      const { code, output } = await runUpdateScript(remote)
      const after = await computeStatus(remote)
      applyInFlight = false

      if (code !== 0) {
        return res.status(500).json({
          ok: false,
          error: `Update script exited with code ${code}. See output below.`,
          output,
          status: after,
        })
      }
      const applied = Boolean(before && after.head?.sha !== before)
      // Did any of the pulled commits touch the dependency manifest? The
      // script also detects this and prints DEPENDENCY_CHANGES_DETECTED,
      // but we compute it server-side too so the UI doesn't have to
      // string-grep the output. When true, the UI shows the manual
      // npm-install banner instead of a plain success message.
      let depsChanged = false
      if (applied && before && after.head?.sha) {
        const diff = await runGit(['diff', '--name-only', `${before}..${after.head.sha}`])
        depsChanged = diff.code === 0 && /\b(package|package-lock)\.json\b/.test(diff.stdout)
      }
      res.json({
        ok: true,
        applied,
        depsChanged,
        message: !applied
          ? `Update script ran but HEAD did not move (${after.head?.shortSha}).`
          : depsChanged
            ? `Updated to ${after.head?.shortSha}. Dependencies changed — stop the dev server and run the npm install command before restarting.`
            : `Updated to ${after.head?.shortSha}. Restart the dev server to load the new code.`,
        output,
        status: after,
      })
    } catch (err) {
      applyInFlight = false
      console.error('[api/updater/apply] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  return router
}
