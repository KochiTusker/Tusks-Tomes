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
