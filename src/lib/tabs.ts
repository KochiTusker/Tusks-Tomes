// Tab identity, in one place.
//
// The navigation went from eight tabs to five; the VALUES of the surviving
// tabs are unchanged so nothing persisted or dispatched breaks, and the
// retired values are mapped forward here. Every SWITCH_TAB_EVENT payload
// passes through resolveTabValue before use — so a dispatcher we missed
// (or an old bookmark of muscle memory) lands somewhere sensible instead
// of on a tab that no longer exists.

export const TAB_VALUES = ['refinement', 'kb', 'sessions', 'settings', 'help'] as const
export type TabValue = (typeof TAB_VALUES)[number]

/** Retired tab → where its content lives now. */
const LEGACY_TABS: Record<string, TabValue> = {
  // Upload became the primary action at the top of Sessions.
  upload: 'sessions',
  // About lives at the bottom of Help.
  about: 'help',
  // Caption repair is an action on a transcript, on the Chronicle tab.
  captions: 'refinement',
}

export function resolveTabValue(tab: string): TabValue {
  if ((TAB_VALUES as readonly string[]).includes(tab)) return tab as TabValue
  return LEGACY_TABS[tab] ?? 'refinement'
}
