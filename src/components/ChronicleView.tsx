import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { BookHeart, BookOpen, Copy, Download, RotateCcw, ShieldAlert, Sparkles, Wrench } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { FlameLoader } from './FlameLoader'
import { RuneDivider } from './RuneDivider'
import type { CondenseOutput, ExtrasOutput } from '@/types'
import { exportChronicleToVault, getVaultPairStatus, type VaultPairStatus } from '@/lib/vault'
import { getLoreStatus, saveChronicleToLore, type LoreStatus } from '@/lib/lore'
import { buildMarkdown } from '@/lib/exportMarkdown'
import { quoteToPlainText } from '@/lib/quotes'
import { downloadChronicleDocx } from '@/lib/exportDocx'
import { runChronicleRestore, runExtrasRestore } from '@/lib/restorePass'
import type { FallbackRecord, RefusalRecord } from '@/lib/refusalDetection'
import type { GeminiTier } from '@/lib/providers'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

type Props = {
  campaign: string
  sessionNumber: number
  chronicle: string
  extras: ExtrasOutput | null
  condensed: CondenseOutput | null
  /** True while Phase 6 is running. Disables the Condense button. */
  condensing?: boolean
  /** Trigger Phase 6. Provided by the parent (RefinementTool). If undefined the button is hidden. */
  onCondense?: () => void
  /** True while Phase 4 is running. Disables the Generate-extras button. */
  generatingExtras?: boolean
  /** Trigger Phase 4 after the fact. Provided by the parent when the user
   *  opted out of extras at run start and wants them now. Button hidden
   *  when this is undefined OR when `extras` is already populated. */
  onGenerateExtras?: () => void
  onReset: () => void
  // ── Explicit-content failsafe (Claude Code) ──────────────────────────
  /** The grounded transcript — the unsanitised source the restore pass
   *  reconciles the chronicle against. Restore is unavailable without it. */
  groundedTranscript?: string
  /** True when the failsafe is enabled AND a Gemini key is configured.
   *  Gates the optional "Deep restore" (whole-transcript) affordance. */
  restoreEligible?: boolean
  /** Per-chunk refusals the failsafe repaired this run — drives the review
   *  modal where the user grounds the substituted wording. */
  fallbacks?: FallbackRecord[]
  /** Apply an edited replacement back into the chronicle. Returns ok=false
   *  with a reason when the passage can't be located. */
  onApplyFallbackEdit?: (index: number, edited: string) => { ok: boolean; reason?: string }
  /** Persisted, repairable manifest of UNREPAIRED Claude Code refusals. Drives
   *  the Review & Repair panel. */
  refusals?: RefusalRecord[]
  /** Re-process ONE refused chunk on the chosen Gemini tier and apply the
   *  result back into the run + library. Returns ok=false with a human reason
   *  (missing key, still-refused, non-JSON) so the panel never silently
   *  no-ops. Provided by RefinementTool (which holds the repair context). */
  onRepairRefusal?: (
    rec: RefusalRecord,
    opts: { geminiTier: GeminiTier },
  ) => Promise<{ ok: boolean; reason?: string }>
  /** Apply a restored chronicle (and optionally re-extracted extras) back
   *  into the run state + library. */
  onChronicleRestored?: (chronicle: string, extras: ExtrasOutput | null) => void
  /** Optional filename discriminator for the on-disk markdown auto-save. When
   *  set (e.g. a reforge / iteration copy), the auto-save writes its OWN file
   *  rather than overwriting the canonical Session-N export, so every copy is
   *  retained on disk until the user deletes it. */
  autoSaveVariant?: string
}

function downloadFile(filename: string, contents: string, mime = 'text/markdown') {
  const blob = new Blob([contents], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export function ChronicleView(props: Props) {
  const {
    campaign,
    sessionNumber,
    chronicle,
    extras,
    condensed,
    condensing,
    onCondense,
    generatingExtras,
    onGenerateExtras,
    onReset,
    groundedTranscript,
    restoreEligible,
    fallbacks,
    onApplyFallbackEdit,
    onChronicleRestored,
    refusals,
    onRepairRefusal,
    autoSaveVariant,
  } = props

  const [fallbackModalOpen, setFallbackModalOpen] = useState(false)
  const hasFallbacks = (fallbacks?.length ?? 0) > 0
  const [repairModalOpen, setRepairModalOpen] = useState(false)
  const unrepairedRefusals = (refusals ?? []).filter((r) => !r.repaired)
  const hasRefusals = unrepairedRefusals.length > 0

  // Explicit-content restore (failsafe). Runs the Gemini reconciliation, then
  // shows the result for review — Replace / Discard — rather than silently
  // overwriting (also surfaces it if a very long chronicle came back
  // truncated past the output cap).
  const [restoreRunning, setRestoreRunning] = useState(false)
  const [restorePreview, setRestorePreview] = useState<{
    chronicle: string
    extras: ExtrasOutput | null
  } | null>(null)
  const canRestore = Boolean(
    restoreEligible && onChronicleRestored && groundedTranscript?.trim() && chronicle.trim(),
  )

  async function runRestore() {
    if (!groundedTranscript?.trim()) {
      toast.error('Restore needs the grounded transcript from this run.')
      return
    }
    setRestoreRunning(true)
    try {
      const restored = await runChronicleRestore({ groundedTranscript, chronicle })
      if (!restored.trim()) throw new Error('Gemini returned an empty restore.')
      // Re-extract extras too (best-effort — chronicle is the main artifact).
      let restoredExtras: ExtrasOutput | null = null
      try {
        restoredExtras = await runExtrasRestore({ groundedTranscript })
      } catch (err) {
        toast.warning(`Chronicle restored, but extras re-extraction failed: ${(err as Error).message}`)
      }
      setRestorePreview({ chronicle: restored, extras: restoredExtras })
    } catch (err) {
      toast.error(`Restore failed: ${(err as Error).message}`)
    } finally {
      setRestoreRunning(false)
    }
  }

  function applyRestore() {
    if (!restorePreview || !onChronicleRestored) return
    onChronicleRestored(restorePreview.chronicle, restorePreview.extras)
    setRestorePreview(null)
    toast.success('Restored chronicle applied and saved to your library.')
  }

  // Vault pairing status — polled once on mount so the Send-to-Vault
  // button only appears when a sibling Vault install is detected.
  // Re-checked each time a chronicle finishes (the effect below re-runs
  // when chronicle content changes) so the user can launch Vault
  // mid-flow and have the button light up on the next render.
  const [vaultStatus, setVaultStatus] = useState<VaultPairStatus | null>(null)
  const [vaultSending, setVaultSending] = useState(false)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const status = await getVaultPairStatus()
        if (!cancelled) setVaultStatus(status)
      } catch {
        // Best-effort — if the pair check fails we just hide the button.
        if (!cancelled) setVaultStatus(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [chronicle])

  async function sendToVault() {
    if (!campaign.trim()) {
      toast.error('Set a campaign name in the header before exporting to Vault.')
      return
    }
    setVaultSending(true)
    try {
      const markdown = buildMarkdown({ campaign, sessionNumber, chronicle, extras, condensed })
      const result = await exportChronicleToVault({
        campaign,
        sessionNumber,
        content: markdown,
      })
      toast.success(`Pushed to Vault: ${result.relativeToVault}`)
    } catch (err) {
      toast.error(`Send to Vault failed: ${(err as Error).message}`)
    } finally {
      setVaultSending(false)
    }
  }

  // Tusks-Lore status — polled in the same shape as the Vault check so
  // the "Save to Lore" button only appears when the folder is set up.
  const [loreStatus, setLoreStatus] = useState<LoreStatus | null>(null)
  const [loreSavingMode, setLoreSavingMode] = useState<'full' | 'condensed' | null>(null)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const next = await getLoreStatus()
        if (!cancelled) setLoreStatus(next)
      } catch {
        if (!cancelled) setLoreStatus(null)
      }
    })()
    return () => { cancelled = true }
  }, [chronicle])

  async function saveToLore(mode: 'full' | 'condensed') {
    if (!campaign.trim()) {
      toast.error('Set a campaign name in the header before saving to Tusk\'s Lore.')
      return
    }
    setLoreSavingMode(mode)
    try {
      const result = await saveChronicleToLore({
        campaign,
        sessionNumber,
        chronicle,
        extras,
        condensed,
        mode,
      })
      toast.success(`Saved to Lore: ${result.relativeToLore}`)
    } catch (err) {
      toast.error(`Save to Lore failed: ${(err as Error).message}`)
    } finally {
      setLoreSavingMode(null)
    }
  }

  // Auto-save the chronicle markdown to the repo on disk whenever the
  // composed output changes. Skips empty chronicles and missing campaign
  // names (the server would reject those anyway). De-dupes by content so
  // a parent re-render with identical state doesn't trigger another POST.
  const lastSavedRef = useRef<string | null>(null)
  const warnedNoCampaignRef = useRef(false)
  useEffect(() => {
    if (!chronicle.trim()) return
    if (!campaign.trim()) {
      if (!warnedNoCampaignRef.current) {
        toast.warning(
          'Chronicle generated, but no campaign name set — set one in the header to auto-save to the repo.'
        )
        warnedNoCampaignRef.current = true
      }
      return
    }
    const markdown = buildMarkdown({
      campaign,
      sessionNumber,
      chronicle,
      extras,
      condensed,
    })
    // Fingerprint includes the variant so a reforge copy with the same prose
    // but a different target filename still saves (to its own file).
    const fingerprint = `${autoSaveVariant ?? ''}\u0000${markdown}`
    if (lastSavedRef.current === fingerprint) return
    lastSavedRef.current = fingerprint
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch('/api/chronicle/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            campaign,
            sessionNumber,
            content: markdown,
            variant: autoSaveVariant,
          }),
        })
        if (cancelled) return
        const data = (await res.json().catch(() => null)) as
          | { ok?: boolean; path?: string; error?: string }
          | null
        if (!res.ok || !data?.ok) {
          throw new Error(data?.error ?? `Save failed (${res.status})`)
        }
        toast.success(`Chronicle saved to ${data.path}`)
      } catch (err) {
        if (cancelled) return
        // If the save fails, allow a retry on the next state change by
        // forgetting the cached fingerprint.
        lastSavedRef.current = null
        toast.error(`Auto-save failed: ${(err as Error).message}`)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [campaign, sessionNumber, chronicle, extras, condensed, autoSaveVariant])

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(`${label} copied to clipboard`)
    } catch {
      toast.error('Clipboard write failed')
    }
  }

  const filenameBase = `${(campaign || 'campaign').replace(/[^\w-]+/g, '_')}-session-${sessionNumber}`

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>
            {campaign || 'Campaign'} — Session {sessionNumber}
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            {/* Generate extras after the fact — visible only when the
              * parent opted-out at run start (extras is null) AND the
              * parent provided the callback. Hidden once extras lands. */}
            {onGenerateExtras && !extras && (
              <Button
                variant="default"
                size="sm"
                onClick={onGenerateExtras}
                disabled={generatingExtras}
                title="Run an optional Phase 4 pass that extracts quotes, jests, and gore from the grounded transcript."
              >
                {generatingExtras ? (
                  <FlameLoader size={16} className="mr-1" />
                ) : (
                  <Sparkles className="mr-1 h-4 w-4" />
                )}
                {generatingExtras ? 'Generating extras…' : 'Generate extras'}
              </Button>
            )}
            {onCondense && (
              <Button
                variant={condensed ? 'outline' : 'default'}
                size="sm"
                onClick={onCondense}
                disabled={condensing || !chronicle.trim()}
                title={
                  !chronicle.trim()
                    ? 'Condense needs a chronicle — start a fresh run with Chronicle checked.'
                    : condensed
                    ? 'Re-run the condense pass — replaces the existing Condensed / Recap output.'
                    : 'Run an optional Phase 6 pass that condenses the chronicle and produces a catch-up recap.'
                }
              >
                {condensing ? (
                  <FlameLoader size={16} className="mr-1" />
                ) : (
                  <Sparkles className="mr-1 h-4 w-4" />
                )}
                {condensing ? 'Condensing…' : condensed ? 'Re-condense' : 'Condense'}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => downloadFile(`${filenameBase}.md`, buildMarkdown(props))}
            >
              <Download className="mr-1 h-4 w-4" />
              Download .md
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!chronicle.trim()}
              title="Download a formatted Word document with the chronicle, condensed version, recap, jests, gore, and quotes (whatever was generated)."
              onClick={() => {
                void downloadChronicleDocx({
                  campaign,
                  sessionNumber,
                  chronicle,
                  extras,
                  condensed,
                  mode: 'full',
                }).catch((err) => toast.error(`Download failed: ${(err as Error).message}`))
              }}
            >
              <Download className="mr-1 h-4 w-4" />
              Download .docx
            </Button>
            {vaultStatus?.paired && (
              <Button
                variant="outline"
                size="sm"
                onClick={sendToVault}
                disabled={vaultSending || !chronicle.trim()}
                title={
                  vaultStatus.loreDirWritable === false
                    ? `Vault detected at ${vaultStatus.vaultRoot} but its Lore folder isn't writable — fix permissions to enable export.`
                    : `Push this chronicle to Tusk's Vault at ${vaultStatus.loreDir}/Tomes/${campaign || '<campaign>'}/...`
                }
                className="border-violet-500/40 text-violet-700 hover:bg-violet-500/10 hover:text-violet-700 dark:text-violet-300 dark:hover:text-violet-200"
              >
                {vaultSending ? (
                  <FlameLoader size={16} className="mr-1" />
                ) : (
                  <BookHeart className="mr-1 h-4 w-4" />
                )}
                {vaultSending ? 'Sending…' : 'Send to Vault'}
              </Button>
            )}
            {loreStatus?.found && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void saveToLore('full')}
                  disabled={loreSavingMode !== null || !chronicle.trim()}
                  title={`Render the full chronicle + Gallery of Jests/Gore + Quotes to ${loreStatus.sessionsDir}/${campaign || '<campaign>'}/Session-NN-<date>-full.docx`}
                  className="border-amber-500/40 text-amber-700 hover:bg-amber-500/10 hover:text-amber-700 dark:text-amber-300 dark:hover:text-amber-200"
                >
                  {loreSavingMode === 'full' ? (
                    <FlameLoader size={16} className="mr-1" />
                  ) : (
                    <BookOpen className="mr-1 h-4 w-4" />
                  )}
                  {loreSavingMode === 'full' ? 'Saving…' : 'Save full .docx'}
                </Button>
                {condensed && (condensed.narrative.trim() || condensed.bulletPoints.length > 0) && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void saveToLore('condensed')}
                    disabled={loreSavingMode !== null || !chronicle.trim()}
                    title={`Render the condensed chronicle + recap bullets + extras to ${loreStatus.sessionsDir}/${campaign || '<campaign>'}/Session-NN-<date>-condensed.docx`}
                    className="border-amber-500/40 text-amber-700 hover:bg-amber-500/10 hover:text-amber-700 dark:text-amber-300 dark:hover:text-amber-200"
                  >
                    {loreSavingMode === 'condensed' ? (
                      <FlameLoader size={16} className="mr-1" />
                    ) : (
                      <BookOpen className="mr-1 h-4 w-4" />
                    )}
                    {loreSavingMode === 'condensed' ? 'Saving…' : 'Save condensed .docx'}
                  </Button>
                )}
              </>
            )}
            {hasFallbacks && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setFallbackModalOpen(true)}
                title="Review the chunks the failsafe repaired on Gemini — see the transcript source, edit the wording, and apply it back."
                className="border-rose-500/40 text-rose-700 hover:bg-rose-500/10 hover:text-rose-700 dark:text-rose-300 dark:hover:text-rose-200"
              >
                <ShieldAlert className="mr-1 h-4 w-4" />
                Review fallbacks ({fallbacks?.length})
              </Button>
            )}
            {hasRefusals && onRepairRefusal && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setRepairModalOpen(true)}
                title="Claude Code refused these chunks and the in-run failsafe didn't repair them. Re-process just those chunks on a paid Gemini key and splice the results back in."
                className="border-amber-500/40 text-amber-700 hover:bg-amber-500/10 hover:text-amber-700 dark:text-amber-300 dark:hover:text-amber-200"
              >
                <Wrench className="mr-1 h-4 w-4" />
                Review &amp; Repair Refusals ({unrepairedRefusals.length})
              </Button>
            )}
            {canRestore && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void runRestore()}
                disabled={restoreRunning}
                title="Optional, costlier: reconcile the WHOLE chronicle against the WHOLE transcript on Gemini Pro to restore content softened without an outright refusal. You review the result before it replaces anything. The per-chunk failsafe above is cheaper and usually enough."
              >
                {restoreRunning ? (
                  <FlameLoader size={16} className="mr-1" />
                ) : (
                  <Sparkles className="mr-1 h-4 w-4" />
                )}
                {restoreRunning ? 'Restoring…' : 'Deep restore (whole transcript)'}
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={onReset}>
              <RotateCcw className="mr-1 h-4 w-4" />
              Start over
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {/* Decorative amethyst rune break between the action row above and
            the chronicle body — shared idiom with Tusk's Vault. */}
        <RuneDivider className="!my-3 sm:!my-4" />

        {/* Auto-offer: the failsafe repaired one or more refused chunks. */}
        {hasFallbacks && (
          <div className="mb-3 rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-sm">
            <div className="flex items-start gap-2">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400" />
              <div className="flex-1">
                <p className="font-medium">
                  {fallbacks?.length} chunk{(fallbacks?.length ?? 0) === 1 ? '' : 's'} repaired by
                  the explicit-content failsafe.
                </p>
                <p className="text-muted-foreground">
                  Claude Code looked like it refused — Gemini wrote those passages instead. Review
                  each against the transcript and edit the wording to ground it yourself.
                </p>
              </div>
              <Button size="sm" onClick={() => setFallbackModalOpen(true)}>
                Review &amp; ground
              </Button>
            </div>
          </div>
        )}

        {/* Review panel: restored chronicle awaiting Replace / Discard. */}
        {restorePreview && (
          <div className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-sm font-medium">Restored chronicle — review before replacing</p>
              <span className="flex gap-2">
                <Button size="sm" onClick={applyRestore}>
                  Replace
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setRestorePreview(null)}>
                  Discard
                </Button>
              </span>
            </div>
            <p className="mb-2 text-xs text-muted-foreground">
              {restorePreview.chronicle.length.toLocaleString()} chars
              {restorePreview.chronicle.length < chronicle.length * 0.6
                ? ' — ⚠ much shorter than the original; it may have been truncated past the output cap. Review carefully before replacing.'
                : ''}
              {restorePreview.extras
                ? ` · re-extracted extras: ${restorePreview.extras.gore.length} gore, ${restorePreview.extras.quotes.length} quotes, ${restorePreview.extras.jests.length} jests`
                : ''}
            </p>
            <div className="max-h-96 overflow-auto whitespace-pre-wrap rounded bg-[oklch(0.16_0.025_245)] p-4 text-sm">
              {restorePreview.chronicle}
            </div>
          </div>
        )}

        <Tabs defaultValue="chronicle">
          <TabsList>
            <TabsTrigger value="chronicle">Chronicle</TabsTrigger>
            <TabsTrigger value="jests">Jests ({extras?.jests.length ?? 0})</TabsTrigger>
            <TabsTrigger value="gore">Gore ({extras?.gore.length ?? 0})</TabsTrigger>
            <TabsTrigger value="quotes">Quotes ({extras?.quotes.length ?? 0})</TabsTrigger>
            {condensed && (
              <TabsTrigger value="condensed">Condensed</TabsTrigger>
            )}
            {condensed && (
              <TabsTrigger value="recap">Recap ({condensed.bulletPoints.length})</TabsTrigger>
            )}
          </TabsList>

          <TabsContent value="chronicle">
            <div className="flex justify-end pb-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => copy(chronicle, 'Chronicle')}
              >
                <Copy className="mr-1 h-4 w-4" />
                Copy
              </Button>
            </div>
            <article className="chronicle-prose whitespace-pre-wrap rounded-md border border-border/70 bg-[oklch(0.16_0.025_245)] p-6 shadow-inner">
              {chronicle || '(empty)'}
            </article>
          </TabsContent>

          <TabsContent value="jests">
            <ExtrasList items={extras?.jests} emptyLabel="No jests captured." onCopy={(t) => copy(t, 'Jests')} />
          </TabsContent>

          <TabsContent value="gore">
            <ExtrasList items={extras?.gore} emptyLabel="No gore captured." onCopy={(t) => copy(t, 'Gore')} />
          </TabsContent>

          <TabsContent value="quotes">
            <QuotesView quotes={extras?.quotes ?? []} onCopy={(t) => copy(t, 'Quotes')} />
          </TabsContent>

          {condensed && (
            <TabsContent value="condensed">
              <div className="flex justify-end pb-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => copy(condensed.narrative, 'Condensed chronicle')}
                >
                  <Copy className="mr-1 h-4 w-4" />
                  Copy
                </Button>
              </div>
              <article className="chronicle-prose whitespace-pre-wrap rounded-md border border-border/70 bg-[oklch(0.16_0.025_245)] p-6 shadow-inner">
                {condensed.narrative || '(empty)'}
              </article>
            </TabsContent>
          )}

          {condensed && (
            <TabsContent value="recap">
              <div className="flex justify-end pb-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    copy(
                      condensed.bulletPoints.map((b) => `- ${b}`).join('\n'),
                      'Catch-up recap'
                    )
                  }
                >
                  <Copy className="mr-1 h-4 w-4" />
                  Copy all
                </Button>
              </div>
              {condensed.bulletPoints.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No bullets — try re-running Condense.
                </p>
              ) : (
                <ul className="list-disc space-y-2 rounded-md border bg-card p-4 pl-8 text-sm">
                  {condensed.bulletPoints.map((b, i) => (
                    <li key={i}>{b}</li>
                  ))}
                </ul>
              )}
            </TabsContent>
          )}
        </Tabs>
      </CardContent>

      {onApplyFallbackEdit && (
        <FallbackReviewModal
          open={fallbackModalOpen}
          onOpenChange={setFallbackModalOpen}
          fallbacks={fallbacks ?? []}
          onApply={onApplyFallbackEdit}
        />
      )}
      {onRepairRefusal && (
        <RefusalRepairModal
          open={repairModalOpen}
          onOpenChange={setRepairModalOpen}
          refusals={refusals ?? []}
          onRepair={onRepairRefusal}
        />
      )}
    </Card>
  )
}

const PHASE_LABEL: Record<string, string> = {
  phase1_ground: 'Grounding',
  phase2_audit: 'Audit (DM questions)',
  phase3_chronicle: 'Chronicle',
  phase4_extras: 'Extras',
  phase6_condense: 'Condense',
}

/** Pop-up to re-process UNREPAIRED Claude Code refusals on a paid Gemini key.
 *  Each row re-runs just that chunk and splices/merges the result back in. */
function RefusalRepairModal({
  open,
  onOpenChange,
  refusals,
  onRepair,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  refusals: RefusalRecord[]
  onRepair: (rec: RefusalRecord, opts: { geminiTier: GeminiTier }) => Promise<{ ok: boolean; reason?: string }>
}) {
  const [tier, setTier] = useState<GeminiTier>('paid')
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [done, setDone] = useState<Record<string, boolean>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [repairingAll, setRepairingAll] = useState(false)

  const pending = refusals.filter((r) => !r.repaired && !done[r.id])

  const repairOne = async (rec: RefusalRecord): Promise<boolean> => {
    setBusy((b) => ({ ...b, [rec.id]: true }))
    setErrors((e) => ({ ...e, [rec.id]: '' }))
    try {
      const res = await onRepair(rec, { geminiTier: tier })
      if (res.ok) {
        setDone((d) => ({ ...d, [rec.id]: true }))
        toast.success(`Repaired ${PHASE_LABEL[rec.phase] ?? rec.phase} chunk ${rec.chunkIndex + 1}.`)
        return true
      }
      setErrors((e) => ({ ...e, [rec.id]: res.reason ?? 'Repair failed.' }))
      toast.error(res.reason ?? 'Repair failed.')
      return false
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err)
      setErrors((e) => ({ ...e, [rec.id]: msg }))
      toast.error(msg)
      return false
    } finally {
      setBusy((b) => ({ ...b, [rec.id]: false }))
    }
  }

  const repairAll = async () => {
    setRepairingAll(true)
    try {
      // Sequential — keeps Gemini pacing sane and lets a missing-key failure
      // surface on the first row instead of N parallel errors.
      for (const rec of refusals.filter((r) => !r.repaired && !done[r.id])) {
        const ok = await repairOne(rec)
        if (!ok) break
      }
    } finally {
      setRepairingAll(false)
    }
  }

  const hasPhase1 = refusals.some((r) => !r.repaired && r.phase === 'phase1_ground')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Review &amp; Repair Refusals</DialogTitle>
          <DialogDescription>
            Claude Code refused these chunks and the in-run failsafe didn&apos;t repair them. Re-process
            just the refused chunk(s) on a working Gemini key — the result is spliced back into the
            chronicle (or merged into DM questions / extras) automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="mb-3 flex flex-wrap items-center gap-3">
          <label className="text-xs font-medium">Gemini key tier</label>
          <select
            className="rounded border border-border bg-background px-2 py-1 text-sm"
            value={tier}
            onChange={(e) => setTier(e.target.value as GeminiTier)}
          >
            <option value="paid">Paid (recommended)</option>
            <option value="free">Free</option>
            <option value="auto">Auto</option>
          </select>
          <Button size="sm" onClick={() => void repairAll()} disabled={repairingAll || pending.length === 0}>
            {repairingAll ? 'Repairing…' : `Repair all (${pending.length})`}
          </Button>
        </div>

        {hasPhase1 && (
          <p className="mb-3 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-800 dark:text-amber-200">
            ⚠ A grounding (Phase 1) repair re-grounds the source span, but the chronicle and extras
            were already written from the ungrounded text — they may need regenerating afterwards.
          </p>
        )}

        <div className="space-y-4">
          {refusals.length === 0 && (
            <p className="text-sm text-muted-foreground">No unrepaired refusals — nothing to repair.</p>
          )}
          {refusals.map((rec) => {
            const isDone = rec.repaired || done[rec.id]
            return (
              <div key={rec.id} className="rounded-md border border-border p-3">
                <p className="mb-2 text-xs font-medium text-muted-foreground">
                  {PHASE_LABEL[rec.phase] ?? rec.phase} · chunk {rec.chunkIndex + 1}
                  {rec.totalChunks ? `/${rec.totalChunks}` : ''}
                  {isDone && <span className="ml-2 text-green-600 dark:text-green-400">repaired ✓</span>}
                </p>

                <details className="mb-2">
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    Source span (what was said) — {rec.sourceSpan.length.toLocaleString()} chars
                  </summary>
                  <div className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 text-xs">
                    {rec.sourceSpan || '(unavailable)'}
                  </div>
                </details>

                {rec.refusedText && (
                  <details className="mb-2">
                    <summary className="cursor-pointer text-xs text-muted-foreground">
                      What Claude returned (the refusal)
                    </summary>
                    <div className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 text-xs">
                      {rec.refusedText}
                    </div>
                  </details>
                )}

                <div className="mt-2 flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={isDone || busy[rec.id] || repairingAll}
                    onClick={() => void repairOne(rec)}
                  >
                    {busy[rec.id] ? 'Repairing…' : isDone ? 'Repaired' : 'Repair this chunk'}
                  </Button>
                  {errors[rec.id] && (
                    <span className="text-xs text-rose-600 dark:text-rose-400">{errors[rec.id]}</span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Pop-up to review each failsafe-repaired chunk: read the transcript span,
 *  edit the wording Gemini wrote, and apply it back into the chronicle. */
function FallbackReviewModal({
  open,
  onOpenChange,
  fallbacks,
  onApply,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  fallbacks: FallbackRecord[]
  onApply: (index: number, edited: string) => { ok: boolean; reason?: string }
}) {
  // Per-item draft text. Keyed by index; initialised lazily from the record's
  // replacementText the first time the modal renders an item.
  const [drafts, setDrafts] = useState<Record<number, string>>({})
  const [applied, setApplied] = useState<Record<number, boolean>>({})

  const draftFor = (i: number) => drafts[i] ?? fallbacks[i]?.replacementText ?? ''

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Review &amp; ground fallbacks</DialogTitle>
          <DialogDescription>
            Claude Code looked like it refused these chunks; Gemini wrote them instead. Check each
            against the transcript, edit the wording, and apply it back into the chronicle.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {fallbacks.length === 0 && (
            <p className="text-sm text-muted-foreground">No fallbacks this run.</p>
          )}
          {fallbacks.map((fb, i) => (
            <div key={i} className="rounded-md border border-border p-3">
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                {fb.phase.replace('_', ' ')} · chunk {fb.chunkIndex + 1}
                {fb.replacementText ? '' : ' · ⚠ no Gemini key was available — not repaired'}
              </p>

              <details className="mb-2">
                <summary className="cursor-pointer text-xs text-muted-foreground">
                  Transcript span (what was said) — {fb.transcriptExcerpt.length.toLocaleString()} chars
                </summary>
                <div className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 text-xs">
                  {fb.transcriptExcerpt || '(unavailable)'}
                </div>
              </details>

              {fb.refusedText && (
                <details className="mb-2">
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    What Claude returned (the refusal)
                  </summary>
                  <div className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 text-xs">
                    {fb.refusedText}
                  </div>
                </details>
              )}

              <label className="mb-1 block text-xs font-medium">Your wording (edit freely)</label>
              <textarea
                className="min-h-32 w-full rounded border border-border bg-background p-2 text-sm"
                value={draftFor(i)}
                onChange={(e) => setDrafts((d) => ({ ...d, [i]: e.target.value }))}
              />
              <div className="mt-2 flex items-center gap-2">
                <Button
                  size="sm"
                  onClick={() => {
                    const res = onApply(i, draftFor(i))
                    if (res.ok) {
                      setApplied((a) => ({ ...a, [i]: true }))
                      toast.success(`Applied your edit to chunk ${fb.chunkIndex + 1}.`)
                    } else {
                      toast.error(res.reason ?? 'Could not apply this edit.')
                    }
                  }}
                >
                  Apply to chronicle
                </Button>
                {applied[i] && <span className="text-xs text-green-600 dark:text-green-400">Applied ✓</span>}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function QuotesView({
  quotes,
  onCopy,
}: {
  quotes: import('@/types').Quote[]
  onCopy: (text: string) => void
}) {
  if (!quotes.length) {
    return <p className="text-sm text-muted-foreground">No quotes captured.</p>
  }

  const groups: Record<'funny' | 'stupid' | 'dark', typeof quotes> = {
    funny: quotes.filter((q) => (q.kind ?? 'funny') === 'funny'),
    stupid: quotes.filter((q) => q.kind === 'stupid'),
    dark: quotes.filter((q) => q.kind === 'dark'),
  }

  const labels: Record<'funny' | 'stupid' | 'dark', string> = {
    funny: 'Funny',
    stupid: 'Stupid',
    dark: 'Dark',
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            onCopy(
              quotes
                .map((q) => `[${q.kind ?? 'funny'}] ${quoteToPlainText(q)}`)
                .join('\n')
            )
          }
        >
          <Copy className="mr-1 h-4 w-4" />
          Copy all
        </Button>
      </div>
      {(['funny', 'stupid', 'dark'] as const).map((kind) => {
        const list = groups[kind]
        if (!list.length) return null
        return (
          <div key={kind}>
            <h3 className="mb-2 font-display text-sm uppercase tracking-wider text-muted-foreground">
              {labels[kind]} ({list.length})
            </h3>
            <ul className="space-y-2 rounded-md border bg-card p-4">
              {list.map((q, i) => (
                <li key={i} className="text-sm">
                  {q.exchange?.length ? (
                    <>
                      <span className="font-semibold">{q.speaker}</span>
                      {q.context ? (
                        <span className="italic text-muted-foreground"> — {q.context}</span>
                      ) : null}
                      <ul className="mt-1 space-y-1 border-l pl-3">
                        {q.exchange.map((t, j) => (
                          <li key={j}>
                            <span className="font-semibold">{t.speaker}:</span>{' '}
                            <span className="italic">"{t.line}"</span>
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : (
                    <>
                      <span className="font-semibold">{q.speaker}:</span>{' '}
                      <span className="italic">"{q.line}"</span>
                      {q.context ? (
                        <span className="italic text-muted-foreground"> — {q.context}</span>
                      ) : null}
                    </>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </div>
  )
}

function ExtrasList({
  items,
  emptyLabel,
  onCopy,
}: {
  items: string[] | undefined
  emptyLabel: string
  onCopy: (text: string) => void
}) {
  if (!items?.length) {
    return <p className="text-sm text-muted-foreground">{emptyLabel}</p>
  }
  return (
    <>
      <div className="flex justify-end pb-2">
        <Button variant="ghost" size="sm" onClick={() => onCopy(items.join('\n'))}>
          <Copy className="mr-1 h-4 w-4" />
          Copy all
        </Button>
      </div>
      <ul className="list-disc space-y-2 rounded-md border bg-card p-4 pl-8 text-sm">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </>
  )
}
