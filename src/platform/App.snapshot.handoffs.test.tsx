// @vitest-environment jsdom

// Characterisation of the cross-tab hand-offs and the Caption Repair flow.
// Companion to App.snapshot.test.tsx; same rules: golden snapshots of what a
// user can see and operate, no class names, no markup structure.
//
// Covered:
//   - `sbts:load-transcript` (text, .sbv text, empty detail) from another tab
//   - Sessions "Send to Refinement" through the real button
//   - `sbts:open-doc` from Chronicle and from Help, and picking a doc by hand
//   - `sbts:switch-tab`, including the retired tab names it still resolves
//   - Caption Repair: loading a synthetic .sbv shows the parsed cue summary
//     before any AI call; nothing reaches a provider

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, screen } from '@testing-library/react'
import {
  installScenario,
  mountApp,
  settle,
  snap,
  toastsSeen,
  type Scenario,
} from '@/platform/__ui_golden__/harness'
import { SBV_TEXT } from '@/platform/__ui_golden__/fixtures'

vi.mock('sonner', async () => (await import('@/platform/__ui_golden__/sonnerMock')).sonnerMock)

type Mounted = Awaited<ReturnType<typeof mountApp>>

let scenario: Scenario
let app: Mounted | null = null

afterEach(() => {
  app?.unmount()
  app = null
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function boot(
  opts: { audio: boolean; populated: boolean } = { audio: true, populated: true },
  tweak?: (routes: Scenario['routes']) => void,
) {
  scenario = installScenario(opts)
  tweak?.(scenario.routes)
  app = await mountApp(scenario)
  scenario.take()
}

function visiblePanel(): Element {
  const panels = Array.from(document.querySelectorAll('[role="tabpanel"]')).filter(
    (p) => !p.hasAttribute('hidden'),
  )
  expect(panels).toHaveLength(1)
  return panels[0]
}

function tabStrip(): string {
  return snap(document.querySelector('[role="tablist"]'))
}

async function goTo(name: string): Promise<void> {
  await app!.user.click(screen.getByRole('tab', { name }))
  await settle(scenario)
}

async function dispatch(name: string, detail?: unknown): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new CustomEvent(name, detail === undefined ? undefined : { detail }))
  })
  await settle(scenario)
}

/** What the persisted Chronicle state looks like, minus the clock. */
function storedRefinement(): string {
  const raw = localStorage.getItem('refinement_state')
  if (!raw) return '(nothing stored)'
  const parsed = JSON.parse(raw) as Record<string, unknown>
  if (typeof parsed.updatedAt === 'string') parsed.updatedAt = '<iso>'
  return JSON.stringify(parsed, null, 2)
}

function transcriptBox(): HTMLTextAreaElement {
  return screen.getByRole('textbox', { name: 'Raw transcript' }) as HTMLTextAreaElement
}

function assertClean(): void {
  expect(scenario.unmatched, 'requests with no fixture').toEqual([])
}

function sbvFile(name = 'session-fixture.sbv', text = SBV_TEXT): File {
  return new File([text], name, { type: 'text/plain' })
}

describe('sbts:load-transcript', () => {
  it('plain text sent from the Tome of Lore tab opens Chronicle with it loaded', async () => {
    await boot()
    await goTo('Tome of Lore')
    await dispatch('sbts:load-transcript', { text: 'PC-Alpha: We reach Place-Delta.\nDM: The gates stand open.' })
    expect.soft(tabStrip()).toMatchSnapshot('tab strip')
    expect.soft(transcriptBox().value).toMatchSnapshot('transcript box value')
    expect.soft(snap(visiblePanel())).toMatchSnapshot('Chronicle panel')
    expect.soft(storedRefinement()).toMatchSnapshot('stored chronicle state')
    expect.soft(toastsSeen()).toMatchSnapshot('toasts')
    assertClean()
  })

  it('.sbv text is stripped of timestamps on the way in', async () => {
    await boot()
    await goTo('Settings')
    await dispatch('sbts:load-transcript', { text: SBV_TEXT })
    expect.soft(tabStrip()).toMatchSnapshot('tab strip')
    expect.soft(transcriptBox().value).toMatchSnapshot('transcript box value')
    expect.soft(storedRefinement()).toMatchSnapshot('stored chronicle state')
    assertClean()
  })

  it('an event with no text only switches to Chronicle', async () => {
    await boot()
    await goTo('Help')
    await dispatch('sbts:load-transcript', {})
    expect.soft(tabStrip()).toMatchSnapshot('tab strip')
    expect.soft(transcriptBox().value).toBe('')
    expect.soft(storedRefinement()).toMatchSnapshot('stored chronicle state')
    assertClean()
  })

  it('the Sessions "Send to Refinement" button hands the session transcript to Chronicle', async () => {
    await boot()
    await goTo('Sessions')
    const before = scenario.take()
    expect.soft(before).toMatchSnapshot('requests on opening Sessions')
    await app!.user.click(screen.getByRole('button', { name: 'Send to Refinement' }))
    await settle(scenario)
    expect.soft(scenario.take().join('\n')).toMatchSnapshot('requests made by the button')
    expect.soft(tabStrip()).toMatchSnapshot('tab strip')
    expect.soft(transcriptBox().value).toMatchSnapshot('transcript box value')
    expect.soft(snap(visiblePanel())).toMatchSnapshot('Chronicle panel')
    expect.soft(storedRefinement()).toMatchSnapshot('stored chronicle state')
    expect.soft(toastsSeen()).toMatchSnapshot('toasts')
    assertClean()
  })
})

describe('sbts:open-doc', () => {
  it('dispatched from Chronicle opens the Help tab', async () => {
    await boot()
    await dispatch('sbts:open-doc', { slug: 'docs-modules-audio-transcription' })
    expect.soft(tabStrip()).toMatchSnapshot('tab strip')
    expect.soft(snap(visiblePanel())).toMatchSnapshot('Help panel')
    expect.soft(scenario.take().join('\n')).toMatchSnapshot('requests')
    assertClean()
  })

  it('dispatched while Help is already showing loads that document', async () => {
    await boot()
    await goTo('Help')
    scenario.take()
    await dispatch('sbts:open-doc', { slug: 'docs-modules-audio-transcription' })
    expect.soft(tabStrip()).toMatchSnapshot('tab strip')
    expect.soft(snap(visiblePanel())).toMatchSnapshot('Help panel')
    expect.soft(scenario.take().join('\n')).toMatchSnapshot('requests')
    assertClean()
  })

  it('the "Read docs" button on the audio add-on row opens its page', async () => {
    await boot({ audio: false, populated: true })
    await goTo('Settings')
    scenario.take()
    await app!.user.click(screen.getByRole('button', { name: 'Read docs' }))
    await settle(scenario)
    expect.soft(tabStrip()).toMatchSnapshot('tab strip')
    expect.soft(snap(visiblePanel())).toMatchSnapshot('Help panel')
    expect.soft(scenario.take().join('\n')).toMatchSnapshot('requests')
    assertClean()
  })

  it('choosing a document from the list shows it, then "All docs" returns to the list', async () => {
    await boot()
    await goTo('Help')
    scenario.take()
    await app!.user.click(screen.getByRole('button', { name: /Quick start/ }))
    await settle(scenario)
    expect.soft(snap(visiblePanel())).toMatchSnapshot('document open')
    expect.soft(scenario.take().join('\n')).toMatchSnapshot('requests')
    await app!.user.click(screen.getByRole('button', { name: 'All docs' }))
    await settle(scenario)
    expect.soft(snap(visiblePanel())).toMatchSnapshot('back at the list')
    assertClean()
  })
})

describe('sbts:switch-tab', () => {
  it('named tabs and retired tab names resolve to where their content lives now', async () => {
    await boot()
    const seen: string[] = []
    for (const tab of ['settings', 'kb', 'upload', 'about', 'captions', 'help', 'no-such-tab']) {
      await dispatch('sbts:switch-tab', { tab })
      const selected = Array.from(document.querySelectorAll('[role="tab"]'))
        .filter((t) => t.getAttribute('aria-selected') === 'true')
        .map((t) => t.textContent?.trim())
      seen.push(`${tab} -> ${selected.join(',')}`)
    }
    expect.soft(seen.join('\n')).toMatchSnapshot('where each value lands')
    assertClean()
  })

  it('"upload" lands on Chronicle when the audio add-on is absent', async () => {
    await boot({ audio: false, populated: true })
    await dispatch('sbts:switch-tab', { tab: 'upload' })
    const selected = Array.from(document.querySelectorAll('[role="tab"]'))
      .filter((t) => t.getAttribute('aria-selected') === 'true')
      .map((t) => t.textContent?.trim())
    expect.soft(selected).toMatchSnapshot('selected tab')
    expect.soft(tabStrip()).toMatchSnapshot('tab strip')
    assertClean()
  })
})

describe('Chronicle transcript input', () => {
  it('loading a .sbv through the Chronicle file input fills the box without timestamps', async () => {
    await boot()
    const input = document.querySelector('input[type="file"][accept=".txt,.sbv,.md"]') as HTMLInputElement
    await app!.user.upload(input, sbvFile())
    await settle(scenario)
    expect.soft(transcriptBox().value).toMatchSnapshot('transcript box value')
    expect.soft(snap(visiblePanel())).toMatchSnapshot('Chronicle panel')
    expect.soft(toastsSeen()).toMatchSnapshot('toasts')
    assertClean()
  })

  it('pasting text enables the run button and shows the estimated cost', async () => {
    await boot()
    await app!.user.click(transcriptBox())
    await app!.user.paste('PC-Alpha: We reach Place-Delta.\nDM: The gates stand open.')
    await settle(scenario)
    expect.soft(snap(visiblePanel())).toMatchSnapshot('Chronicle panel')
    assertClean()
  })

  it('a non-text file is refused with a message and leaves the box empty', async () => {
    await boot()
    const input = document.querySelector('input[type="file"][accept=".txt,.sbv,.md"]') as HTMLInputElement
    await app!.user.upload(input, new File([new Uint8Array([0, 1, 2, 0, 255, 0, 9, 0])], 'cover.txt', { type: 'text/plain' }))
    await settle(scenario)
    expect.soft(transcriptBox().value).toBe('')
    expect.soft(toastsSeen()).toMatchSnapshot('toasts')
    assertClean()
  })
})

describe('Caption Repair (inside Chronicle)', () => {
  async function openRepair(): Promise<HTMLInputElement> {
    const summary = Array.from(document.querySelectorAll('summary')).find((s) =>
      (s.textContent ?? '').startsWith('Repair a caption file'),
    )!
    await app!.user.click(summary)
    await settle(scenario)
    return document.querySelector('input[type="file"][accept=".sbv"]') as HTMLInputElement
  }

  function repairSection(): Element {
    const summary = Array.from(document.querySelectorAll('summary')).find((s) =>
      (s.textContent ?? '').startsWith('Repair a caption file'),
    )!
    return summary.parentElement!
  }

  it('before any file: the section as the user first opens it', async () => {
    await boot()
    await openRepair()
    expect.soft(snap(repairSection())).toMatchSnapshot('repair section, no file')
    assertClean()
  })

  it('a loaded .sbv shows its parsed cue summary and the repair controls, with no AI call', async () => {
    await boot()
    const input = await openRepair()
    scenario.take()
    await app!.user.upload(input, sbvFile())
    await settle(scenario)
    expect.soft(snap(repairSection())).toMatchSnapshot('repair section, file loaded')
    expect.soft(toastsSeen()).toMatchSnapshot('toasts')
    expect.soft(scenario.take().join('\n')).toMatchSnapshot('requests after loading the file')
    const stored = JSON.parse(localStorage.getItem('sbv_repair_state') ?? 'null') as Record<string, unknown> | null
    if (stored && typeof stored.updatedAt === 'string') stored.updatedAt = '<iso>'
    expect.soft(JSON.stringify(stored, null, 2)).toMatchSnapshot('persisted repair state')
    assertClean()
  })

  it('a file with no timestamp lines is refused', async () => {
    await boot()
    const input = await openRepair()
    await app!.user.upload(input, sbvFile('not-captions.sbv', 'just some prose\nwith no timestamps\n'))
    await settle(scenario)
    expect.soft(snap(repairSection())).toMatchSnapshot('repair section after refusal')
    expect.soft(toastsSeen()).toMatchSnapshot('toasts')
    assertClean()
  })

  it('Reset clears the loaded file', async () => {
    await boot()
    const input = await openRepair()
    await app!.user.upload(input, sbvFile())
    await settle(scenario)
    await app!.user.click(screen.getByRole('button', { name: /Reset/ }))
    await settle(scenario)
    expect.soft(snap(repairSection())).toMatchSnapshot('repair section after reset')
    assertClean()
  })

  it('with an empty knowledge base the section warns about it', async () => {
    // Keys configured (so the section is usable) but no lore documents.
    await boot({ audio: false, populated: true }, (routes) => {
      routes['GET /api/lore/documents'] = {
        body: { found: false, source: 'tusks-lore', notes: ['No lore folder found next to the app.'] },
      }
    })
    const input = await openRepair()
    await app!.user.upload(input, sbvFile())
    await settle(scenario)
    expect.soft(snap(repairSection())).toMatchSnapshot('repair section, empty knowledge base')
    assertClean()
  })
})

describe('render health', () => {
  it('records console output emitted by the hand-off flows', async () => {
    await boot()
    await dispatch('sbts:load-transcript', { text: SBV_TEXT })
    await dispatch('sbts:open-doc', { slug: 'docs-getting-started-quick-start' })
    expect(scenario.consoleErrors).toMatchSnapshot('console errors and warnings')
  })
})
