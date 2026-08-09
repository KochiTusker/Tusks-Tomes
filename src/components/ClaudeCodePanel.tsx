// Claude Code subscription panel. Shows whether the user's local `claude`
// CLI is installed and (best-effort) logged in, and how to fix it if not.
//
// Model selection and per-phase routing happen in the Active Provider +
// Model Profiles cards like any other provider — this panel is only the
// connection-status + "bring your own subscription" guidance surface, mirror
// of LocalLLMPanel's role for local runners.

import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, RefreshCw, ShieldAlert, Terminal, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { getClaudeFailsafeEnabled, setClaudeFailsafeEnabled } from '@/lib/claudeFailsafe'
import { geminiAvailableForRestore } from '@/lib/restorePass'

type ClaudeCodeStatus = {
  installed: boolean
  version: string | null
  authenticated: boolean
  models: string[]
}

function StatusBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs ${
        ok
          ? 'bg-green-500/15 text-green-600 dark:text-green-400'
          : 'bg-muted text-muted-foreground'
      }`}
    >
      {ok ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
      {label}
    </span>
  )
}

export function ClaudeCodePanel() {
  const [status, setStatus] = useState<ClaudeCodeStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [failsafeOn, setFailsafeOn] = useState(false)
  const [geminiOk, setGeminiOk] = useState(false)
  useEffect(() => {
    setFailsafeOn(getClaudeFailsafeEnabled())
    setGeminiOk(geminiAvailableForRestore())
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/claude-code/status')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setStatus((await res.json()) as ClaudeCodeStatus)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Terminal className="h-4 w-4" />
              Claude Code (your subscription)
            </CardTitle>
            <CardDescription>
              Uses your own locally-installed Claude Code subscription as the LLM — no API key.
              Select it as the active provider (or per-phase) once it shows connected below.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span className="ml-1">Recheck</span>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {error && (
          <p className="text-destructive">Couldn't read CLI status: {error}</p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge
            ok={!!status?.installed}
            label={status?.installed ? `CLI installed${status.version ? ` (${status.version})` : ''}` : 'CLI not found'}
          />
          <StatusBadge
            ok={!!status?.authenticated}
            label={status?.authenticated ? 'Logged in' : 'Login not detected'}
          />
        </div>

        {!status?.installed && (
          <div className="rounded-md border border-border bg-muted/40 p-3">
            <p className="font-medium">Install Claude Code, then log in</p>
            <ol className="ml-4 mt-1 list-decimal space-y-1 text-muted-foreground">
              <li>
                Install it from{' '}
                <a
                  className="underline"
                  href="https://docs.claude.com/en/docs/claude-code"
                  target="_blank"
                  rel="noreferrer"
                >
                  docs.claude.com/en/docs/claude-code
                </a>
                .
              </li>
              <li>
                Run <code className="rounded bg-background px-1">claude login</code> and pick your Pro/Max plan.
              </li>
              <li>Click Recheck.</li>
            </ol>
          </div>
        )}

        {status?.installed && !status.authenticated && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-amber-700 dark:text-amber-300">
            Couldn't confirm a logged-in session. Run{' '}
            <code className="rounded bg-background px-1">claude login</code> with your Pro/Max plan,
            then Recheck. (On macOS the login may live in the Keychain and not be detectable here —
            if runs work, you can ignore this.)
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          Heads up: if <code className="rounded bg-muted px-1">ANTHROPIC_API_KEY</code> is set in
          your environment it would override your subscription and bill the API. Tusk's Tomes
          strips it from the CLI call, but it's cleanest to leave it unset. Each user brings their
          own subscription — this app never handles login.
        </p>

        {/* Explicit-content failsafe — off by default. */}
        <div className="rounded-md border border-border p-3">
          <label className="flex cursor-pointer items-start gap-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={failsafeOn}
              onChange={(e) => {
                setFailsafeOn(e.target.checked)
                setClaudeFailsafeEnabled(e.target.checked)
              }}
            />
            <span className="text-sm">
              <span className="flex items-center gap-1 font-medium">
                <ShieldAlert className="h-3.5 w-3.5" />
                Explicit-content failsafe (uses Gemini)
              </span>
              <span className="text-muted-foreground">
                If Claude Code refuses or blanks a chunk, redo it on Gemini (permissive) mid-run;
                and after a run where a refusal was detected, offer a Gemini pass that reconciles
                the chronicle against the raw transcript to restore softened/omitted gore,
                profanity, and sexual references. Off by default — ideally never needed.
              </span>
              {failsafeOn && !geminiOk && (
                <span className="mt-1 block text-amber-700 dark:text-amber-300">
                  ⚠ No Gemini key configured — add one in Settings → API Keys for this failsafe to
                  work.
                </span>
              )}
            </span>
          </label>
        </div>
      </CardContent>
    </Card>
  )
}
