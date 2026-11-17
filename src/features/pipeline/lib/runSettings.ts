// The subset of {configDir}/settings.json a pipeline run needs, fetched at
// the moment the run starts rather than held in React state.
//
// Read at call time on purpose: a run can begin minutes after the component
// mounted, and the user may have changed a toggle in Settings in between. The
// value that matters is the one in force when the phases actually dispatch.
//
// Shared because more than one surface starts runs — the Chronicle tool and
// Reforge both do, and a setting that only one of them honours is a setting
// whose behaviour depends on which button you pressed.

export type PerPhaseThinking = {
  phase4?: boolean
  phase6?: boolean
}

export type RunSettings = {
  disableThinkingOnGrounding: boolean
  phase1AliasHints: boolean
  reassembleQuotes: boolean
  retrieveVaultKb: boolean
  perPhaseThinking: PerPhaseThinking
  devTestMode: { enabled: boolean; maxChars: number }
}

/** Every optional feature off, matching the server's own defaults. Used when
 *  the fetch fails or times out: a run that cannot read its settings should
 *  behave like a fresh install, not inherit whatever was last seen. */
const FALLBACK: RunSettings = {
  disableThinkingOnGrounding: false,
  phase1AliasHints: false,
  reassembleQuotes: false,
  retrieveVaultKb: false,
  perPhaseThinking: {},
  devTestMode: { enabled: false, maxChars: 24000 },
}

export async function fetchRunSettings(): Promise<RunSettings> {
  try {
    const res = await fetch('/api/settings', { signal: AbortSignal.timeout(2000) })
    if (!res.ok) return FALLBACK
    const body = (await res.json()) as {
      disableThinkingOnGrounding?: boolean
      phase1AliasHints?: boolean
      reassembleQuotes?: boolean
      retrieveVaultKb?: boolean
      perPhaseThinking?: PerPhaseThinking
      devTestMode?: { enabled?: boolean; maxChars?: number }
    }
    return {
      disableThinkingOnGrounding: body.disableThinkingOnGrounding === true,
      phase1AliasHints: body.phase1AliasHints === true,
      reassembleQuotes: body.reassembleQuotes === true,
      retrieveVaultKb: body.retrieveVaultKb === true,
      perPhaseThinking: (body.perPhaseThinking ?? {}) as PerPhaseThinking,
      devTestMode: {
        enabled: body.devTestMode?.enabled === true,
        maxChars: typeof body.devTestMode?.maxChars === 'number' ? body.devTestMode.maxChars : 24000,
      },
    }
  } catch {
    return FALLBACK
  }
}
