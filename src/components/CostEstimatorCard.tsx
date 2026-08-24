import { useEffect, useMemo, useState } from 'react'
import { Coins, Sparkles } from 'lucide-react'
import {
  GEMINI_HYBRID_RECOMMENDED,
  GEMINI_QUALITY_BUDGET_RECOMMENDED,
  GEMINI_ALL_PRO_RECOMMENDED,
} from '@/lib/budgetMode'
import {
  estimateRunCost,
  formatDollars,
  type PhaseRouting,
} from '@/lib/pricing'
import { buildLiveRateResolver, type LiveRateResolver } from '@/lib/liveRates'
import { getOpenRouterCatalogue } from '@/lib/openrouterModelsClient'
import { emitSwitchTab } from '@/lib/appEvents'
import { openPageSection } from '@/components/PageSection'
import type { CloudProvider } from '@/lib/profiles'

type PresetKey = 'cheapest' | 'balanced' | 'bestQuality'

interface PresetDef {
  key: PresetKey
  label: string
  blurb: string
  tradeOffs: string
  /** Recipe is { phase: { model, optional tier } } in the per-provider shape. */
  recommended: Record<string, { tier?: 'paid' | 'free' | 'auto'; model: string }>
}

const GEMINI_PRESETS: PresetDef[] = [
  {
    key: 'cheapest',
    label: 'Cheapest',
    blurb: 'Smart Budget — Free Flash grounding, Paid Pro chronicle, Flash-Lite extras + condense.',
    tradeOffs:
      'Lowest cost. May censor profanity (Flash safety-tuning), short condensed output, noisy/abundant quotes.',
    recommended: GEMINI_HYBRID_RECOMMENDED,
  },
  {
    key: 'balanced',
    label: 'Balanced',
    blurb: 'Quality Budget — Paid Pro for grounding/audit/chronicle/condense, Paid Flash for extras.',
    tradeOffs:
      'About 3× Cheapest. Close to All-Pro in cost (Phase 3 chronicle dominates either way) but saves on the extras-extraction call. Sharper grounding, fewer noisy audit questions, longer condense. Recommended for most sessions.',
    recommended: GEMINI_QUALITY_BUDGET_RECOMMENDED,
  },
  {
    key: 'bestQuality',
    label: 'Best Quality',
    blurb: 'All-Pro — every phase on Paid Pro. Matches the pre-cost-cutting baseline.',
    tradeOffs:
      'Maximum quality, maximum cost. Pick when the session is unusually important.',
    recommended: GEMINI_ALL_PRO_RECOMMENDED,
  },
]



// Only Gemini has its own preset ladder here. The direct Anthropic and OpenAI
// keys were retired in favour of OpenRouter, whose routings live in the
// routing preset ladder rather than in this estimator.
/** Cost estimator card. Shows live cost for each preset against the
 *  current transcript + KB sizes for the ACTIVE provider. Clicking a
 *  preset row applies its routing to the server. */
export function CostEstimatorCard(props: {
  transcriptChars: number
  kbChars: number
  activePresetKey?: PresetKey | null
}) {

  // Live rates from the OpenRouter catalogue — the price authority for
  // both OpenRouter AND Gemini estimates (operator decision, 2026-08-19).
  // Null until the cached catalogue loads; estimates fall back to the
  // static tables until then.
  const [liveRates, setLiveRates] = useState<LiveRateResolver | null>(null)
  useEffect(() => {
    let cancelled = false
    getOpenRouterCatalogue()
      .then((r) => {
        if (!cancelled) setLiveRates(buildLiveRateResolver(r.models))
      })
      .catch(() => {
        /* offline: static rates */
      })
    return () => { cancelled = true }
  }, [])

  const presets = GEMINI_PRESETS
  const providerLabel = 'Gemini'
  const providerArticle = 'a'

  const estimates = useMemo(() => {
    if (props.transcriptChars === 0) return null
    return presets.map((preset) => {
      const routing: Record<string, PhaseRouting> = {}
      // These are GEMINI recipes (the heading says so) — price them as
      // Gemini regardless of the active provider. Pricing them under the
      // active provider made every preset read $0.0000 for anyone running
      // Claude Code or Codex, because subscription providers price at $0.
      const provider: CloudProvider = 'gemini'
      for (const [phase, rec] of Object.entries(preset.recommended)) {
        const phaseId = phaseShortToId(phase)
        if (!phaseId) continue
        routing[phaseId] = {
          provider,
          tier: rec.tier,
          model: rec.model,
        }
      }
      const cost = estimateRunCost({
        liveRates,
        routing,
        transcriptChars: props.transcriptChars,
        kbChars: props.kbChars,
      })
      return { preset, cost }
    })
  }, [props.transcriptChars, props.kbChars, presets, liveRates])

  /** The estimator is read-only. A component named for estimating that
   *  silently rewired the pipeline from the Chronicle tab was the trap;
   *  changing the plan happens where plans live, in Settings. */
  function goToPlans() {
    emitSwitchTab('settings')
    requestAnimationFrame(() => openPageSection('providers'))
  }

  if (props.transcriptChars === 0) {
    return (
      <div className="rounded-md border border-border bg-card/40 p-4">
        <h3 className="flex items-center gap-2 font-display text-sm uppercase tracking-wider">
          <Coins className="h-4 w-4" />
          Cost estimator
        </h3>
        <p className="mt-2 text-xs text-muted-foreground">
          Load a transcript to see cost estimates per preset.
        </p>
      </div>
    )
  }

  return (
    <div className="rounded-md border border-border bg-card/40 p-4">
      <h3 className="flex items-center gap-2 font-display text-sm uppercase tracking-wider">
        <Coins className="h-4 w-4" />
        Cost estimator — pick {providerArticle} {providerLabel} routing preset
      </h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Estimates for this transcript ({Math.round(props.transcriptChars / 1000)} KB) +
        lore ({Math.round(props.kbChars / 1000)} KB). Heuristic — actual cost may differ
        by ~10-20% depending on prompt-cache hit rate.
      </p>
      <div className="mt-3 space-y-2">
        {estimates?.map(({ preset, cost }) => {
          const isActive = props.activePresetKey === preset.key
          return (
            <div
              key={preset.key}
              className={`w-full rounded-md border p-3 text-left ${
                isActive ? 'border-primary bg-primary/5' : 'border-border bg-background/50'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-display text-sm font-semibold">{preset.label}</span>
                    {preset.key === 'balanced' && (
                      <span className="rounded-full bg-primary/20 px-2 py-0.5 text-[10px] uppercase tracking-wider text-primary">
                        Recommended
                      </span>
                    )}
                    {isActive && (
                      <span className="rounded-full bg-accent px-2 py-0.5 text-[10px] uppercase tracking-wider">
                        Active
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{preset.blurb}</p>
                  <p className="mt-1 text-[11px] italic text-muted-foreground/80">
                    {preset.tradeOffs}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <div className="font-display text-lg font-semibold text-primary">
                    {formatDollars(cost.totalDollars)}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    ≈ {Math.round(cost.totalInputTokens / 1000)}k in /{' '}
                    {Math.round(cost.totalOutputTokens / 1000)}k out
                  </div>
                </div>
              </div>
            </div>
          )
        })}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        <Sparkles className="mr-1 inline h-3 w-3" />
        These are estimates for comparison.{' '}
        <button
          type="button"
          onClick={goToPlans}
          className="font-medium text-primary underline-offset-2 hover:underline"
        >
          Change the plan in Settings →
        </button>
      </p>
    </div>
  )
}

function phaseShortToId(phase: string): string | null {
  switch (phase) {
    case 'phase1': return 'phase1_ground'
    case 'phase2': return 'phase2_audit'
    case 'phase3': return 'phase3_chronicle'
    case 'phase4': return 'phase4_extras'
    case 'phase6': return 'phase6_condense'
    default: return null
  }
}
