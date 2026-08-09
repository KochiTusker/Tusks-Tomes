import { useEffect, useMemo, useState } from 'react'
import { Coins, Sparkles, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  GEMINI_HYBRID_RECOMMENDED,
  GEMINI_QUALITY_BUDGET_RECOMMENDED,
  GEMINI_ALL_PRO_RECOMMENDED,
  buildGeminiSmartBudgetPerPhase,
  buildGeminiQualityBudgetPerPhase,
  buildGeminiAllProPerPhase,
  CLAUDE_CHEAPEST_RECOMMENDED,
  CLAUDE_BALANCED_RECOMMENDED,
  CLAUDE_BEST_RECOMMENDED,
  buildClaudeCheapestPerPhase,
  buildClaudeBalancedPerPhase,
  buildClaudeBestPerPhase,
  OPENAI_CHEAPEST_RECOMMENDED,
  OPENAI_BALANCED_RECOMMENDED,
  OPENAI_BEST_RECOMMENDED,
  buildOpenAICheapestPerPhase,
  buildOpenAIBalancedPerPhase,
  buildOpenAIBestPerPhase,
} from '@/lib/budgetMode'
import {
  estimateRunCost,
  formatPounds,
  type PhaseRouting,
} from '@/lib/pricing'
import { putRouting, getRouting, type RoutingDocument } from '@/lib/routing'
import type { CloudProvider } from '@/lib/profiles'

type PresetKey = 'cheapest' | 'balanced' | 'bestQuality'

interface PresetDef {
  key: PresetKey
  label: string
  blurb: string
  tradeOffs: string
  /** Recipe is { phase: { model, optional tier } } in the per-provider shape. */
  recommended: Record<string, { tier?: 'paid' | 'free' | 'auto'; model: string }>
  /** Builder that produces the routing.perPhase entry shape when applied. */
  build: (p: CloudProvider) => NonNullable<RoutingDocument['perPhase']> | null
}

const GEMINI_PRESETS: PresetDef[] = [
  {
    key: 'cheapest',
    label: 'Cheapest',
    blurb: 'Smart Budget — Free Flash grounding, Paid Pro chronicle, Flash-Lite extras + condense.',
    tradeOffs:
      'Lowest cost. May censor profanity (Flash safety-tuning), short condensed output, noisy/abundant quotes.',
    recommended: GEMINI_HYBRID_RECOMMENDED,
    build: buildGeminiSmartBudgetPerPhase,
  },
  {
    key: 'balanced',
    label: 'Balanced',
    blurb: 'Quality Budget — Paid Pro for grounding/audit/chronicle/condense, Paid Flash for extras.',
    tradeOffs:
      'About 3× Cheapest. Close to All-Pro in cost (Phase 3 chronicle dominates either way) but saves on the extras-extraction call. Sharper grounding, fewer noisy audit questions, longer condense. Recommended for most sessions.',
    recommended: GEMINI_QUALITY_BUDGET_RECOMMENDED,
    build: buildGeminiQualityBudgetPerPhase,
  },
  {
    key: 'bestQuality',
    label: 'Best Quality',
    blurb: 'All-Pro — every phase on Paid Pro. Matches the pre-cost-cutting baseline.',
    tradeOffs:
      'Maximum quality, maximum cost. Pick when the session is unusually important.',
    recommended: GEMINI_ALL_PRO_RECOMMENDED,
    build: buildGeminiAllProPerPhase,
  },
]

const CLAUDE_PRESETS: PresetDef[] = [
  {
    key: 'cheapest',
    label: 'Cheapest',
    blurb: 'Haiku grounding/audit/extras/condense, Sonnet chronicle.',
    tradeOffs:
      'Lowest Claude cost. Chronicle holds via Sonnet. Condense on Haiku may undershoot length targets.',
    recommended: CLAUDE_CHEAPEST_RECOMMENDED,
    build: buildClaudeCheapestPerPhase,
  },
  {
    key: 'balanced',
    label: 'Balanced',
    blurb: 'Haiku grounding/audit/extras, Sonnet chronicle + condense.',
    tradeOffs:
      'Sonnet on the two prose-critical phases, Haiku elsewhere. Best balance for most sessions.',
    recommended: CLAUDE_BALANCED_RECOMMENDED,
    build: buildClaudeBalancedPerPhase,
  },
  {
    key: 'bestQuality',
    label: 'Best Quality',
    blurb: 'Opus chronicle + condense, Sonnet grounding/audit, Haiku extras.',
    tradeOffs:
      'Opus on the load-bearing creative phases. Highest Claude cost; for sessions that warrant the splurge.',
    recommended: CLAUDE_BEST_RECOMMENDED,
    build: buildClaudeBestPerPhase,
  },
]

const OPENAI_PRESETS: PresetDef[] = [
  {
    key: 'cheapest',
    label: 'Cheapest',
    blurb: 'gpt-5-nano grounding/audit/extras, gpt-5-mini chronicle + condense.',
    tradeOffs:
      'Lowest OpenAI cost. Mini holds chronicle quality; nano handles structured extraction fine.',
    recommended: OPENAI_CHEAPEST_RECOMMENDED,
    build: buildOpenAICheapestPerPhase,
  },
  {
    key: 'balanced',
    label: 'Balanced',
    blurb: 'gpt-5-mini grounding/audit/extras, gpt-5 chronicle + condense.',
    tradeOffs:
      'gpt-5 on prose-critical phases, mini for the mechanical work. Best balance.',
    recommended: OPENAI_BALANCED_RECOMMENDED,
    build: buildOpenAIBalancedPerPhase,
  },
  {
    key: 'bestQuality',
    label: 'Best Quality',
    blurb: 'gpt-5 grounding/audit/chronicle/condense, gpt-5-nano extras.',
    tradeOffs:
      'gpt-5 everywhere except extras. Highest OpenAI cost; matches "everything on the flagship".',
    recommended: OPENAI_BEST_RECOMMENDED,
    build: buildOpenAIBestPerPhase,
  },
]

function presetsForProvider(p: CloudProvider | null): PresetDef[] {
  if (p === 'claude') return CLAUDE_PRESETS
  if (p === 'openai') return OPENAI_PRESETS
  return GEMINI_PRESETS // default
}

/** Cost estimator card. Shows live cost for each preset against the
 *  current transcript + KB sizes for the ACTIVE provider. Clicking a
 *  preset row applies its routing to the server. */
export function CostEstimatorCard(props: {
  transcriptChars: number
  kbChars: number
  activePresetKey?: PresetKey | null
  onApplied?: () => void
}) {
  const [applying, setApplying] = useState<PresetKey | null>(null)
  const [activeProvider, setActiveProvider] = useState<CloudProvider | null>(null)

  // Detect active provider from routing.json on mount and on routing changes.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const r = await getRouting()
        if (!cancelled) setActiveProvider(r.lastSelectedProvider)
      } catch {
        // Silent — estimator falls back to Gemini if we can't read routing
      }
    })()
    return () => { cancelled = true }
  }, [])

  const presets = useMemo(() => presetsForProvider(activeProvider), [activeProvider])
  const providerLabel = activeProvider === 'claude' ? 'Claude' : activeProvider === 'openai' ? 'OpenAI' : 'Gemini'
  // "a Gemini" / "a Claude" / "an OpenAI" — grammar polish for the heading
  const providerArticle = activeProvider === 'openai' ? 'an' : 'a'

  const estimates = useMemo(() => {
    if (props.transcriptChars === 0) return null
    return presets.map((preset) => {
      const routing: Record<string, PhaseRouting> = {}
      const provider: CloudProvider = activeProvider ?? 'gemini'
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
        routing,
        transcriptChars: props.transcriptChars,
        kbChars: props.kbChars,
      })
      return { preset, cost }
    })
  }, [props.transcriptChars, props.kbChars, presets, activeProvider])

  async function applyPreset(preset: PresetDef) {
    try {
      setApplying(preset.key)
      const provider: CloudProvider = activeProvider ?? 'gemini'
      const perPhase = preset.build(provider)
      if (!perPhase) {
        toast.error(`This preset is not available for ${providerLabel}.`)
        return
      }
      const current = await getRouting()
      await putRouting({
        version: 3,
        lastSelectedProvider: current.lastSelectedProvider ?? provider,
        geminiTier: current.geminiTier,
        perPhase,
      })
      toast.success(`${providerLabel} ${preset.label} routing applied. ${preset.blurb}`, { duration: 7000 })
      props.onApplied?.()
    } catch (err) {
      toast.error(`Could not apply preset: ${(err as Error).message}`)
    } finally {
      setApplying(null)
    }
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
          const isApplying = applying === preset.key
          return (
            <button
              key={preset.key}
              type="button"
              onClick={() => applyPreset(preset)}
              disabled={applying !== null}
              className={`w-full rounded-md border p-3 text-left transition hover:bg-accent/30 ${
                isActive ? 'border-primary bg-primary/5' : 'border-border bg-background/50'
              } ${applying !== null && !isApplying ? 'opacity-60' : ''}`}
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
                    {formatPounds(cost.totalDollars)}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    ≈ {Math.round(cost.totalInputTokens / 1000)}k in /{' '}
                    {Math.round(cost.totalOutputTokens / 1000)}k out
                  </div>
                  {isApplying && (
                    <Loader2 className="ml-auto mt-1 h-3 w-3 animate-spin text-primary" />
                  )}
                </div>
              </div>
            </button>
          )
        })}
      </div>
      <p className="mt-3 text-[10px] text-muted-foreground/70">
        <Sparkles className="mr-1 inline h-3 w-3" />
        For finer control, use Settings → Hybrid Routing to mix providers per phase manually.
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
