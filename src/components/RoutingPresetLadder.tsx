// Guided routing presets — the DEFAULT (non-advanced) view of Hybrid Routing.
//
// Four rungs from maximum quality to completely free, each a one-click apply
// of a complete per-phase recipe from src/lib/budgetMode.ts.
//
// Presentation rules (learned from looking at v1 rendered rather than in
// source — it was five stacked walls of prose):
//   - Each rung shows ONE line. Rationale, measurements and caveats live
//     behind the ⓘ.
//   - The saving chip says whether the number is measured or estimated.
//     Never let an extrapolation look like a measurement.
//   - The rung matching current routing is badged "Current", so the user can
//     see where they stand, not just where they could go.
//   - The recommended rung is visually distinct. Equal-weight cards are not a
//     recommendation.
//   - The plan/usage hint is stated ONCE in the plan bar, not repeated per
//     rung.
//
// Availability resolves live: API-key rungs need the key, subscription rungs
// need the claude-code or codex add-on. Apply only STAGES the recipe — the
// parent's Save button commits it.

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Check, Crown, Scale, FlaskConical, Coins, Gift, Star } from 'lucide-react'
import { useAddons } from '@/contexts/AddonContext'
import { InfoHint } from '@/components/ui/info-hint'
import type { RoutingDocument } from '@/lib/routing'
import type { CloudProvider } from '@/lib/profiles'
import type { ProvidersSummary } from '@/lib/providerSettings'
import {
  buildMaxQualityPerPhase,
  buildBalancedPerPhase,
  buildMeasuredHybridSubPerPhase,
  buildGeminiMeasuredHybridPerPhase,
  buildFreeSubscriptionPerPhase,
  GEMINI_MEASURED_HYBRID_SAVING_PCT,
  MAX_QUALITY_SAVING_PCT,
  BALANCED_THINKING_SAVING_PCT,
  MEASURED_HYBRID_SUB_SAVING_PCT,
  FREE_SUBSCRIPTION_SAVING_PCT,
  type SubscriptionTarget,
} from '@/lib/budgetMode'

type PerPhase = NonNullable<RoutingDocument['perPhase']>

type Props = {
  providers: ProvidersSummary | null
  activeProvider: CloudProvider | null
  /** Current routing, used only to badge whichever rung is already applied. */
  currentPerPhase?: PerPhase | null
  onApply: (perPhase: PerPhase, presetLabel: string) => void
}

type PlanState = {
  claudeCodePlan: 'unknown' | 'pro' | 'max5x' | 'max20x'
  codexPlan: 'unknown' | 'plus' | 'pro'
}

const CC_PLAN_LABELS: Record<PlanState['claudeCodePlan'], string> = {
  unknown: 'Not set',
  pro: 'Claude Pro',
  max5x: 'Claude Max 5×',
  max20x: 'Claude Max 20×',
}
const CODEX_PLAN_LABELS: Record<PlanState['codexPlan'], string> = {
  unknown: 'Not set',
  plus: 'ChatGPT Plus',
  pro: 'ChatGPT Pro',
}

export function RoutingPresetLadder({
  providers,
  activeProvider,
  currentPerPhase,
  onApply,
}: Props) {
  const { isLoaded } = useAddons()
  const ccLoaded = isLoaded('claude-code-addon')
  const codexLoaded = isLoaded('codex-addon')

  const [subTarget, setSubTarget] = useState<SubscriptionTarget>('claudeCode')
  const effectiveSub: SubscriptionTarget | null =
    ccLoaded && codexLoaded ? subTarget : ccLoaded ? 'claudeCode' : codexLoaded ? 'codex' : null

  const [plans, setPlans] = useState<PlanState>({ claudeCodePlan: 'unknown', codexPlan: 'unknown' })
  const [savingPlan, setSavingPlan] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/settings')
        if (!res.ok) return
        const body = (await res.json()) as Partial<PlanState>
        setPlans({
          claudeCodePlan: body.claudeCodePlan ?? 'unknown',
          codexPlan: body.codexPlan ?? 'unknown',
        })
      } catch {
        /* plan hint is optional — never block the ladder on it */
      }
    })()
  }, [])

  async function savePlan(patch: Partial<PlanState>) {
    setSavingPlan(true)
    const prev = plans
    setPlans({ ...plans, ...patch })
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } catch (err) {
      setPlans(prev)
      toast.error(`Couldn't save the plan: ${(err as Error).message}`)
    } finally {
      setSavingPlan(false)
    }
  }

  /** A rung is "current" when every phase it sets matches what's applied.
   *  Compared on provider + model only; the Gemini tier is a separate
   *  control and shouldn't stop a preset reading as active. */
  function isCurrent(recipe: PerPhase | null): boolean {
    if (!recipe || !currentPerPhase) return false
    const keys = Object.keys(recipe) as Array<keyof PerPhase>
    if (!keys.length) return false
    return keys.every((k) => {
      const want = recipe[k]
      const have = currentPerPhase[k]
      if (!want || !have || want.target !== 'cloud' || have.target !== 'cloud') return false
      return want.cloudProvider === have.cloudProvider && want.modelId === have.modelId
    })
  }

  const geminiConfigured = providers?.configured.includes('gemini') ?? false
  const apiProvider: CloudProvider | null =
    activeProvider && activeProvider !== 'claudeCode' && activeProvider !== 'codex'
      ? activeProvider
      : geminiConfigured
        ? 'gemini'
        : null

  const subLabel = effectiveSub === 'codex' ? 'Codex' : 'Claude Code'

  type Rung = {
    id: string
    icon: React.ReactNode
    title: string
    savingPct: number
    savingKind: 'baseline' | 'measured' | 'estimated' | 'free'
    blurb: string
    hint: React.ReactNode
    recommended?: boolean
    available: boolean
    unavailableReason?: string
    caveat?: React.ReactNode
    recipe: PerPhase | null
  }

  const maxRecipe = apiProvider ? buildMaxQualityPerPhase(apiProvider) : null
  const balanced = effectiveSub ? buildBalancedPerPhase(effectiveSub) : null
  const measuredRecipe = effectiveSub
    ? buildMeasuredHybridSubPerPhase(effectiveSub)
    : buildGeminiMeasuredHybridPerPhase('gemini')
  const freeRecipe = effectiveSub ? buildFreeSubscriptionPerPhase(effectiveSub) : null

  const rungs: Rung[] = [
    {
      id: 'max-quality',
      icon: <Crown className="h-4 w-4" />,
      title: 'Maximum quality',
      savingPct: MAX_QUALITY_SAVING_PCT,
      savingKind: 'baseline',
      blurb: 'The newest top-tier model on every phase. The yardstick every saving below is measured against.',
      hint: (
        <>
          <p className="mb-2">
            Runs the latest pro-tier model for your provider on all five phases, with the model’s
            reasoning left on.
          </p>
          <p>
            Nothing is compromised here, and nothing is optimised either. Pick it when a session
            genuinely matters, or to produce a reference output to compare the cheaper rungs against.
          </p>
        </>
      ),
      available: apiProvider !== null,
      unavailableReason: 'Needs a Gemini, Claude, or OpenAI API key.',
      recipe: maxRecipe,
    },
    {
      id: 'balanced-thinking',
      icon: <Scale className="h-4 w-4" />,
      title: 'Balanced',
      savingPct: BALANCED_THINKING_SAVING_PCT,
      savingKind: 'estimated',
      blurb: `Grounding and audit move to ${subLabel} (free); prose stays on the top-tier Gemini.`,
      hint: (
        <>
          <p className="mb-2">
            The two mechanical phases — grounding and audit — run on your subscription CLI at no
            API cost. Chronicle and Condense stay on the latest Gemini Pro, with Extras on Flash.
          </p>
          <p>
            The saving is <strong>estimated</strong>, extrapolated from measured per-phase costs
            rather than measured end-to-end. Prose should be indistinguishable from Maximum quality,
            since the phases that write prose are unchanged.
          </p>
        </>
      ),
      available: geminiConfigured && effectiveSub !== null,
      unavailableReason: 'Needs a Gemini key plus the Claude Code or Codex add-on.',
      recipe: balanced,
    },
    {
      id: 'measured-hybrid',
      icon: <FlaskConical className="h-4 w-4" />,
      title: 'Measured hybrid',
      savingPct: effectiveSub ? MEASURED_HYBRID_SUB_SAVING_PCT : GEMINI_MEASURED_HYBRID_SAVING_PCT,
      savingKind: 'measured',
      recommended: true,
      blurb: effectiveSub
        ? `Mechanical phases on ${subLabel} (free), everything else on the latest Gemini Flash.`
        : 'Every phase on the latest Gemini Flash — the configuration that matched Pro in testing.',
      hint: (
        <>
          <p className="mb-2">
            This is the routing this app’s own A/B testing converged on. Chronicles written by the
            cheap Flash tier were blind-judged <strong>comparable to the expensive Pro tier</strong>,
            at 72–83% less per chunk.
          </p>
          {effectiveSub && (
            <p className="mb-2">
              With a subscription CLI connected, grounding and audit also move off the API entirely,
              which is where the rest of the saving comes from.
            </p>
          )}
          <p>
            The headline number is <strong>measured</strong>, not estimated: real chunks, real token
            counts, priced from the app’s own rate table.
          </p>
        </>
      ),
      available: geminiConfigured,
      unavailableReason: 'Needs a Gemini key.',
      recipe: measuredRecipe,
    },
    {
      id: 'free-subscription',
      icon: <Gift className="h-4 w-4" />,
      title: 'Free',
      savingPct: FREE_SUBSCRIPTION_SAVING_PCT,
      savingKind: 'free',
      blurb: `Every phase runs on ${subLabel}. No API keys, no per-token cost at all.`,
      hint: (
        <>
          <p className="mb-2">
            Nothing touches a paid API. Runs bill against the subscription you already pay for.
          </p>
          <p className="mb-2">
            The trade is real and measured: on a full session the CLI completed the mechanical
            grounding phase on <strong>15 of 15</strong> chunks, but declined the analytical audit
            phase on <strong>14 of 15</strong> — and its judgement of what counts as a funny or
            notable moment trails Gemini.
          </p>
          <p>
            If the usage window runs out mid-run, the run auto-pauses and resumes at the exact chunk
            it stopped on. Nothing is lost.
          </p>
        </>
      ),
      available: effectiveSub !== null,
      unavailableReason: 'Needs the Claude Code or Codex add-on.',
      caveat: (
        <>
          Expect noticeably weaker Extras and a thinner audit than the paid rungs. Best for
          zero-budget runs, not for a session you care about.
        </>
      ),
      recipe: freeRecipe,
    },
  ]

  return (
    <div className="space-y-3">
      {/* Plan bar — stated ONCE here rather than repeated on every
          subscription rung, which is what v1 did. */}
      {(ccLoaded || codexLoaded) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border bg-muted/20 p-3 text-xs">
          <span className="flex items-center gap-1.5 font-medium">
            <Coins className="h-3.5 w-3.5 text-muted-foreground" />
            Your subscription
            <InfoHint label="About subscription plans">
              <p className="mb-2">
                Neither CLI can report its plan automatically, so this is a one-time manual setting.
                It’s used only to phrase the usage hint below — nothing about routing depends on it.
              </p>
              <p>
                Whatever the plan, hitting a usage window mid-run is safe: the run pauses itself and
                resumes exactly where it stopped.
              </p>
            </InfoHint>
          </span>

          {ccLoaded && (
            <label className="flex items-center gap-1.5">
              <span className="text-muted-foreground">Claude Code</span>
              <select
                className="rounded-md border bg-background px-1.5 py-0.5"
                value={plans.claudeCodePlan}
                disabled={savingPlan}
                onChange={(e) =>
                  void savePlan({ claudeCodePlan: e.target.value as PlanState['claudeCodePlan'] })
                }
              >
                {(Object.keys(CC_PLAN_LABELS) as Array<PlanState['claudeCodePlan']>).map((k) => (
                  <option key={k} value={k}>
                    {CC_PLAN_LABELS[k]}
                  </option>
                ))}
              </select>
            </label>
          )}
          {codexLoaded && (
            <label className="flex items-center gap-1.5">
              <span className="text-muted-foreground">Codex</span>
              <select
                className="rounded-md border bg-background px-1.5 py-0.5"
                value={plans.codexPlan}
                disabled={savingPlan}
                onChange={(e) => void savePlan({ codexPlan: e.target.value as PlanState['codexPlan'] })}
              >
                {(Object.keys(CODEX_PLAN_LABELS) as Array<PlanState['codexPlan']>).map((k) => (
                  <option key={k} value={k}>
                    {CODEX_PLAN_LABELS[k]}
                  </option>
                ))}
              </select>
            </label>
          )}

          {ccLoaded && codexLoaded && (
            <label className="flex items-center gap-1.5">
              <span className="text-muted-foreground">Use for free phases</span>
              <select
                className="rounded-md border bg-background px-1.5 py-0.5"
                value={subTarget}
                onChange={(e) => setSubTarget(e.target.value as SubscriptionTarget)}
              >
                <option value="claudeCode">Claude Code</option>
                <option value="codex">Codex</option>
              </select>
            </label>
          )}
        </div>
      )}

      <div className="space-y-2">
        {rungs.map((rung) => {
          const current = isCurrent(rung.recipe)
          return (
            <div
              key={rung.id}
              className={[
                'rounded-md border p-3 transition-colors',
                !rung.available
                  ? 'bg-muted/20 opacity-60'
                  : current
                    ? 'border-emerald-600/50 bg-emerald-600/5'
                    : rung.recommended
                      ? 'border-arcane/50 bg-arcane/5'
                      : 'bg-card',
              ].join(' ')}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className={rung.recommended ? 'text-arcane' : 'text-muted-foreground'}>
                  {rung.icon}
                </span>
                <span className="text-sm font-medium">{rung.title}</span>

                <span
                  className={[
                    'rounded-full px-2 py-0.5 text-[11px] font-semibold',
                    rung.savingKind === 'baseline'
                      ? 'bg-muted text-muted-foreground'
                      : rung.savingKind === 'free'
                        ? 'bg-emerald-600/15 text-emerald-700 dark:text-emerald-400'
                        : 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
                  ].join(' ')}
                >
                  {rung.savingKind === 'baseline'
                    ? 'baseline'
                    : rung.savingKind === 'free'
                      ? 'no API cost'
                      : `~${rung.savingPct}% cheaper`}
                </span>

                {rung.savingKind === 'measured' && (
                  <span className="rounded-full border border-emerald-600/40 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-400">
                    measured
                  </span>
                )}
                {rung.savingKind === 'estimated' && (
                  <span className="rounded-full border border-border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    estimated
                  </span>
                )}

                {rung.recommended && !current && (
                  <span className="flex items-center gap-1 rounded-full bg-arcane/15 px-2 py-0.5 text-[11px] font-semibold text-arcane">
                    <Star className="h-3 w-3" />
                    Recommended
                  </span>
                )}
                {current && (
                  <span className="rounded-full bg-emerald-600/20 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-400">
                    Current
                  </span>
                )}

                <InfoHint label={`About ${rung.title}`}>{rung.hint}</InfoHint>

                <span className="ml-auto">
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={!rung.available || current}
                    onClick={() => {
                      if (rung.recipe) onApply(rung.recipe, rung.title)
                    }}
                    title={rung.available ? rung.unavailableReason : rung.unavailableReason}
                  >
                    <Check className="h-3 w-3" />
                    {current ? 'Applied' : 'Apply'}
                  </button>
                </span>
              </div>

              <p className="mt-1 text-xs text-muted-foreground">{rung.blurb}</p>

              {rung.caveat && rung.available && (
                <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">{rung.caveat}</p>
              )}
              {!rung.available && rung.unavailableReason && (
                <p className="mt-1 text-xs italic text-muted-foreground">{rung.unavailableReason}</p>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
