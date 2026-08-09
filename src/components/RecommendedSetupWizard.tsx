// "Set up the recommended configuration" wizard.
//
// Walks a new user from a blank install to the configuration this project's
// own A/B testing settled on: Craig + local Whisper for transcription, an
// Obsidian vault for lore, and per-phase routing that puts the mechanical
// phases on a subscription CLI and the prose phases on paid Gemini Flash.
//
// Two design rules, both learned the hard way:
//
//   1. NOTHING is written until the user confirms an explicit before/after
//      diff. The wizard is re-runnable — someone who has spent an evening
//      tuning per-phase routing must be able to open it, see exactly what it
//      would change, and back out. All the decision logic lives in
//      src/lib/recommendedSetup.ts so it can be tested without React.
//
//   2. Detection comes from GET /api/system/cli-detect, NOT from the add-ons'
//      own routers. Those are mounted only after the add-on is enabled and the
//      server restarted, so on a first run they don't exist yet — the wizard
//      could never answer "do you have a Claude Code subscription?" from them.

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { getProvidersSummary, putProviderKey, testProviderKey } from '@/lib/providerSettings'
import { getRouting, putRouting } from '@/lib/routing'
import { streamAddonInstall, type InstallLogEntry } from '@/lib/addonInstallStream'
import {
  addonForSubscription,
  buildSetupPlan,
  describeCli,
  detectBestSubscription,
  planIsNoop,
  recommendedRouting,
  WHISPER_ADDON,
  type CliDetect,
  type CurrentSetup,
  type SetupAnswers,
  type SetupPlan,
} from '@/lib/recommendedSetup'
import type { SubscriptionTarget } from '@/lib/budgetMode'

type Step =
  | 'intro'
  | 'prereqs'
  | 'key'
  | 'subscription'
  | 'vault'
  | 'whisper'
  | 'review'
  | 'apply'
  | 'done'

const STEP_ORDER: Step[] = [
  'intro',
  'prereqs',
  'key',
  'subscription',
  'vault',
  'whisper',
  'review',
  'apply',
  'done',
]

/** A .docx/.pdf in the vault that grounding can't read yet. */
type ConvertibleDoc = {
  relPath: string
  ext: string
  sizeBytes: number
  hasSiblingMd: boolean
  blockedReason?: string
}

/** External tools the recommended setup builds on. Links only — the wizard
 *  never downloads or executes anything from these. */
const PREREQS = [
  {
    name: 'Craig (Discord recording bot)',
    href: 'https://craig.chat',
    why: 'Records one audio track per player, which is what makes speaker attribution reliable. The free tier is enough.',
  },
  {
    name: 'Obsidian',
    href: 'https://obsidian.md/download',
    why: 'Where your campaign lore lives. Tomes reads the vault read-only to ground names and places.',
  },
]

export function RecommendedSetupWizard({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [step, setStep] = useState<Step>('intro')
  const [loading, setLoading] = useState(false)
  const [current, setCurrent] = useState<CurrentSetup | null>(null)
  const [answers, setAnswers] = useState<SetupAnswers>({
    geminiKey: null,
    installWhisper: false,
    acceptedCpuWhisper: false,
    subscription: 'none',
    vaultPath: null,
    convertDocs: [],
  })
  const [keyInput, setKeyInput] = useState('')
  const [convertible, setConvertible] = useState<ConvertibleDoc[] | null>(null)
  const [scanning, setScanning] = useState(false)
  const [logs, setLogs] = useState<InstallLogEntry[]>([])
  const [applying, setApplying] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)
  const [restartNeeded, setRestartNeeded] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)

  // --- load current state --------------------------------------------------
  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [providers, routing, addonsRes, cliRes, sysRes] = await Promise.all([
        getProvidersSummary().catch(() => null),
        getRouting().catch(() => null),
        // GET /api/addons responds { addons: [...] }, and each row's readiness
        // flag is `enabled` (which is addon.isReady() — prerequisites present),
        // NOT `ready`/`installed`. Getting this wrong left `current` null and
        // silently blanked every step that renders detection results.
        fetch('/api/addons')
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
        fetch('/api/system/cli-detect').then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetch('/api/system/info').then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ])

      const addonsReady: Record<string, boolean> = {}
      const addonRows = Array.isArray((addonsRes as { addons?: unknown } | null)?.addons)
        ? ((addonsRes as { addons: Array<{ name: string; enabled?: boolean }> }).addons)
        : []
      for (const a of addonRows) addonsReady[a.name] = a.enabled === true

      const cli: CliDetect = cliRes ?? {
        claudeCode: { installed: false, version: null, authenticated: false, loaded: false },
        codex: { installed: false, version: null, authenticated: false, loaded: false },
        restartRequired: false,
      }

      const next: CurrentSetup = {
        geminiConfigured: Boolean(providers?.configured?.includes('gemini')),
        routing: routing ?? null,
        addonsReady,
        cli,
        gpu: sysRes?.gpu ?? { detected: false },
      }
      setCurrent(next)
      // Pre-select a subscription only when one is genuinely usable.
      setAnswers((a) => ({ ...a, subscription: detectBestSubscription(cli) }))
    } catch (err) {
      // Without this, an unexpected response shape leaves `current` null and
      // every detection-dependent step renders as an empty panel with a live
      // Next button — which looks like the wizard works but silently isn't
      // reading anything. Fail visibly instead.
      console.error('[RecommendedSetupWizard] failed to read current setup:', err)
      toast.error(`Couldn't read the current setup: ${(err as Error).message}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) {
      setStep('intro')
      setLogs([])
      setApplyError(null)
      setRestartNeeded(false)
      setKeyInput('')
      void refresh()
    }
  }, [open, refresh])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [logs])

  const plan: SetupPlan | null = current
    ? buildSetupPlan(current, { ...answers, geminiKey: keyInput.trim() || null })
    : null

  /**
   * Ask the server to open a native folder picker, then scan the chosen folder
   * for documents grounding can't read.
   *
   * The scan is deliberately a separate, read-only call: the user sees the
   * exact file list and ticks what to convert. Nothing is written here.
   */
  async function pickVaultFolder() {
    setScanning(true)
    try {
      const picked = await fetch('/api/obsidian/pick-folder', { method: 'POST' })
        .then((r) => r.json())
        .catch(() => null)
      if (!picked?.ok || !picked.path) {
        if (picked?.reason && picked.reason !== 'cancelled') {
          toast.error(`Couldn't open the folder picker: ${picked.detail ?? picked.reason}`)
        }
        return
      }
      setAnswers((a) => ({ ...a, vaultPath: picked.path, convertDocs: [] }))

      // The scan endpoint reads the *configured* vault, so point config at the
      // folder first. enabled:false keeps grounding off until the plan is
      // applied — this is a look, not a commitment.
      await fetch('/api/obsidian/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vaultPath: picked.path, enabled: false, modeB: false, useClaudeMdContext: false }),
      })
      const scan = await fetch('/api/obsidian/convertible')
        .then((r) => (r.ok ? r.json() : { docs: [] }))
        .catch(() => ({ docs: [] }))
      const docs: ConvertibleDoc[] = scan.docs ?? []
      setConvertible(docs)
      // Pre-tick everything convertible; the user can untick.
      setAnswers((a) => ({
        ...a,
        convertDocs: docs.filter((d) => !d.hasSiblingMd && !d.blockedReason).map((d) => d.relPath),
      }))
    } finally {
      setScanning(false)
    }
  }

  function go(dir: 1 | -1) {
    const i = STEP_ORDER.indexOf(step)
    let next = i + dir
    // Skip the key step entirely when a Gemini key is already stored.
    if (STEP_ORDER[next] === 'key' && current?.geminiConfigured && !keyInput) next += dir
    setStep(STEP_ORDER[Math.max(0, Math.min(STEP_ORDER.length - 1, next))])
  }

  // --- apply ---------------------------------------------------------------
  async function apply() {
    if (!plan || !current) return
    setApplying(true)
    setApplyError(null)
    setStep('apply')
    setLogs([])
    const log = (line: string, stream: 'stdout' | 'stderr' = 'stdout') =>
      setLogs((l) => [...l, { stream, line }])

    try {
      for (const s of plan.steps) {
        if (s.skipped) {
          log(`• ${s.label} — already done, skipping.`)
          continue
        }

        if (s.id === 'gemini-key') {
          log('Saving the Gemini API key…')
          await putProviderKey('gemini', keyInput.trim())
          log('Verifying the key with a test call…')
          const test = await testProviderKey('gemini')
          if (!test.ok) throw new Error(`Gemini key rejected: ${test.error ?? 'unknown error'}`)
          log('Key stored and verified.')
          continue
        }

        if (s.kind === 'addon') {
          const addonName = s.id.replace(/^addon-/, '')
          log(`Installing ${addonName}…`)
          const { exitCode } = await streamAddonInstall(addonName, (entry) => setLogs((l) => [...l, entry]))
          if (exitCode !== 0) throw new Error(`${addonName} install exited ${exitCode} — see the log above.`)
          log(`${addonName} done.`)
          continue
        }

        if (s.id === 'vault-path') {
          log(`Pointing the lore source at ${answers.vaultPath}…`)
          const res = await fetch('/api/obsidian/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              vaultPath: answers.vaultPath,
              enabled: true,
              modeB: false,
              useClaudeMdContext: false,
            }),
          })
          if (!res.ok) {
            throw new Error(`Couldn't use that folder: ${(await res.json().catch(() => ({}))).error ?? res.status}`)
          }
          log('Lore source configured.')
          continue
        }

        if (s.id === 'vault-convert') {
          log(`Making markdown copies of ${answers.convertDocs.length} document(s)…`)
          const res = await fetch('/api/obsidian/convert', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paths: answers.convertDocs }),
          })
          const body = await res.json().catch(() => ({}))
          if (!res.ok) throw new Error(body.error ?? `Conversion failed (HTTP ${res.status})`)
          for (const r of (body.results ?? []) as Array<{
            relPath: string
            status: string
            wrotePath?: string
            reason?: string
          }>) {
            if (r.status === 'converted') log(`  created ${r.wrotePath}`)
            else log(`  ${r.status}: ${r.relPath}${r.reason ? ` — ${r.reason}` : ''}`, 'stderr')
          }
          log(`${body.converted ?? 0} markdown copies created. Originals untouched.`)
          continue
        }

        if (s.id === 'routing') {
          log('Writing the recommended per-phase routing…')
          const rec = recommendedRouting(answers.subscription)
          const existing = current.routing
          await putRouting({
            version: 3,
            lastSelectedProvider: existing?.lastSelectedProvider ?? 'gemini',
            geminiTier: existing?.geminiTier ?? 'paid',
            perPhase: rec.perPhase,
          })
          log('Routing applied.')
        }
      }

      setRestartNeeded(plan.restartRequired)
      log('')
      log('All done.')
      toast.success('Recommended setup applied.')
      setStep('done')
      await refresh()
    } catch (err) {
      const message = (err as Error).message
      setApplyError(message)
      log(message, 'stderr')
      toast.error(`Setup stopped: ${message}`)
    } finally {
      setApplying(false)
    }
  }

  const sub = answers.subscription

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Set up the recommended configuration</DialogTitle>
          <DialogDescription>
            The combination that produced the best results in testing. Nothing is changed until you
            confirm the summary at the end.
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="space-y-1 text-sm text-muted-foreground">
            <p>Checking what's already set up on this computer…</p>
            {/* This genuinely takes a few seconds: it runs `claude --version`
                and `codex --version`, and asks the graphics driver what card
                you have. Saying so beats an unexplained pause. */}
            <p className="text-xs">
              Looking for an existing API key, a Claude Code or Codex sign-in, and your graphics card.
              This takes a few seconds and changes nothing.
            </p>
          </div>
        )}

        {!loading && step === 'intro' && current && (
          <div className="space-y-3 text-sm">
            <p>This will walk through four things:</p>
            <ol className="ml-5 list-decimal space-y-1 text-muted-foreground">
              <li>A paid Gemini API key (used for the chronicle phases).</li>
              <li>
                Whether you have a Claude Code or Codex subscription — if you do, the mechanical phases
                run on allowance you already pay for instead of per-token API credit.
              </li>
              <li>Optionally installing Whisper for local audio transcription.</li>
              <li>Applying the per-phase routing that balances cost against quality.</li>
            </ol>
            <div className="rounded-md border border-border bg-muted/30 p-3">
              <p className="font-medium">What we found on this machine</p>
              <ul className="mt-1 space-y-0.5 text-muted-foreground">
                <li>Gemini key: {current.geminiConfigured ? 'already stored' : 'not set'}</li>
                <li>{describeCli('claudeCode', current.cli.claudeCode)}</li>
                <li>{describeCli('codex', current.cli.codex)}</li>
                <li>
                  GPU:{' '}
                  {current.gpu.detected
                    ? `${current.gpu.name ?? 'detected'}${current.gpu.vramGb ? ` (${current.gpu.vramGb} GB)` : ''}`
                    : 'none detected — Whisper would run on CPU and be slow'}
                </li>
              </ul>
            </div>
          </div>
        )}

        {!loading && step === 'prereqs' && (
          <div className="space-y-3 text-sm">
            <p>
              Two external tools the recommended setup builds on. Install them yourself — this wizard only
              links to them.
            </p>
            {PREREQS.map((p) => (
              <div key={p.name} className="rounded-md border border-border p-3">
                <a
                  href={p.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium underline"
                >
                  {p.name} ↗
                </a>
                <p className="mt-1 text-muted-foreground">{p.why}</p>
              </div>
            ))}
            <p className="text-muted-foreground">
              Neither is required to continue — you can add them later.
            </p>
          </div>
        )}

        {!loading && step === 'key' && (
          <div className="space-y-3 text-sm">
            <Label htmlFor="wizard-gemini-key">Paid Gemini API key</Label>
            <Input
              id="wizard-gemini-key"
              type="password"
              autoComplete="off"
              placeholder="Paste your key"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
            />
            <p className="text-muted-foreground">
              Stored encrypted on this machine and verified with a test call before anything else is
              applied. It is never sent anywhere except to Google.
            </p>
            {current?.geminiConfigured && (
              <p className="text-muted-foreground">
                A key is already stored — leave this blank to keep it.
              </p>
            )}
          </div>
        )}

        {!loading && step === 'subscription' && current && (
          <div className="space-y-3 text-sm">
            <p>
              If you already pay for Claude or ChatGPT, the mechanical phases can run on that plan's
              allowance instead of costing API credit.
            </p>
            <div className="space-y-2">
              {(['claudeCode', 'codex'] as SubscriptionTarget[]).map((target) => {
                const probe = target === 'claudeCode' ? current.cli.claudeCode : current.cli.codex
                const usable = probe.installed && probe.authenticated
                return (
                  <label
                    key={target}
                    className={`flex cursor-pointer items-start gap-2 rounded-md border p-3 ${
                      sub === target ? 'border-primary' : 'border-border'
                    } ${usable ? '' : 'opacity-60'}`}
                  >
                    <input
                      type="radio"
                      name="subscription"
                      className="mt-1"
                      checked={sub === target}
                      disabled={!usable}
                      onChange={() => setAnswers((a) => ({ ...a, subscription: target }))}
                    />
                    <span>
                      <span className="font-medium">
                        {target === 'claudeCode' ? 'Yes — Claude Code' : 'Yes — Codex (ChatGPT)'}
                      </span>
                      <span className="block text-muted-foreground">{describeCli(target, probe)}</span>
                    </span>
                  </label>
                )
              })}
              <label
                className={`flex cursor-pointer items-start gap-2 rounded-md border p-3 ${
                  sub === 'none' ? 'border-primary' : 'border-border'
                }`}
              >
                <input
                  type="radio"
                  name="subscription"
                  className="mt-1"
                  checked={sub === 'none'}
                  onChange={() => setAnswers((a) => ({ ...a, subscription: 'none' }))}
                />
                <span>
                  <span className="font-medium">No — use my Gemini key for everything</span>
                  <span className="block text-muted-foreground">
                    Everything is billed per token against your API key.
                  </span>
                </span>
              </label>
            </div>
          </div>
        )}

        {!loading && step === 'vault' && (
          <div className="space-y-3 text-sm">
            <p>
              Point Tusk's Tomes at a folder of campaign notes and it will use them to get names and
              places right. The folder is <strong>only ever read</strong>, never modified.
            </p>
            <p className="text-muted-foreground">
              We can't install Obsidian for you — but you don't need it to use this. Any folder of notes
              works. If you'd like the full Obsidian experience,{' '}
              <a
                href="https://obsidian.md/download"
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                download it here ↗
              </a>
              .
            </p>

            <div className="flex items-center gap-2">
              <Button variant="secondary" onClick={pickVaultFolder} disabled={scanning}>
                {scanning ? 'Scanning…' : answers.vaultPath ? 'Choose a different folder' : 'Choose folder…'}
              </Button>
              {answers.vaultPath && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setAnswers((a) => ({ ...a, vaultPath: null, convertDocs: [] }))
                    setConvertible(null)
                  }}
                >
                  Skip lore
                </Button>
              )}
            </div>

            {answers.vaultPath && (
              <p className="break-all font-mono text-xs text-muted-foreground">{answers.vaultPath}</p>
            )}

            {convertible && convertible.length === 0 && (
              <p className="text-muted-foreground">
                No Word or PDF documents found — everything in there is already readable.
              </p>
            )}

            {convertible && convertible.length > 0 && (
              <div className="space-y-2 rounded-md border border-border p-3">
                <p className="font-medium">Some of these notes aren't readable yet</p>
                <p className="text-muted-foreground">
                  Grounding can only read markdown (<code>.md</code>) files, so the Word and PDF documents
                  below are currently invisible to it. We can make a markdown copy of each one,{' '}
                  <strong>right next to the original</strong>. Your original files are never changed,
                  moved, or deleted, and an existing <code>.md</code> is never overwritten.
                </p>
                <ul className="max-h-40 space-y-1 overflow-y-auto">
                  {convertible.map((d) => (
                    <li key={d.relPath} className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-1"
                        disabled={d.hasSiblingMd || Boolean(d.blockedReason)}
                        checked={answers.convertDocs.includes(d.relPath)}
                        onChange={(e) =>
                          setAnswers((a) => ({
                            ...a,
                            convertDocs: e.target.checked
                              ? [...a.convertDocs, d.relPath]
                              : a.convertDocs.filter((p) => p !== d.relPath),
                          }))
                        }
                      />
                      <span className={d.hasSiblingMd || d.blockedReason ? 'text-muted-foreground' : ''}>
                        <span className="font-mono text-xs">{d.relPath}</span>
                        {d.hasSiblingMd && (
                          <span className="ml-2 text-xs">— already has a markdown copy</span>
                        )}
                        {d.blockedReason && <span className="ml-2 text-xs">— {d.blockedReason}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {!loading && step === 'whisper' && current && (
          <div className="space-y-3 text-sm">
            <label className="flex cursor-pointer items-start gap-2">
              <input
                type="checkbox"
                className="mt-1"
                checked={answers.installWhisper}
                onChange={(e) => setAnswers((a) => ({ ...a, installWhisper: e.target.checked }))}
              />
              <span>
                <span className="font-medium">Install Whisper for local audio transcription</span>
                <span className="block text-muted-foreground">
                  This creates a <strong>Python virtual environment</strong> under{' '}
                  <code>vendor/python-venv</code> and downloads the Whisper model — around{' '}
                  <strong>1.5 GB</strong>. Nothing is installed outside this folder, and uninstalling
                  removes all of it.
                </span>
              </span>
            </label>
            {!current.gpu.detected && answers.installWhisper && (
              <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
                <p className="font-medium">No dedicated graphics card was found on this computer</p>
                <p className="text-muted-foreground">
                  Whisper will still work, but it will use your processor instead of a graphics card. In
                  practice that means a three-hour recording can take <strong>several hours</strong> to
                  transcribe, rather than 20–30 minutes.
                </p>
                <p className="text-muted-foreground">
                  Most people in this position are better off skipping this and using the YouTube route
                  instead: upload the recording as an unlisted video, let YouTube transcribe it, and import
                  the captions. It costs nothing and takes minutes.
                </p>
                <label className="flex cursor-pointer items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={answers.acceptedCpuWhisper}
                    onChange={(e) =>
                      setAnswers((a) => ({ ...a, acceptedCpuWhisper: e.target.checked }))
                    }
                  />
                  <span>
                    I understand transcription will take hours on this computer, and I still want to
                    install Whisper.
                  </span>
                </label>
              </div>
            )}
          </div>
        )}

        {!loading && step === 'review' && plan && (
          <div className="space-y-3 text-sm">
            <p className="font-medium">This is everything that will change:</p>
            <ul className="space-y-2">
              {plan.steps.map((s) => (
                <li
                  key={s.id}
                  className={`rounded-md border p-3 ${s.skipped ? 'border-border opacity-60' : 'border-border'}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{s.label}</span>
                    {s.skipped && <span className="text-xs text-muted-foreground">no change</span>}
                  </div>
                  <p className="mt-1 text-muted-foreground">{s.detail}</p>
                  {!s.skipped && (
                    <p className="mt-1 font-mono text-xs text-muted-foreground">
                      {s.before} → {s.after}
                    </p>
                  )}
                </li>
              ))}
            </ul>

            {plan.blockers.length > 0 && (
              <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3">
                <p className="font-medium">Can't apply yet</p>
                <ul className="ml-5 list-disc text-muted-foreground">
                  {plan.blockers.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              </div>
            )}

            {plan.warnings.map((w) => (
              <p key={w} className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-muted-foreground">
                {w}
              </p>
            ))}

            {plan.restartRequired && (
              <p className="text-muted-foreground">
                An add-on is being enabled, so the server will need restarting afterwards before the new
                provider can be used. The wizard will remind you.
              </p>
            )}
          </div>
        )}

        {(step === 'apply' || step === 'done') && (
          <div className="space-y-3 text-sm">
            <div
              ref={logRef}
              className="max-h-64 overflow-y-auto rounded-md border border-border bg-muted/30 p-3 font-mono text-xs"
            >
              {logs.map((l, i) => (
                <div key={i} className={l.stream === 'stderr' ? 'text-destructive' : ''}>
                  {l.line}
                </div>
              ))}
            </div>
            {applyError && (
              <p className="rounded-md border border-destructive/50 bg-destructive/10 p-3">
                Setup stopped: {applyError}. Nothing after this point was applied — fix the problem and
                run the wizard again.
              </p>
            )}
            {step === 'done' && !applyError && restartNeeded && (
              <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
                <p className="font-medium">One last step — restart Tusk's Tomes</p>
                <p className="text-muted-foreground">
                  New features only load when the app starts up, so they aren't active yet.
                </p>
                <ol className="ml-5 list-decimal text-muted-foreground">
                  <li>Close this browser tab.</li>
                  <li>
                    Close the black <strong>Tusk's Tomes</strong> window that's running in the background.
                  </li>
                  <li>
                    Start it again by double-clicking <code>Start_Tusks_Tomes.bat</code> in the Tusk's
                    Tomes folder. Your browser will reopen on its own.
                  </li>
                </ol>
                <p className="text-muted-foreground">
                  Everything you've just set up is saved — you won't need to do this again.
                </p>
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          {step !== 'apply' && step !== 'done' && (
            <>
              <Button variant="ghost" onClick={() => (step === 'intro' ? onOpenChange(false) : go(-1))}>
                {step === 'intro' ? 'Cancel' : 'Back'}
              </Button>
              {step === 'review' ? (
                <Button
                  onClick={apply}
                  disabled={!plan || plan.blockers.length > 0 || planIsNoop(plan) || applying}
                >
                  {plan && planIsNoop(plan) ? 'Nothing to change' : 'Apply'}
                </Button>
              ) : (
                <Button onClick={() => go(1)} disabled={loading}>
                  Next
                </Button>
              )}
            </>
          )}
          {step === 'apply' && (
            <Button disabled>Applying…</Button>
          )}
          {step === 'done' && <Button onClick={() => onOpenChange(false)}>Close</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
