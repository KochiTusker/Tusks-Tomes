// A reforge finishing used to switch the app to the Chronicle tab no matter
// where the user was, which threw away whatever they were doing there. The
// decision now lives in one pure helper so the rule is stated once and
// pinned here: switch only when already on Chronicle, offer otherwise.

import { describe, expect, it } from 'vitest'
import { CHRONICLE_TAB, shouldSwitchToChronicle } from '../../../platform/lib/appEvents'

describe('shouldSwitchToChronicle', () => {
  it('switches when the user is already on the Chronicle tab', () => {
    expect(shouldSwitchToChronicle(CHRONICLE_TAB)).toBe(true)
    // The literal App.tsx uses, so a rename of either side fails here.
    expect(shouldSwitchToChronicle('refinement')).toBe(true)
  })

  it.each(['sessions', 'kb', 'settings', 'help'])(
    'leaves the user where they are on the %s tab',
    (tab) => {
      expect(shouldSwitchToChronicle(tab)).toBe(false)
    },
  )

  it('treats an unknown or empty tab value as somewhere else', () => {
    expect(shouldSwitchToChronicle('')).toBe(false)
    expect(shouldSwitchToChronicle('upload')).toBe(false)
  })
})
