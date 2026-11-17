import {
  initialRefinementState,
  type CondenseOutput,
  type DMAnswers,
  type DMQuestion,
  type ExtrasOutput,
  type RefinementState,
} from '@/features/pipeline/lib/types'

// App-wide window events, in one place.
//
// These constants used to be exported by whichever component happened to
// dispatch them first (ACTIVE_PROVIDER_CHANGED_EVENT from ActiveProviderCard,
// SWITCH_TAB_EVENT from ActiveProviderBanner). That coupled every listener to
// a component file's lifetime: deleting or renaming the component would take
// the event constant — and five live listeners — down with it. Events are
// app-level contracts, so they live at the lib level.
//
// Dispatch helpers are exported next to their constants so a grep for the
// helper finds every producer, and a grep for the constant finds every
// consumer.

/** Fired after anything changes which provider/tier the next run will use
 *  (saving the active provider, applying a routing preset). Listeners
 *  re-fetch the providers summary + routing document. */
export const ACTIVE_PROVIDER_CHANGED_EVENT = 'sbts:active-provider-changed'

export function emitActiveProviderChanged() {
  window.dispatchEvent(new CustomEvent(ACTIVE_PROVIDER_CHANGED_EVENT))
}

/** Ask App.tsx to switch tabs. Detail: `{ tab: string }`. */
export const SWITCH_TAB_EVENT = 'sbts:switch-tab'

export function emitSwitchTab(tab: string) {
  window.dispatchEvent(new CustomEvent(SWITCH_TAB_EVENT, { detail: { tab } }))
}

/** Ask App.tsx to open the guided setup wizard. The wizard is mounted at
 *  the app root so any surface (the first-run panel, a future help link)
 *  can open it without owning it. */
export const OPEN_SETUP_WIZARD_EVENT = 'sbts:open-setup-wizard'

export function emitOpenSetupWizard() {
  window.dispatchEvent(new CustomEvent(OPEN_SETUP_WIZARD_EVENT))
}

/**
 * A reforge started or stopped. Detail: `{ running: boolean }`.
 *
 * The panel that runs it is nested two collapsibles deep, and a run takes
 * minutes, so the surfaces above it have to be able to say "something is
 * happening in here" rather than showing their idle selves over a live run.
 * Anything that can hide the panel listens for this.
 */
export const REFORGE_RUNNING_EVENT = 'sbts:reforge-running'

export function emitReforgeRunning(running: boolean) {
  window.dispatchEvent(new CustomEvent(REFORGE_RUNNING_EVENT, { detail: { running } }))
}

/**
 * A reforge finished and its outputs should become the chronicle on screen.
 *
 * Reforge produces a complete artefact — the phases it re-ran, plus the ones
 * it was told to keep — and until this existed that artefact only appeared
 * inside the Reforge panel's own result view. The main Chronicle screen went
 * on showing the superseded extras, which is the wrong answer to "what does
 * this session look like now".
 *
 * Two listeners, deliberately, matching the load-transcript precedent:
 * RefinementTool hydrates when it is mounted (the panel currently sits on the
 * same tab, so it always is), and App.tsx persists to LS_REFINEMENT for the
 * case where it is not. Both derive from this same detail, so whichever runs
 * last writes the same state.
 */
export const REFORGE_COMPLETE_EVENT = 'sbts:reforge-complete'

export type ReforgeCompleteDetail = {
  campaign: string
  sessionNumber: number
  chronicle: string
  /** Merged: freshly reforged where a phase was re-run, carried over where it
   *  was kept. Never the bare delta — see ReforgePanel. */
  extras: ExtrasOutput | null
  condensed: CondenseOutput | null
  groundedTranscript: string
  dmQuestions: DMQuestion[]
  dmAnswers: DMAnswers
  /** The NEW library entry this reforge saved, so later edits update that
   *  record rather than the original the reforge was built from. */
  savedChronicleId?: string
}

export function emitReforgeComplete(detail: ReforgeCompleteDetail) {
  window.dispatchEvent(new CustomEvent(REFORGE_COMPLETE_EVENT, { detail }))
}

/**
 * The refinement state a finished reforge becomes.
 *
 * Two listeners consume the event — App.tsx, which persists for a Chronicle
 * tab that may not be mounted, and RefinementTool, which hydrates its own
 * state — and both must land on the same object. It is built here, once, so
 * they cannot drift. Everything the detail does not carry resets: a reforge
 * has no raw transcript, no refusals and no run in progress, and carrying
 * those over from the previous run would pin them to a chronicle they never
 * belonged to.
 */
export function refinementStateFromReforge(
  d: ReforgeCompleteDetail,
  updatedAt: string = new Date().toISOString(),
): RefinementState {
  return {
    ...initialRefinementState,
    campaign: d.campaign,
    sessionNumber: d.sessionNumber,
    groundedTranscript: d.groundedTranscript,
    dmQuestions: d.dmQuestions,
    dmAnswers: d.dmAnswers,
    chronicle: d.chronicle,
    extras: d.extras,
    condensed: d.condensed,
    // 'done' is what gates the ChronicleView render.
    status: 'done',
    // Point at the entry the reforge just saved. Left on the original id, a
    // later edit here would rewrite the record this was reforged FROM.
    savedChronicleId: d.savedChronicleId,
    updatedAt,
  }
}

/** The tab the Chronicle screen lives on, as App.tsx names it. */
export const CHRONICLE_TAB = 'refinement'

/**
 * Whether a reforge finishing should move the user to the Chronicle tab.
 *
 * A reforge runs for minutes, and people use that time: they go and upload
 * the next session, or edit the glossary. Yanking them back to Chronicle the
 * moment it finishes threw away whatever they were in the middle of — a
 * half-staged upload, a form field — for a result that was already persisted
 * and would still be there when they chose to look. So the switch only
 * happens when the user is already on Chronicle (where it is a no-op that
 * refreshes the view); anywhere else the caller offers the switch instead of
 * performing it.
 */
export function shouldSwitchToChronicle(activeTab: string): boolean {
  return activeTab === CHRONICLE_TAB
}

/** The OpenRouter catalogue was force-refreshed and came back with models.
 *  Several surfaces show it (the routing editor, the model browser, the Claude
 *  Code slot which is derived from it), and any of them can trigger the
 *  refresh, so each listens rather than trusting its own copy. */
export const CATALOGUE_REFRESHED_EVENT = 'sbts:catalogue-refreshed'

export function emitCatalogueRefreshed() {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(CATALOGUE_REFRESHED_EVENT))
}
