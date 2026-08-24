import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { BookOpen, CheckCircle2, Download, FlaskConical, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useAddons, type AddonEntry } from '@/contexts/AddonContext'
import { WhisperInstallPrecheck } from '@/components/WhisperPrereqs'
import { openHelpDoc } from '@/components/DocsViewer'

type LogEntry = { stream: 'stdout' | 'stderr'; line: string }
type AddonOp = 'installing' | 'uninstalling' | null

export function AddonsManager() {
  const { addons, loading, refresh, setEnabled } = useAddons()
  const [ops, setOps] = useState<Record<string, AddonOp>>({})
  const [logs, setLogs] = useState<Record<string, LogEntry[]>>({})
  const [pendingRestart, setPendingRestart] = useState(false)
  const [toggling, setToggling] = useState<Record<string, boolean>>({})
  // Rows whose pre-install check panel is open. The Whisper install is
  // hardware-gated (GPU strongly recommended, Python 3.10–3.12 required),
  // so Install first opens the check rather than starting a 1.5 GB
  // download on a machine where it would crawl or fail.
  const [precheckOpen, setPrecheckOpen] = useState<Record<string, boolean>>({})
  const logRefs = useRef<Record<string, HTMLPreElement | null>>({})

  useEffect(() => {
    for (const name of Object.keys(logs)) {
      const el = logRefs.current[name]
      if (el) el.scrollTop = el.scrollHeight
    }
  }, [logs])

  function setOp(name: string, op: AddonOp) {
    setOps((prev) => ({ ...prev, [name]: op }))
  }
  function appendLog(name: string, entry: LogEntry) {
    setLogs((prev) => ({ ...prev, [name]: [...(prev[name] ?? []), entry] }))
  }
  function clearLog(name: string) {
    setLogs((prev) => ({ ...prev, [name]: [] }))
  }

  async function install(addon: AddonEntry) {
    setOp(addon.name, 'installing')
    clearLog(addon.name)
    try {
      const res = await fetch(`/api/addons/${addon.name}/install`, { method: 'POST' })
      if (!res.body) throw new Error('No response body')
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split('\n\n')
        buffer = parts.pop() ?? ''
        for (const block of parts) {
          const eventMatch = block.match(/^event: (\w+)/)
          const dataMatch = block.match(/^data: (.+)$/m)
          if (!eventMatch || !dataMatch) continue
          const event = eventMatch[1]
          const data = JSON.parse(dataMatch[1]) as Record<string, unknown>
          if (event === 'line') {
            appendLog(addon.name, data as LogEntry)
          } else if (event === 'done') {
            const exitCode = (data as { exitCode: number }).exitCode
            if (exitCode === 0) {
              toast.success(`${addon.displayName} installed. Restart Tusk's Tomes to activate it.`)
              setPendingRestart(true)
            } else {
              toast.error(`${addon.displayName} installation failed — see the log above.`)
            }
          } else if (event === 'error') {
            toast.error(`Install error: ${data.error as string}`)
          }
        }
      }
    } catch (err) {
      toast.error(`Install error: ${(err as Error).message}`)
    } finally {
      setOp(addon.name, null)
      void refresh()
    }
  }

  async function toggle(addon: AddonEntry, next: boolean) {
    setToggling((prev) => ({ ...prev, [addon.name]: true }))
    try {
      await setEnabled(addon.name, next)
      toast.success(
        `${addon.displayName} ${next ? 'enabled' : 'disabled'}. Restart Tusk's Tomes for it to take effect.`,
      )
      setPendingRestart(true)
    } catch (err) {
      toast.error(`Toggle failed: ${(err as Error).message}`)
    } finally {
      setToggling((prev) => ({ ...prev, [addon.name]: false }))
    }
  }

  async function uninstall(addon: AddonEntry) {
    setOp(addon.name, 'uninstalling')
    try {
      const res = await fetch(`/api/addons/${addon.name}`, { method: 'DELETE' })
      if (!res.ok) {
        const body = (await res.json()) as { error?: string }
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      toast.success(`${addon.displayName} uninstalled. Restart Tusk's Tomes to finish.`)
      setPendingRestart(true)
      clearLog(addon.name)
    } catch (err) {
      toast.error(`Uninstall failed: ${(err as Error).message}`)
    } finally {
      setOp(addon.name, null)
      void refresh()
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add-ons</CardTitle>
        <CardDescription>
          Features that put real bytes on disk live here. Everything else —
          personas, local runners, the CLI bridges, the Obsidian lore source —
          is part of the app and configured from its own panel.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {pendingRestart && (
          <div className="flex items-center justify-between rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm">
            <span>Restart Tusk's Tomes for changes to take effect.</span>
            <Button variant="ghost" size="sm" onClick={() => setPendingRestart(false)}>
              Dismiss
            </Button>
          </div>
        )}

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading add-ons…</p>
        ) : addons.length === 0 ? (
          <p className="text-sm text-muted-foreground">No add-ons registered.</p>
        ) : (
          addons.map((addon) => {
            const op = ops[addon.name] ?? null
            const addonLogs = logs[addon.name] ?? []
            const isToggling = toggling[addon.name] ?? false
            // Three states the user cares about:
            //   "Not installed" — prerequisites missing
            //   "Disabled"      — installed but user toggled it off
            //   "Enabled"       — installed AND toggled on
            // "Restart required" pill fires when the loaded state diverges
            // from the intended state (enabled && configEnabled). Covers
            // both "just installed", "just uninstalled", and "just toggled".
            const intendedLive = addon.enabled && addon.configEnabled
            const restartNeeded = addon.loaded !== intendedLive
            const statusLabel = !addon.enabled
              ? 'Not installed'
              : addon.configEnabled
              ? 'Enabled'
              : 'Disabled'
            const statusClass = !addon.enabled
              ? 'bg-muted text-muted-foreground'
              : addon.configEnabled
              ? 'bg-green-500/15 text-green-700 dark:text-green-400'
              : 'bg-muted text-muted-foreground'
            return (
              <div
                key={addon.name}
                className="space-y-2 rounded-md border border-border p-4"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2 font-medium text-sm">
                      {intendedLive ? (
                        <CheckCircle2 className="h-4 w-4 text-green-500" />
                      ) : (
                        <Download className="h-4 w-4 text-muted-foreground" />
                      )}
                      {addon.displayName}
                      <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${statusClass}`}>
                        {statusLabel}
                      </span>
                      {restartNeeded && (
                        <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                          Restart required to {intendedLive ? 'activate' : 'deactivate'}
                        </span>
                      )}
                      {addon.wip && (
                        <span className="flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                          <FlaskConical className="h-3 w-3" />
                          Work in progress
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">{addon.description}</p>
                    {addon.docSlug && (
                      <button
                        type="button"
                        onClick={() => openHelpDoc(addon.docSlug!)}
                        className="inline-flex items-center gap-1 text-xs text-primary underline-offset-2 hover:underline"
                      >
                        <BookOpen className="h-3 w-3" />
                        Read docs
                      </button>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {addon.enabled && (
                      // Native checkbox styled as a switch. The role="switch"
                      // hint plus keyboard-toggleable input gives accessible
                      // semantics without pulling in a new component lib.
                      <label
                        className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground"
                        title="Enable or disable this add-on without uninstalling"
                      >
                        <input
                          type="checkbox"
                          role="switch"
                          checked={addon.configEnabled}
                          disabled={isToggling || op !== null}
                          onChange={(e) => void toggle(addon, e.target.checked)}
                          className="h-4 w-7 cursor-pointer appearance-none rounded-full bg-muted transition-colors checked:bg-green-500/70 disabled:opacity-50"
                        />
                        {addon.configEnabled ? 'On' : 'Off'}
                      </label>
                    )}
                    {addon.enabled ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={op !== null || isToggling}
                        onClick={() => void uninstall(addon)}
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        {op === 'uninstalling' ? 'Removing…' : 'Uninstall'}
                      </Button>
                    ) : (
                      <Button
                        variant="default"
                        size="sm"
                        disabled={op !== null}
                        onClick={() => {
                          if (addon.name === 'audio-addon' && !precheckOpen[addon.name]) {
                            setPrecheckOpen((prev) => ({ ...prev, [addon.name]: true }))
                            return
                          }
                          void install(addon)
                        }}
                      >
                        <Download className="mr-2 h-4 w-4" />
                        {op === 'installing' ? 'Installing…' : 'Install'}
                      </Button>
                    )}
                  </div>
                </div>

                {precheckOpen[addon.name] && !addon.enabled && (
                  <WhisperInstallPrecheck
                    installing={op === 'installing'}
                    onProceed={() => void install(addon)}
                    onCancel={() =>
                      setPrecheckOpen((prev) => ({ ...prev, [addon.name]: false }))
                    }
                  />
                )}

                {addonLogs.length > 0 && (
                  // Logs are wrapped in <details> so a long install (e.g.
                  // Whisper + torch wheels can stream thousands of lines)
                  // doesn't push the next add-on out of view. Auto-open
                  // while the install is running so users see live progress;
                  // collapse once it's done so the row stays compact.
                  <details open={op !== null} className="rounded-md border border-border bg-muted/40">
                    <summary className="cursor-pointer px-2 py-1 text-xs text-muted-foreground hover:text-foreground">
                      Install log ({addonLogs.length} line{addonLogs.length === 1 ? '' : 's'})
                    </summary>
                    <pre
                      ref={(el) => { logRefs.current[addon.name] = el }}
                      className="max-h-48 overflow-y-auto border-t border-border bg-muted/40 p-2 text-xs leading-relaxed"
                    >
                      {addonLogs.map((entry, i) => (
                        <span
                          key={i}
                          className={entry.stream === 'stderr' ? 'text-amber-600 dark:text-amber-400' : ''}
                        >
                          {entry.line}{'\n'}
                        </span>
                      ))}
                    </pre>
                  </details>
                )}
              </div>
            )
          })
        )}
      </CardContent>
    </Card>
  )
}
