// Self-updater card for the Settings tab. Three states drive the UI:
//
//   1. blocked       — installedViaGit is false, branch isn't main, or
//                      working tree is dirty. Apply button hidden;
//                      explanatory text shown.
//   2. up to date    — local HEAD === origin/main. Just a green "you're
//                      on the latest" indicator + Check for updates.
//   3. update ready  — pending commits > 0. Lists the incoming commits
//                      (sha, subject, author) and exposes the Apply
//                      button.
//
// Apply blocks while the platform script runs (~10-60s for a typical
// pull + npm install). Output is captured and shown after for
// transparency / debugging.

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Download,
  GitBranch,
  Loader2,
  PackageOpen,
  Power,
  RefreshCw,
  Terminal,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  applyUpdate,
  checkForUpdates,
  getUpdaterStatus,
  lockDevMode,
  switchToPublicRemote,
  unlockDevMode,
  type UpdaterStatus,
  type UpdaterCommit,
} from '@/lib/updater'

function formatRelative(iso: string | undefined): string {
  if (!iso) return 'never'
  const then = new Date(iso).getTime()
  const now = Date.now()
  const seconds = Math.max(0, Math.round((now - then) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return `${days}d ago`
}

interface UpdaterCardProps {
  /** True once the user has 5-tapped the coat-of-arms logo. Reveals the
   *  origin/dev remote toggle. The amber "currently on dev" recovery
   *  banner stays visible regardless — anyone who somehow flipped the
   *  setting needs a way back without re-unlocking the toggle. */
  devModeUnlocked?: boolean
}

export function UpdaterCard({ devModeUnlocked = false }: UpdaterCardProps = {}) {
  const [status, setStatus] = useState<UpdaterStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [checking, setChecking] = useState(false)
  const [applying, setApplying] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [applyOutput, setApplyOutput] = useState<string | null>(null)
  const [showOutput, setShowOutput] = useState(false)
  // Sticky flag set when the most recent apply pulled dependency changes.
  // Cleared once the user restarts the dev server (server boots with fresh
  // node_modules → status.nodeModulesStale flips off → we drop the banner).
  const [depsChanged, setDepsChanged] = useState(false)
  // Dev-mode email-prompt state. The typed value is held in component
  // state for as long as the prompt is open, then immediately discarded
  // after the POST — never persisted, never logged.
  const [devEmailInput, setDevEmailInput] = useState('')
  const [devPromptOpen, setDevPromptOpen] = useState(false)

  async function onConfirmDevAuth() {
    if (!devEmailInput.trim()) {
      toast.error('Enter your maintainer email to unlock dev mode.')
      return
    }
    setSwitching(true)
    setError(null)
    try {
      await unlockDevMode(devEmailInput.trim())
      setDevEmailInput('') // clear immediately; never keep around
      setDevPromptOpen(false)
      await refresh()
      toast.success('Dev mode unlocked for this session.')
    } catch (err) {
      setError((err as Error).message)
      toast.error(`Couldn't unlock dev mode: ${(err as Error).message}`)
    } finally {
      setSwitching(false)
    }
  }

  async function onSwitchToPublic() {
    setSwitching(true)
    setError(null)
    try {
      await switchToPublicRemote()
      setDevEmailInput('')
      setDevPromptOpen(false)
      await refresh()
      toast.success('Updater now pulling from "origin".')
    } catch (err) {
      setError((err as Error).message)
      toast.error(`Couldn't switch remote: ${(err as Error).message}`)
    } finally {
      setSwitching(false)
    }
  }

  async function onLockDevMode() {
    setSwitching(true)
    try {
      await lockDevMode()
      await refresh()
      toast.message('Dev mode locked — re-enter email to use it again.')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSwitching(false)
    }
  }

  async function refresh() {
    setLoading(true)
    setError(null)
    try {
      setStatus(await getUpdaterStatus())
    } catch (err) {
      setError((err as Error).message)
      setStatus(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  async function onCheck() {
    setChecking(true)
    setError(null)
    try {
      const result = await checkForUpdates()
      setStatus(result)
      if (!result.fetchOk) {
        toast.error(`Fetch failed: ${result.fetchError ?? 'unknown error'}`)
      } else if (result.pendingCommits.length === 0) {
        toast.success('Already up to date.')
      } else {
        toast.message(
          `${result.pendingCommits.length} update${result.pendingCommits.length === 1 ? '' : 's'} available.`
        )
      }
    } catch (err) {
      setError((err as Error).message)
      toast.error(`Check failed: ${(err as Error).message}`)
    } finally {
      setChecking(false)
    }
  }

  async function onApply() {
    if (!status) return
    const count = status.pendingCommits.length
    // The server requires the FULL 40-char sha. The shortSha is for
    // display only — confirm dialog shows it because the full hash is
    // unwieldy to read.
    const fullSha = status.remoteHead?.sha
    const displaySha = status.remoteHead?.shortSha ?? fullSha
    if (!fullSha) {
      toast.error('Updater status missing remote HEAD — refresh and try again.')
      return
    }
    const confirmed = window.confirm(
      `Apply ${count} update${count === 1 ? '' : 's'}, advancing to ${displaySha}? ` +
        `This runs git pull + npm install on disk. ` +
        `You'll need to restart the dev server afterwards to load the new code.`
    )
    if (!confirmed) return
    setApplying(true)
    setError(null)
    setApplyOutput(null)
    setDepsChanged(false)
    try {
      // Pass the full sha we showed the user — server requires 40 hex
      // chars and rejects with 412 if the remote moved between status()
      // and apply(). The user re-checks and reapproves the new sha.
      const result = await applyUpdate({ confirmRemoteHead: fullSha })
      if (result.status) setStatus(result.status)
      // Always surface the captured script output, even on failure — the
      // script error message lives in there. Auto-expand on failure so the
      // user sees the real reason without having to click "Script output".
      setApplyOutput(result.output ?? null)
      if (result.ok === false) {
        setError(result.error ?? 'Update script failed.')
        setShowOutput(true)
        toast.error(`Apply failed: ${result.error ?? 'see output below'}`)
      } else if (result.alreadyUpToDate) {
        setShowOutput(false)
        toast.message(result.message ?? 'Already up to date.')
      } else if (result.applied) {
        setShowOutput(false)
        setDepsChanged(result.depsChanged === true)
        if (result.depsChanged) {
          toast.warning(result.message ?? 'Update applied — dependencies changed, manual npm install required.')
        } else {
          toast.success(result.message ?? 'Update applied — restart the dev server to load it.')
        }
      } else {
        setShowOutput(false)
        toast.warning(result.message ?? 'Update script finished but HEAD did not move.')
      }
    } catch (err) {
      // Transport-level failure (server down, network gone). No script
      // output to surface.
      setError((err as Error).message)
      toast.error(`Apply failed: ${(err as Error).message}`)
    } finally {
      setApplying(false)
    }
  }

  /** Recognise common script-output patterns and surface a copy-pasteable
   *  fix above the raw output. Keeps the user from having to read the full
   *  log to figure out what to do next. */
  function classifyOutput(output: string): { hint: string; fix: string } | null {
    const t = output.toLowerCase()
    if (t.includes('running scripts is disabled') || t.includes('executionpolicy')) {
      return {
        hint: 'PowerShell ExecutionPolicy is blocking npm.ps1.',
        fix: 'Run once in PowerShell: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned    (or manually: cmd /c "git pull --ff-only origin main && npm install --no-audit --no-fund")',
      }
    }
    if (t.includes('eacces') || t.includes('permission denied')) {
      return {
        hint: 'A file in node_modules is owned by the wrong user.',
        fix: 'POSIX: sudo chown -R $USER:$(id -gn) node_modules     Windows: close VS Code, pause OneDrive, then retry.',
      }
    }
    if (t.includes('eperm') || t.includes('ebusy')) {
      return {
        hint: 'A file in node_modules is locked by another process.',
        fix: 'Close VS Code and any other editors, pause OneDrive sync, temporarily disable real-time antivirus scanning, then retry.',
      }
    }
    if (t.includes('non-fast-forward') || t.includes('would be overwritten')) {
      return {
        hint: 'Your local main has diverged from origin/main.',
        fix: 'Manually: git status, git stash, git pull --ff-only origin main, git stash pop. Or commit your local changes first.',
      }
    }
    return null
  }

  /** Last 3 non-empty lines of output — used as an inline preview so the
   *  error is visible without expanding the full log. */
  function outputTail(output: string, n = 3): string {
    return output
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0)
      .slice(-n)
      .join('\n')
  }

  /** Best-guess platform from the browser. Used to pick the right copy
   *  string for the npm install command. */
  function isWindowsUA(): boolean {
    if (typeof navigator === 'undefined') return false
    return /Windows|Win32|Win64/i.test(navigator.userAgent)
  }

  const NPM_INSTALL_POSIX = 'npm install --no-audit --no-fund'
  const NPM_INSTALL_WIN = 'cmd /c npm install --no-audit --no-fund'

  async function copyCmd(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      toast.success('Copied.')
    } catch {
      toast.error('Copy failed — select and copy manually.')
    }
  }

  const pending = status?.pendingCommits.length ?? 0
  const isBlocked = !!status?.blockedReason
  const canApply = status?.installedViaGit && !isBlocked && pending > 0 && !applying

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Download className="h-5 w-5 text-violet-400" />
            Updates
          </CardTitle>
          <CardDescription>
            Pull the latest <code>main</code> from GitHub. Runs git pull on
            your disk and refuses to clobber uncommitted local edits.{' '}
            <code>npm install</code> only runs when the pulled commits
            actually touch <code>package.json</code> or{' '}
            <code>package-lock.json</code> — most updates skip it and
            complete in a second or two.
          </CardDescription>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onCheck}
          disabled={loading || checking || applying}
        >
          {checking ? (
            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-1 h-4 w-4" />
          )}
          {checking ? 'Checking…' : 'Check for updates'}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {/* Persistent staleness banner — set by the server when
            node_modules/.package-lock.json is older than package-lock.json.
            Survives across restarts of the in-app updater UI; clears
            automatically the next time the server boots with fresh deps. */}
        {status?.nodeModulesStale && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-xs space-y-2">
            <div className="flex items-start gap-2 font-medium text-destructive">
              <PackageOpen className="mt-0.5 h-4 w-4 shrink-0" />
              <span>node_modules is out of date with package-lock.json</span>
            </div>
            <p className="text-muted-foreground">
              A previous update pulled new dependency versions but{' '}
              <code>npm install</code> hasn't run since. The app may fail to
              import new packages. Stop this dev server, run the command
              below, then restart.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded-sm bg-background px-2 py-1 font-mono text-[11px]">
                {isWindowsUA() ? NPM_INSTALL_WIN : NPM_INSTALL_POSIX}
              </code>
              <Button
                variant="outline"
                size="sm"
                onClick={() => copyCmd(isWindowsUA() ? NPM_INSTALL_WIN : NPM_INSTALL_POSIX)}
              >
                <Copy className="mr-1 h-3.5 w-3.5" />
                Copy
              </Button>
            </div>
          </div>
        )}

        {/* Just-applied banner — fires immediately after a successful
            apply whose pulled commits touched package.json/lock. The
            staleness banner above shows the same command persistently
            on subsequent visits, but this gives an in-the-moment cue
            with the actual commit SHA the user just pulled. */}
        {depsChanged && (
          <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-xs space-y-2">
            <div className="flex items-start gap-2 font-medium text-amber-200">
              <PackageOpen className="mt-0.5 h-4 w-4 shrink-0" />
              <span>Update pulled — dependencies changed, manual install required</span>
            </div>
            <p className="text-muted-foreground">
              The in-app updater doesn't run <code>npm install</code> for you
              when deps change because the running dev server holds file
              handles in <code>node_modules</code>. Stop this dev server, run
              the command below, then restart.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded-sm bg-background px-2 py-1 font-mono text-[11px]">
                {isWindowsUA() ? NPM_INSTALL_WIN : NPM_INSTALL_POSIX}
              </code>
              <Button
                variant="outline"
                size="sm"
                onClick={() => copyCmd(isWindowsUA() ? NPM_INSTALL_WIN : NPM_INSTALL_POSIX)}
              >
                <Copy className="mr-1 h-3.5 w-3.5" />
                Copy
              </Button>
            </div>
          </div>
        )}

        {/* Dev-mode active banner — visible whenever the updater is
            pointed at the dev remote, regardless of unlock state. This
            is the recovery path: anyone who flipped the toggle (with or
            without 5-tap) needs a way back to the public remote. */}
        {/* Dev-mode session prompt — appears whenever the persisted
            preference is "dev" but the in-memory grant is missing
            (server boot, explicit lock, or new tab). The typed email
            is held in state only for the duration of the modal and
            cleared the moment the POST completes. Real security stays
            at GitHub's private-repo flag; this prompt is intentional-
            action friction so the toggle isn't a one-tap mistake. */}
        {status?.devAuthRequired && (
          <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-xs space-y-2">
            <div className="flex items-start gap-2 font-medium text-amber-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Dev mode locked — enter maintainer email to use{' '}
                <code className="font-mono not-italic">Tusks-Tomes-Dev</code> this session
              </span>
            </div>
            <p className="text-muted-foreground">
              The email is not stored. Your real security comes from your
              cached GitHub credentials — without them, the dev repo 404s
              regardless of what you type here.
            </p>
            {devPromptOpen ? (
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="email"
                  autoComplete="off"
                  placeholder="maintainer@email"
                  value={devEmailInput}
                  onChange={(e) => setDevEmailInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void onConfirmDevAuth()
                    if (e.key === 'Escape') {
                      setDevPromptOpen(false)
                      setDevEmailInput('')
                    }
                  }}
                  className="flex-1 min-w-[200px] rounded-sm border border-amber-500/30 bg-background px-2 py-1 font-mono text-[11px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-amber-500/60"
                  autoFocus
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void onConfirmDevAuth()}
                  disabled={switching || !devEmailInput.trim()}
                >
                  {switching ? (
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
                  )}
                  Unlock
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setDevPromptOpen(false)
                    setDevEmailInput('')
                  }}
                  disabled={switching}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setDevPromptOpen(true)}
                  disabled={switching}
                >
                  <GitBranch className="mr-1 h-3.5 w-3.5" />
                  Enter email to unlock
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void onSwitchToPublic()}
                  disabled={switching}
                >
                  <Power className="mr-1 h-3.5 w-3.5" />
                  Cancel dev preference (return to public)
                </Button>
              </div>
            )}
          </div>
        )}

        {/* Active-dev banner — shown when the session grant is active
            and git is actually fetching from dev. Always offers the
            return-to-public escape hatch + a session lock button. */}
        {status?.remoteName === 'dev' && !status?.devAuthRequired && (
          <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-xs space-y-2">
            <div className="flex items-start gap-2 font-medium text-amber-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Developer mode active — updater is pulling from{' '}
                <code className="font-mono not-italic">Tusks-Tomes-Dev</code>
              </span>
            </div>
            <p className="text-muted-foreground">
              The pull source is the private preview remote. End users
              without dev-repo credentials see a 404 from git — no dev
              code can leak. Restart the server or click Lock below to
              require email re-entry.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void onSwitchToPublic()}
                disabled={switching}
              >
                {switching ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Power className="mr-1 h-3.5 w-3.5" />
                )}
                Switch back to public (origin)
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void onLockDevMode()}
                disabled={switching}
              >
                <Terminal className="mr-1 h-3.5 w-3.5" />
                Lock dev mode (session only)
              </Button>
            </div>
          </div>
        )}

        {/* Hidden 5-tap toggle — only appears after the coat-of-arms is
            tapped 5x. From the public/origin side, lets the maintainer
            flip the persisted preference to "dev" (which then surfaces
            the email prompt above for the actual unlock). */}
        {devModeUnlocked && status?.remoteName === 'origin' && !status?.devAuthRequired && (
          <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-xs space-y-2">
            <div className="flex items-start gap-2 font-medium text-emerald-200">
              <Terminal className="mt-0.5 h-4 w-4 shrink-0" />
              <span>Developer mode unlocked (UI)</span>
            </div>
            <p className="text-muted-foreground">
              You're currently on the public remote.{' '}
              <code className="font-mono not-italic">dev</code> requires
              maintainer email entry each session — the typed value is
              never stored. Real security is your cached GitHub credentials.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDevPromptOpen(true)}
              disabled={switching}
            >
              <GitBranch className="mr-1 h-3.5 w-3.5" />
              Switch to dev (Tusks-Tomes-Dev)
            </Button>
            {devPromptOpen && (
              <div className="flex flex-wrap items-center gap-2 pt-2">
                <input
                  type="email"
                  autoComplete="off"
                  placeholder="maintainer@email"
                  value={devEmailInput}
                  onChange={(e) => setDevEmailInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void onConfirmDevAuth()
                    if (e.key === 'Escape') {
                      setDevPromptOpen(false)
                      setDevEmailInput('')
                    }
                  }}
                  className="flex-1 min-w-[200px] rounded-sm border border-emerald-500/30 bg-background px-2 py-1 font-mono text-[11px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-emerald-500/60"
                  autoFocus
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void onConfirmDevAuth()}
                  disabled={switching || !devEmailInput.trim()}
                >
                  {switching ? (
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
                  )}
                  Unlock dev mode
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setDevPromptOpen(false)
                    setDevEmailInput('')
                  }}
                  disabled={switching}
                >
                  Cancel
                </Button>
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
            {error}
          </div>
        )}
        {loading && !status && (
          <p className="text-xs text-muted-foreground">Reading current install status…</p>
        )}

        {status && (
          <>
            {/* Identity row — branch, commit, last fetch */}
            <div className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
              <span className="font-medium text-muted-foreground flex items-center gap-1.5">
                <GitBranch className="h-3.5 w-3.5" />
                Branch
              </span>
              <span>
                {status.branch ?? <em>(detached)</em>}
                {!status.installedViaGit && (
                  <em className="ml-2 text-muted-foreground">ZIP install — updater disabled</em>
                )}
              </span>
              {status.head && (
                <>
                  <span className="font-medium text-muted-foreground">Current</span>
                  <span className="break-all">
                    <code>{status.head.shortSha}</code> — {status.head.subject}
                  </span>
                </>
              )}
              {status.remoteHead && (
                <>
                  <span className="font-medium text-muted-foreground">origin/main</span>
                  <span className="break-all">
                    <code>{status.remoteHead.shortSha}</code> — {status.remoteHead.subject}
                  </span>
                </>
              )}
              <span className="font-medium text-muted-foreground">Last fetch</span>
              <span>{formatRelative(status.lastFetchAt)}</span>
            </div>

            {/* Blocked state */}
            {isBlocked && (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <div className="space-y-1">
                  <p className="font-medium text-amber-700 dark:text-amber-300">
                    Update blocked
                  </p>
                  <p className="text-muted-foreground">{status.blockedReason}</p>
                  {status.dirtyFiles && status.dirtyFiles.length > 0 && (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                        {status.dirtyFiles.length} dirty file{status.dirtyFiles.length === 1 ? '' : 's'}
                      </summary>
                      <ul className="ml-4 mt-1 list-disc font-mono text-[11px]">
                        {status.dirtyFiles.map((f) => (
                          <li key={f}>{f}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              </div>
            )}

            {/* Up-to-date state */}
            {!isBlocked && pending === 0 && status.installedViaGit && (
              <div className="flex items-center gap-2 rounded-md border border-green-500/40 bg-green-500/5 p-3 text-xs text-green-700 dark:text-green-300">
                <CheckCircle2 className="h-4 w-4" />
                <span className="font-medium">You're on the latest version.</span>
              </div>
            )}

            {/* Updates available state */}
            {!isBlocked && pending > 0 && (
              <div className="space-y-2 rounded-md border border-violet-500/40 bg-violet-500/5 p-3 text-xs">
                <p className="text-sm font-medium text-violet-700 dark:text-violet-300">
                  {pending} update{pending === 1 ? '' : 's'} available
                </p>
                <ul className="max-h-48 space-y-1 overflow-y-auto">
                  {status.pendingCommits.map((c: UpdaterCommit) => (
                    <li key={c.sha} className="flex items-start gap-2">
                      <code className="shrink-0 text-muted-foreground">{c.shortSha}</code>
                      <span className="flex-1">{c.subject}</span>
                      <span className="hidden text-[10px] text-muted-foreground sm:inline">
                        {c.author}
                      </span>
                    </li>
                  ))}
                </ul>
                <Button
                  variant="default"
                  size="sm"
                  onClick={onApply}
                  disabled={!canApply}
                  data-slot="primary-cta"
                >
                  {applying ? (
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  ) : (
                    <Download className="mr-1 h-4 w-4" />
                  )}
                  {applying ? 'Applying…' : 'Apply update'}
                </Button>
              </div>
            )}

            {/* Ahead-of-remote warning (rare — only when user has hand-edited commits) */}
            {status.aheadCommits.length > 0 && (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-muted-foreground">
                You have {status.aheadCommits.length} unpushed local commit
                {status.aheadCommits.length === 1 ? '' : 's'} on main — the updater
                won't touch them, but pulling will refuse if upstream has
                diverged.
              </div>
            )}

            {/* Inline classification — surfaces the most likely fix above
                the full log so users don't have to read the raw output. */}
            {applyOutput && error && (() => {
              const c = classifyOutput(applyOutput)
              if (!c) return null
              return (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs space-y-1.5">
                  <p className="font-medium text-amber-200">Likely cause: {c.hint}</p>
                  <p className="font-mono text-[11px] text-muted-foreground whitespace-pre-wrap break-words">
                    {c.fix}
                  </p>
                </div>
              )
            })()}

            {/* Quick tail preview — last few lines of output, always visible
                on failure so the user sees the real error without expanding. */}
            {applyOutput && error && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs">
                <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                  Last lines of script output
                </p>
                <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-destructive">
                  {outputTail(applyOutput)}
                </pre>
              </div>
            )}

            {/* Full script output, collapsible. Auto-expands on failure
                (showOutput is set to true by onApply's error branch). */}
            {applyOutput && (
              <details
                open={showOutput}
                onToggle={(e) => setShowOutput((e.target as HTMLDetailsElement).open)}
                className="rounded-md border border-border bg-card/40 p-2 text-xs"
              >
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground flex items-center gap-1.5">
                  <Terminal className="h-3.5 w-3.5" />
                  Full script output
                </summary>
                <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-muted-foreground">
                  {applyOutput}
                </pre>
              </details>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
