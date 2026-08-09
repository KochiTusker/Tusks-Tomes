// React-side client for /api/updater — drives the Updater card on the
// Settings tab. Three operations:
//
//   - getStatus()  → read current HEAD + pending commits without
//                    touching the network. Fast; safe to poll.
//   - check()      → POST /check, which runs `git fetch origin main`
//                    and returns fresh status. Slower; runs only when
//                    the user clicks "Check for updates".
//   - apply()      → POST /apply, which invokes the platform-specific
//                    update script. Blocks until the script finishes.

export type UpdaterCommit = {
  sha: string
  shortSha: string
  subject: string
  author: string
  date: string
}

export type UpdaterRemote = 'origin' | 'dev'

export type UpdaterStatus = {
  installedViaGit: boolean
  branch: string | null
  clean: boolean
  dirtyFiles?: string[]
  head?: UpdaterCommit
  remoteHead?: UpdaterCommit
  pendingCommits: UpdaterCommit[]
  aheadCommits: UpdaterCommit[]
  lastFetchAt?: string
  blockedReason?: string
  /** True iff node_modules/.package-lock.json is older than
   *  package-lock.json — the user pulled new deps but hasn't run
   *  npm install. UI shows a persistent warning banner when set. */
  nodeModulesStale?: boolean
  /** Which git remote the status was computed against. "origin" is the
   *  public Tusks-Tomes repo on a normal install; "dev" is the
   *  maintainer's preview remote (Tusks-Tomes-Dev). UI uses this to
   *  render the amber dev-mode banner. */
  remoteName?: UpdaterRemote
  /** True when settings.updaterRemote === "dev" but the in-memory
   *  session grant is missing (server restarted, or the maintainer
   *  hit the lock button). UI shows the email re-entry prompt. */
  devAuthRequired?: boolean
}

export type UpdaterCheckResult = UpdaterStatus & {
  fetchOk: boolean
  fetchError?: string
}

export type UpdaterApplyResult = {
  ok: boolean
  applied?: boolean
  alreadyUpToDate?: boolean
  /** True iff the pulled commits touched package.json or package-lock.json.
   *  UI surfaces a manual-install banner when set — the in-app updater
   *  intentionally does not run npm install for the user. */
  depsChanged?: boolean
  message?: string
  error?: string
  output?: string
  status?: UpdaterStatus
}

export async function getUpdaterStatus(): Promise<UpdaterStatus> {
  const res = await fetch('/api/updater/status')
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`)
  }
  return (await res.json()) as UpdaterStatus
}

export async function checkForUpdates(): Promise<UpdaterCheckResult> {
  const res = await fetch('/api/updater/check', { method: 'POST' })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`)
  }
  return (await res.json()) as UpdaterCheckResult
}

/** Switch the persisted preference back to "origin" (public). Also
 *  clears any active dev-mode session grant on the server side. */
export async function switchToPublicRemote(): Promise<{ updaterRemote: UpdaterRemote }> {
  const res = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ updaterRemote: 'origin' }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`)
  }
  return (await res.json()) as { updaterRemote: UpdaterRemote }
}

/** Unlock dev mode for this session. The typed email is sent to the
 *  server but only checked for non-emptiness — the real security gate
 *  is GitHub's private-repo flag, not what's typed here. The server
 *  flips both the in-memory session grant AND the persisted preference
 *  to "dev". The grant resets on server restart, so the maintainer
 *  re-enters the email each session. */
export async function unlockDevMode(email: string): Promise<{ updaterRemote: UpdaterRemote }> {
  const res = await fetch('/api/settings/dev-auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  const body = (await res.json().catch(() => ({}))) as
    | { ok?: boolean; updaterRemote?: UpdaterRemote; error?: string }
  if (!res.ok || !body.ok) {
    throw new Error(body.error ?? `HTTP ${res.status}`)
  }
  return { updaterRemote: body.updaterRemote ?? 'dev' }
}

/** Clear the session grant without changing the persisted preference.
 *  After this, the maintainer must re-enter the email to use dev. */
export async function lockDevMode(): Promise<void> {
  const res = await fetch('/api/settings/dev-auth/lock', { method: 'POST' })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`)
  }
}

export async function applyUpdate(args: { confirmRemoteHead: string }): Promise<UpdaterApplyResult> {
  let res: Response
  try {
    res = await fetch('/api/updater/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmRemoteHead: args.confirmRemoteHead }),
    })
  } catch (err) {
    // True transport failure (server down, network gone). Nothing to parse.
    throw new Error(`Network error reaching /api/updater/apply: ${(err as Error).message}`)
  }
  const body = (await res.json().catch(() => ({}))) as UpdaterApplyResult
  // The /apply endpoint returns 500 with a structured body when the update
  // script exits non-zero. We surface that body to the caller (so the UI can
  // render the captured script output) rather than throwing it away. The
  // caller checks `body.ok` to distinguish success from failure.
  if (!res.ok && !body.error && !body.output) {
    // Body wasn't the expected shape — fall back to a generic throw so the
    // caller doesn't silently treat a transport-level failure as success.
    throw new Error(`HTTP ${res.status}`)
  }
  if (!res.ok && body.ok === undefined) {
    body.ok = false
  }
  return body
}
