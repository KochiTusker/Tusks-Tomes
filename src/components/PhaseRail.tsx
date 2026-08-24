// The phase rail — one component that answers "which model runs each phase".
//
// It renders in two states from the same markup:
//   - at rest, on the Chronicle tab, before a run: every rung idle, showing
//     the resolved model per phase so the cost of pressing Run is knowable
//     before committing;
//   - live, inside the run view: the active rung lit with chunk progress,
//     completed rungs showing elapsed time.
//
// Making configuration and progress visibly the same object is the point:
// what you set up in Settings is what you watch run, so there is no
// verification step in between, and a phase that differs from the plan is
// information on the rail rather than a warning banner.
//
// The rail RENDERS resolution — it never computes it. sessions.ts is the
// single resolver; this reads RunSession.phases verbatim. A null session is
// the first-run signal (no cloud key configured).

import { useCallback, useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { autoResolveSession, type ResolvedPhaseConfig, type RunSession } from '@/lib/sessions'
import { ACTIVE_PROVIDER_CHANGED_EVENT, emitSwitchTab } from '@/lib/appEvents'
import { openPageSection } from '@/components/PageSection'
import { PROVIDERS_CHANGED_EVENT } from '@/lib/providers'

export type RailPhaseKey = 'phase1' | 'phase2' | 'phase3' | 'phase4' | 'phase5' | 'phase6'

// EXECUTION order, not numeric order: Polish (5) runs between Chronicle
// and Extras so the extras are extracted from the polished chronicle.
// The rail must match what the run will actually do, or the "same object
// at rest and in use" promise breaks the first time someone watches it.
const RAIL_PHASES: Array<{ key: RailPhaseKey; ordinal: string; name: string }> = [
  { key: 'phase1', ordinal: 'Phase 1', name: 'Ground' },
  { key: 'phase2', ordinal: 'Phase 2', name: 'Audit' },
  { key: 'phase3', ordinal: 'Phase 3', name: 'Chronicle' },
  { key: 'phase5', ordinal: 'Phase 5', name: 'Polish' },
  { key: 'phase4', ordinal: 'Phase 4', name: 'Extras' },
  { key: 'phase6', ordinal: 'Phase 6', name: 'Condense' },
]

/** Short human label for where a phase's calls go. */
function providerShort(cfg: ResolvedPhaseConfig): string {
  if (cfg.phaseTarget.target === 'local') return 'Local'
  switch (cfg.cloudProvider) {
    case 'gemini':
      return cfg.geminiTier === 'free' ? 'Gemini Free' : 'Gemini'
    case 'claudeCode':
      return 'Claude Code'
    case 'codex':
      return 'Codex'
    case 'openrouter':
      return 'OpenRouter'
    default:
      return cfg.cloudProvider ?? '—'
  }
}

/** Trim vendor prefixes so the rung stays readable: keep the last path
 *  segment of OpenRouter ids ("deepseek/deepseek-v4-pro" → "deepseek-v4-pro"). */
function modelShort(modelId: string): string {
  const slash = modelId.lastIndexOf('/')
  return slash >= 0 ? modelId.slice(slash + 1) : modelId
}

export type RailLiveState = {
  /** The phase currently running, if any. */
  activePhase?: RailPhaseKey | null
  /** Phases already finished this run, with an optional note ("2m 10s"). */
  done?: Partial<Record<RailPhaseKey, string>>
  /** Note shown on the active rung ("chunk 4 of 11"). */
  activeNote?: string
  /** Phases this run will not execute (e.g. Condense when the user didn't
   *  ask for a condensed output). */
  skipped?: Partial<Record<RailPhaseKey, string>>
}

export function PhaseRail({
  session,
  live,
  className,
  showCustomChips = false,
  onSelectPhase,
}: {
  session: RunSession
  live?: RailLiveState
  className?: string
  /** When set, rungs render as buttons and clicking one hands the phase
   *  key to the caller — the idle preview uses this to jump into the
   *  routing surface in Settings. Live run views leave it unset. */
  onSelectPhase?: (phase: RailPhaseKey) => void
  /** `override` in sessions.ts means "explicitly pinned rather than
   *  inherited from the provider profile" — after applying a preset that
   *  pins all phases, every rung is technically an override, so at rest
   *  the chip would be pure noise. Off until a caller can compare against
   *  the applied plan instead. */
  showCustomChips?: boolean
}) {
  return (
    <div
      className={cn('flex gap-1.5 overflow-x-auto max-sm:flex-wrap max-sm:overflow-x-visible', className)}
      role="list"
      aria-label="Pipeline phases and the model running each"
    >
      {RAIL_PHASES.map(({ key, ordinal, name }) => {
        // Phase 5 (Polish) is not routable — routing.json has no phase5
        // entry by design. It runs only when the prose phases run on a
        // local model; on cloud runs it is skipped.
        const isPolish = key === 'phase5'
        const cfg = isPolish ? null : session.phases[key as Exclude<RailPhaseKey, 'phase5'>]
        const polishRuns = session.phases.phase3.phaseTarget.target === 'local'

        const doneNote = live?.done?.[key]
        const isActive = live?.activePhase === key
        const skipNote = live?.skipped?.[key]

        const Tag = onSelectPhase ? 'button' : 'div'
        return (
          <Tag
            key={key}
            {...(onSelectPhase
              ? {
                  type: 'button' as const,
                  onClick: () => onSelectPhase(key),
                  title: 'Change which model runs this phase',
                }
              : {})}
            role="listitem"
            className={cn(
              'phase-rung min-w-[8.5rem] flex-1 rounded-b-md border border-border/70 border-t-2 bg-card/50 px-2.5 py-2 text-left',
              onSelectPhase && 'cursor-pointer hover:border-primary/50 hover:bg-primary/5',
              isActive
                ? 'phase-rung-active border-t-primary bg-primary/10'
                : doneNote
                  ? 'border-t-green-500/70'
                  : 'border-t-border',
              (isPolish && !polishRuns) || skipNote ? 'opacity-60' : '',
            )}
          >
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {ordinal}
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className="text-sm font-semibold">{name}</span>
              {showCustomChips && !isPolish && cfg?.override && (
                <span
                  className="rounded bg-arcane/15 px-1 py-px text-[9px] font-medium uppercase tracking-wide text-arcane"
                  title="This phase deviates from the plan's default"
                >
                  Custom
                </span>
              )}
            </div>
            {isPolish ? (
              <div className="truncate font-mono text-[11px] text-muted-foreground" title="Polish only runs when the prose phases run on a local model">
                {polishRuns ? 'local model' : 'local runs only'}
              </div>
            ) : (
              <div
                className="truncate font-mono text-[11px] text-foreground/80"
                title={cfg ? `${providerShort(cfg)} · ${cfg.model}` : undefined}
              >
                {cfg ? modelShort(cfg.model) : '—'}
              </div>
            )}
            <div
              className={cn(
                'truncate text-[11px]',
                isActive ? 'font-medium text-primary' : 'text-muted-foreground',
              )}
            >
              {isActive
                ? (live?.activeNote ?? 'running…')
                : doneNote
                  ? `done · ${doneNote}`
                  : skipNote
                    ? skipNote
                    : isPolish
                      ? (polishRuns ? 'queued' : 'skipped')
                      : (cfg ? providerShort(cfg) : '')}
            </div>
          </Tag>
        )
      })}
    </div>
  )
}

/**
 * Read-only session resolution for preview surfaces (the idle rail, the
 * Run button's estimate). dryRun always — previewing must never write
 * routing.json. Re-resolves when the effective provider or a key changes.
 */
export function useSessionPreview(): { session: RunSession | null; resolved: boolean } {
  const [session, setSession] = useState<RunSession | null>(null)
  const [resolved, setResolved] = useState(false)

  const load = useCallback(() => {
    let cancelled = false
    autoResolveSession({ dryRun: true })
      .then((s) => {
        if (!cancelled) setSession(s)
      })
      .catch(() => {
        if (!cancelled) setSession(null)
      })
      .finally(() => {
        if (!cancelled) setResolved(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const cancel = load()
    const onChange = () => void load()
    window.addEventListener(ACTIVE_PROVIDER_CHANGED_EVENT, onChange)
    window.addEventListener(PROVIDERS_CHANGED_EVENT, onChange)
    return () => {
      cancel()
      window.removeEventListener(ACTIVE_PROVIDER_CHANGED_EVENT, onChange)
      window.removeEventListener(PROVIDERS_CHANGED_EVENT, onChange)
    }
  }, [load])

  return { session, resolved }
}

/** The idle-preview door: jump to Settings with the routing surface open. */
export function openRoutingSurface() {
  emitSwitchTab('settings')
  openPageSection('providers')
  requestAnimationFrame(() => {
    const el = document.getElementById('hybrid-routing')
    if (el instanceof HTMLDetailsElement) el.open = true
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  })
}
