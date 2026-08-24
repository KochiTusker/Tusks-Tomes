// Diagnostics panel — surfaces the opt-in verbose event/error logger plus
// quick-reference instructions for the DevTools `window.__tusk` handle.
// Lives in Settings so users discover it when they need to debug, without
// being noisy by default.
//
// Three independent output channels (each gated by its own checkbox):
//   1. Verbose console logging — browser DevTools `console.log` stream.
//   2. Forward to dev-server terminal — POSTs entries to /api/diagnostics/log;
//      the server prints them pretty (with ANSI colors) to stdout.
//   3. Also write to diagnostics.log — server appends JSON Lines to disk.
// All three independent. Ring buffer fills regardless so `dumpRecentEvents()`
// always works post-hoc.

import { useEffect, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Bug, Copy, Eraser, FileText, Server as ServerIcon, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import {
  clearLog,
  dumpRecentEvents,
  recentFromServer,
  useFileLogging,
  usePersistBlockedChunks,
  useTerminalForwarding,
  useVerboseFlag,
  type LogCategory,
} from '@/lib/verboseLog'
import { listRecentBundles, requestBundle, type RecentBundle } from '@/lib/diagnose'

const CATEGORIES: LogCategory[] = [
  'pipeline',
  'chunk',
  'provider',
  'gemini',
  'sessions',
  'routing',
  'refresh',
  'fallback',
  'cache',
  'resume',
]

type ServerEntry = { ts: number; source: 'browser' | 'server'; cat: string; payload: unknown }

export function DiagnosticsCard() {
  const [verbose, setVerboseFlag] = useVerboseFlag()
  const [terminal, setTerminalFlag] = useTerminalForwarding()
  const [file, setFileFlag] = useFileLogging()
  const [persistBlocked, setPersistBlockedFlag] = usePersistBlockedChunks()
  const [capturedChunks, setCapturedChunks] = useState<Array<{ filename: string; path: string; size: number; modifiedAt: string }>>([])
  const [filterCat, setFilterCat] = useState<LogCategory | 'all'>('all')
  const [serverConfig, setServerConfig] = useState<{ logFilePath?: string } | null>(null)
  const [showServerRing, setShowServerRing] = useState<ServerEntry[] | null>(null)
  const [building, setBuilding] = useState(false)
  const [recentBundles, setRecentBundles] = useState<RecentBundle[]>([])
  const [serverRingLoading, setServerRingLoading] = useState(false)

  // Fetch the server config once on mount so we can show the log file path
  // even before the user flips any toggle.
  useEffect(() => {
    let cancelled = false
    fetch('/api/diagnostics/config')
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (!cancelled && body) setServerConfig(body)
      })
      .catch(() => {/* server may not be running yet */})
    return () => { cancelled = true }
  }, [terminal, file])

  // Refresh captured blocked-chunk list whenever the toggle flips on
  // (so the panel populates without a page reload) or recentBundles
  // changes (a fresh bundle implies a fresh capture may have happened).
  useEffect(() => {
    if (!persistBlocked) {
      setCapturedChunks([])
      return
    }
    let cancelled = false
    fetch('/api/diagnose/captured-chunks')
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (!cancelled && body?.chunks) setCapturedChunks(body.chunks)
      })
      .catch(() => {/* server may not be running yet */})
    return () => { cancelled = true }
  }, [persistBlocked, recentBundles])

  async function copyRecentLog() {
    const entries = dumpRecentEvents({
      count: 500,
      cat: filterCat === 'all' ? undefined : filterCat,
    })
    if (entries.length === 0) {
      toast.message('Ring buffer is empty — nothing to copy.')
      return
    }
    const text = entries
      .map((e) => {
        const ts = new Date(e.ts).toISOString().slice(11, 23)
        return `[${ts}] [${e.cat}] ${JSON.stringify(e.payload)}`
      })
      .join('\n')
    try {
      await navigator.clipboard.writeText(text)
      toast.success(`Copied ${entries.length} log entries to clipboard.`)
    } catch (err) {
      toast.error(`Clipboard write failed: ${(err as Error).message}`)
    }
  }

  function clearAll() {
    clearLog()
    toast.message('Cleared the browser-local ring buffer.')
  }

  async function copyLogFilePath() {
    if (!serverConfig?.logFilePath) return
    try {
      await navigator.clipboard.writeText(serverConfig.logFilePath)
      toast.success('Log file path copied to clipboard.')
    } catch (err) {
      toast.error(`Clipboard write failed: ${(err as Error).message}`)
    }
  }

  async function clearLogFile() {
    if (!confirm('Clear the on-disk diagnostics.log file? Subsequent events will repopulate it (if file logging is on).')) return
    try {
      const res = await fetch('/api/diagnostics/clear-file', { method: 'POST' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      toast.success('Log file cleared.')
    } catch (err) {
      toast.error(`Failed to clear log file: ${(err as Error).message}`)
    }
  }

  async function loadServerRing() {
    setServerRingLoading(true)
    try {
      const entries = await recentFromServer({
        count: 500,
        cat: filterCat === 'all' ? 'all' : filterCat,
      })
      setShowServerRing(entries as ServerEntry[])
    } catch (err) {
      toast.error(`Failed to load server ring: ${(err as Error).message}`)
    } finally {
      setServerRingLoading(false)
    }
  }

  // Pull the list of recent bundles whenever the card mounts and any
  // time we just finished building one (success → refresh the history).
  async function refreshRecentBundles() {
    const bundles = await listRecentBundles()
    setRecentBundles(bundles)
  }
  useEffect(() => {
    void refreshRecentBundles()
  }, [])

  async function buildBundleNow() {
    setBuilding(true)
    try {
      const result = await requestBundle({ trigger: 'manual', force: true })
      if (!result.ok) {
        toast.error(`Bundle build failed: ${result.error ?? 'unknown'}`)
        return
      }
      const sigSuffix = result.signaturesMatched
        ? ` (${result.signaturesMatched} soft-error${result.signaturesMatched === 1 ? '' : 's'} matched)`
        : ''
      toast.success(
        `Bundle written to .diagnose/latest.md${sigSuffix}. Paste @.diagnose/latest.md into Claude Code.`,
        { duration: 10_000 },
      )
      void refreshRecentBundles()
    } catch (err) {
      toast.error(`Bundle build threw: ${(err as Error).message}`)
    } finally {
      setBuilding(false)
    }
  }

  async function copyBundlePath(p: string) {
    try {
      await navigator.clipboard.writeText(p)
      toast.success('Path copied — paste with @ prefix into Claude Code.')
    } catch {
      toast.error('Clipboard write failed')
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bug className="h-5 w-5" />
          Diagnostics
        </CardTitle>
        <CardDescription>
          Opt-in event + error logging for debugging. Three independent output
          channels: the browser console (F12), the dev-server terminal where
          <code className="mx-1 rounded bg-muted px-1">npm run dev</code> runs, and
          a JSON Lines log file on disk. Ring buffer (last 500 entries) fills
          regardless of toggles, so you can flip channels on AFTER a bug
          happens and still copy the recent history below.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Channel 1: browser console */}
        <div className="flex items-start gap-3">
          <input
            type="checkbox"
            id="verbose-toggle"
            checked={verbose}
            onChange={(e) => setVerboseFlag(e.target.checked)}
            className="mt-1 h-4 w-4"
          />
          <label htmlFor="verbose-toggle" className="text-sm">
            <span className="font-medium">Verbose console logging (browser)</span>
            <span className="block text-xs text-muted-foreground">
              Streams each event to F12 → Console with a category tag
              (e.g. <code className="rounded bg-muted px-1">[tusk:gemini]</code>).
              Most lightweight option — no network, no disk.
            </span>
          </label>
        </div>

        {/* Channel 2: dev-server terminal */}
        <div className="flex items-start gap-3">
          <input
            type="checkbox"
            id="terminal-toggle"
            checked={terminal}
            onChange={(e) => setTerminalFlag(e.target.checked)}
            className="mt-1 h-4 w-4"
          />
          <label htmlFor="terminal-toggle" className="text-sm">
            <span className="font-medium">Forward to dev-server terminal</span>
            <span className="block text-xs text-muted-foreground">
              Streams each event to the Node terminal where
              <code className="mx-1 rounded bg-muted px-1">npm run dev</code>
              is running. Pretty-printed with ANSI colors, one line per event.
              Best for live observation while you scroll the terminal back. Sanitized
              before send — fields named <code className="rounded bg-muted px-1">apiKey</code>,
              <code className="mx-1 rounded bg-muted px-1">userPrompt</code>, etc. become
              <code className="rounded bg-muted px-1">[REDACTED]</code> (lengths preserved as
              <code className="rounded bg-muted px-1">&lt;field&gt;_chars</code>).
            </span>
          </label>
        </div>

        {/* Channel 3: JSON Lines file */}
        <div className="flex items-start gap-3">
          <input
            type="checkbox"
            id="file-toggle"
            checked={file}
            onChange={(e) => setFileFlag(e.target.checked)}
            className="mt-1 h-4 w-4"
          />
          <label htmlFor="file-toggle" className="text-sm">
            <span className="font-medium">Also write to <code className="rounded bg-muted px-1">diagnostics.log</code></span>
            <span className="block text-xs text-muted-foreground">
              Appends each event as JSON Lines to a file in your platform config
              directory (grep / jq friendly for forensics). Survives browser reload.
              File grows until cleared via the button below.
            </span>
          </label>
        </div>

        {/* Channel 4: Persist blocked-chunk text */}
        <div className="flex items-start gap-3">
          <input
            type="checkbox"
            id="persist-blocked-chunks-toggle"
            checked={persistBlocked}
            onChange={(e) => setPersistBlockedFlag(e.target.checked)}
            className="mt-1 h-4 w-4"
          />
          <label htmlFor="persist-blocked-chunks-toggle" className="text-sm">
            <span className="font-medium">
              Persist blocked-chunk text to <code className="rounded bg-muted px-1">.diagnose/blocked-chunks/</code>
            </span>
            <span className="block text-xs text-muted-foreground">
              When Gemini's unconfigurable filter (PROHIBITED_CONTENT / BLOCKLIST / SPII) rejects a Phase 2 or Phase 4 chunk,
              capture the FULL prompt body (including your transcript text) to disk so you can inspect exactly what
              content the model classified as forbidden. <strong>Off by default</strong> — opt in only when you're
              actively investigating, since this writes user transcript content to the repo's gitignored
              <code className="rounded bg-muted px-1">.diagnose/blocked-chunks/</code> directory.
            </span>
          </label>
        </div>

        {/* Recent captured blocked chunks */}
        {persistBlocked && capturedChunks.length > 0 && (
          <div className="rounded border bg-amber-50 p-3 text-xs dark:bg-amber-950/20">
            <p className="mb-1 font-medium">Captured blocked chunks ({capturedChunks.length})</p>
            <ul className="space-y-1">
              {capturedChunks.slice(0, 5).map((c) => (
                <li key={c.filename} className="flex flex-wrap items-center gap-2">
                  <code className="rounded bg-background px-1 py-0.5 font-mono">{c.filename}</code>
                  <span className="text-muted-foreground">{(c.size / 1024).toFixed(1)} kB</span>
                  <span className="text-muted-foreground">{new Date(c.modifiedAt).toLocaleString()}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => { void navigator.clipboard.writeText(c.path).then(() => toast.success('Path copied')) }}
                  >
                    <Copy className="mr-1 h-3 w-3" />
                    Copy path
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Log file panel — shows path + clear button */}
        {serverConfig?.logFilePath && (
          <div className="rounded border bg-muted/30 p-3 text-xs">
            <p className="mb-1 font-medium">Log file</p>
            <div className="flex flex-wrap items-center gap-2">
              <code className="break-all rounded bg-background px-2 py-1 font-mono">
                {serverConfig.logFilePath}
              </code>
              <Button size="sm" variant="outline" onClick={copyLogFilePath}>
                <Copy className="mr-1 h-3 w-3" />
                Copy path
              </Button>
              <Button size="sm" variant="outline" onClick={clearLogFile}>
                <Eraser className="mr-1 h-3 w-3" />
                Clear log file
              </Button>
            </div>
            <p className="mt-2 text-muted-foreground">
              On POSIX: <code className="rounded bg-background px-1">tail -f {serverConfig.logFilePath}</code> to
              follow live, or <code className="rounded bg-background px-1">{`cat ${serverConfig.logFilePath} | jq 'select(.cat=="gemini")'`}</code> to filter.
            </p>
          </div>
        )}

        {/* Browser-ring copy + clear */}
        <div className="space-y-2">
          <p className="text-sm font-medium">Browser ring buffer</p>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={filterCat}
              onChange={(e) => setFilterCat(e.target.value as LogCategory | 'all')}
              aria-label="Filter log entries by category"
              className="rounded border bg-background px-2 py-1 text-sm"
            >
              <option value="all">All categories</option>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <Button size="sm" variant="outline" onClick={copyRecentLog}>
              <Copy className="mr-1 h-4 w-4" />
              Copy to clipboard
            </Button>
            <Button size="sm" variant="ghost" onClick={clearAll}>
              Clear buffer
            </Button>
            <Button size="sm" variant="outline" onClick={loadServerRing} disabled={serverRingLoading}>
              <ServerIcon className="mr-1 h-4 w-4" />
              {serverRingLoading ? 'Loading…' : 'Show server ring'}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Pastes well into a bug report or Claude Code session — each line
            is <code className="rounded bg-muted px-1">[HH:mm:ss.sss] [category] {'{...JSON...}'}</code>.
            The "Show server ring" button pulls the merged browser+server timeline so
            you can see what the server logged interleaved with the browser events.
          </p>
        </div>

        {/* Server ring modal-ish view (inline so it scrolls) */}
        {showServerRing && (
          <div className="rounded border bg-muted/20 p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-medium">
                Server ring snapshot ({showServerRing.length} entries)
              </p>
              <Button size="sm" variant="ghost" onClick={() => setShowServerRing(null)}>
                Close
              </Button>
            </div>
            <pre className="max-h-96 overflow-auto rounded bg-background p-2 text-xs font-mono leading-relaxed">
              {showServerRing.map((e) => {
                const ts = new Date(e.ts).toISOString().slice(11, 23)
                return `[${ts}] [${e.cat}]${e.source === 'server' ? ' (server)' : ''} ${JSON.stringify(e.payload)}\n`
              })}
            </pre>
          </div>
        )}

        {/* Diagnosis bundles — the fastest-path-to-diagnosis surface. */}
        <div className="space-y-2 rounded border border-primary/30 bg-primary/5 p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium flex items-center gap-2">
              <FileText className="h-4 w-4" />
              Diagnosis bundles for Claude Code
            </p>
            <Button size="sm" variant="default" onClick={buildBundleNow} disabled={building}>
              <Sparkles className="mr-1 h-4 w-4" />
              {building ? 'Building…' : 'Build bundle now'}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Auto-builds whenever a pipeline error fires. Writes a structured markdown
            file at <code className="rounded bg-background px-1">.diagnose/latest.md</code>{' '}
            containing current state, soft-error signatures, last 80 ring events,
            graphify slice of the throw site, probe cache snapshot, routing.json,
            and git state. Paste <code className="rounded bg-background px-1">@.diagnose/latest.md</code>{' '}
            into Claude Code for one-round-trip diagnosis.
          </p>
          {recentBundles.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium">Recent bundles ({recentBundles.length})</p>
              <ul className="space-y-1 text-xs">
                {recentBundles.slice(0, 5).map((b) => {
                  const sizeKb = (b.size / 1024).toFixed(1)
                  const age = new Date(b.modifiedAt).toLocaleString()
                  return (
                    <li key={b.path} className="flex items-center gap-2">
                      <code className="flex-1 truncate rounded bg-background px-1.5 py-0.5 font-mono text-[10px]">
                        {b.filename}
                      </code>
                      <span className="text-muted-foreground">{sizeKb} kB</span>
                      <span className="text-muted-foreground">{age}</span>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2"
                        onClick={() => copyBundlePath(b.path)}
                        aria-label={`Copy path to ${b.filename}`}
                        title={`Copy path to ${b.filename}`}
                      >
                        <Copy className="h-3 w-3" />
                      </Button>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
        </div>

        <details className="rounded border bg-muted/30 p-3">
          <summary className="cursor-pointer text-sm font-medium">
            DevTools console reference
          </summary>
          <div className="mt-2 space-y-1 text-xs">
            <p>
              Type these in the F12 console for direct access to the same
              ring buffer the panel above reads from:
            </p>
            <pre className="overflow-x-auto rounded bg-background p-2 font-mono">
{`// Browser console stream
window.__tusk.setVerbose(true)
window.__tusk.setVerbose(false)
window.__tusk.isVerbose()

// Dev-server terminal stream
window.__tusk.setTerminalForwarding(true)
window.__tusk.isTerminalForwarding()

// Disk JSON Lines log
window.__tusk.setFileLogging(true)
window.__tusk.isFileLogging()

// Read recent events
window.__tusk.dumpRecentEvents()                       // last 100 (browser-local)
window.__tusk.dumpRecentEvents({ count: 500 })
window.__tusk.dumpRecentEvents({ cat: 'gemini' })
window.__tusk.recentFromServer().then(console.table)   // merged server ring
window.__tusk.recentFromServer({ cat: 'gemini' }).then(console.table)
window.__tusk.clearLog()                                // wipe browser ring`}
            </pre>
          </div>
        </details>
      </CardContent>
    </Card>
  )
}
