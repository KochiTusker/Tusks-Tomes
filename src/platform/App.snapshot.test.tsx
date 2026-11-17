// @vitest-environment jsdom

// Characterisation of the user interface before a large refactor. Every
// assertion here is a golden snapshot of what a user can see and operate, in
// a normalised text form (src/platform/__ui_golden__/serialize.ts) that ignores class
// names and markup structure. The refactor is correct when this file passes
// without a single snapshot being rewritten.
//
// Covered: every tab, every Settings section, the Tome of Lore sections, the
// audio add-on installed / absent, and first-run with nothing configured.
// Hand-offs and Caption Repair live in App.snapshot.handoffs.test.tsx.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import {
  installScenario,
  mountApp,
  settle,
  snap,
  toastsSeen,
  type Scenario,
} from '@/platform/__ui_golden__/harness'

vi.mock('sonner', async () => (await import('@/platform/__ui_golden__/sonnerMock')).sonnerMock)

type Mounted = Awaited<ReturnType<typeof mountApp>>

let scenario: Scenario
let app: Mounted | null = null

beforeEach(() => {
  scenario = undefined as unknown as Scenario
  app = null
})

afterEach(() => {
  app?.unmount()
  app = null
  vi.restoreAllMocks()
  vi.useRealTimers()
})

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
  const { user } = app!
  await user.click(screen.getByRole('tab', { name }))
  await settle(scenario)
}

/** The collapsible section whose summary carries this title. */
function sectionByTitle(title: string): HTMLDetailsElement {
  const summaries = Array.from(document.querySelectorAll('summary')).filter((s) =>
    (s.textContent ?? '').trim().startsWith(title),
  )
  expect(summaries.length, `section "${title}"`).toBeGreaterThan(0)
  return summaries[0].parentElement as HTMLDetailsElement
}

async function openSection(title: string): Promise<HTMLDetailsElement> {
  const d = sectionByTitle(title)
  if (!d.open) {
    await app!.user.click(d.querySelector('summary')!)
    await settle(scenario)
  }
  return d
}

/** Click every collapsed section inside `root`, deepest-last, until none is
 *  left closed — what a user does to read the whole page. */
async function expandAll(root: Element): Promise<void> {
  for (let pass = 0; pass < 6; pass++) {
    const closed = Array.from(root.querySelectorAll('details')).filter((d) => !d.open)
    if (closed.length === 0) return
    for (const d of closed) {
      const summary = Array.from(d.children).find((c) => c.tagName === 'SUMMARY')
      if (summary && !d.open) await app!.user.click(summary)
    }
    await settle(scenario)
  }
}

function assertClean(): void {
  expect(scenario.unmatched, 'requests with no fixture').toEqual([])
}

const SETTINGS_SECTIONS = [
  'Providers & models',
  'Pipeline tuning',
  'Voice & content',
  'Transcription',
  'Maintenance',
]

function runVariant(name: string, opts: { audio: boolean; populated: boolean }) {
  describe(name, () => {
    it('shell and Chronicle tab on first paint', async () => {
      scenario = installScenario(opts)
      app = await mountApp(scenario)
      expect.soft(document.body.textContent?.length).toBeGreaterThan(0)
      expect.soft(snap(document.body)).toMatchSnapshot('whole page on load')
      expect.soft(scenario.take().join('\n')).toMatchSnapshot('requests on load')
      expect.soft(toastsSeen()).toMatchSnapshot('toasts on load')
      assertClean()
    })

    it('every tab, in order', async () => {
      scenario = installScenario(opts)
      app = await mountApp(scenario)
      scenario.take()

      const tabs = ['Chronicle', 'Tome of Lore', 'Settings', 'Help']
      if (opts.audio) tabs.unshift('Sessions')
      expect.soft(tabStrip()).toMatchSnapshot('tab strip on load')

      for (const tab of tabs) {
        await goTo(tab)
        expect.soft(tabStrip()).toMatchSnapshot(`tab strip on ${tab}`)
        expect.soft(snap(visiblePanel())).toMatchSnapshot(`${tab} panel`)
        expect.soft(scenario.take().join('\n')).toMatchSnapshot(`requests after opening ${tab}`)
        await expandAll(visiblePanel())
        expect.soft(snap(visiblePanel())).toMatchSnapshot(`${tab} panel, every section expanded`)
        expect.soft(scenario.take().join('\n')).toMatchSnapshot(`requests after expanding ${tab}`)
      }
      expect.soft(toastsSeen()).toMatchSnapshot('toasts after the tour')
      assertClean()
    })

    it('Settings: each section, opened', async () => {
      scenario = installScenario(opts)
      app = await mountApp(scenario)
      await goTo('Settings')
      scenario.take()
      for (const title of SETTINGS_SECTIONS) {
        const d = await openSection(title)
        expect.soft(d.open).toBe(true)
        expect.soft(snap(d)).toMatchSnapshot(`Settings > ${title}`)
        expect.soft(scenario.take().join('\n')).toMatchSnapshot(`requests after opening ${title}`)
      }
      assertClean()
    })

    it('Tome of Lore: each section, opened', async () => {
      scenario = installScenario(opts)
      app = await mountApp(scenario)
      await goTo('Tome of Lore')
      scenario.take()
      for (const title of ['Lore source', 'Lore library', 'Names & corrections']) {
        const d = await openSection(title)
        expect.soft(snap(d)).toMatchSnapshot(`Tome of Lore > ${title}`)
      }
      assertClean()
    })

    it('Settings search narrows the sections', async () => {
      scenario = installScenario(opts)
      app = await mountApp(scenario)
      await goTo('Settings')
      const { user } = app
      const box = screen.getByRole('searchbox', { name: 'Search settings' })
      await user.type(box, 'whisper')
      await settle(scenario)
      expect.soft(snap(visiblePanel().querySelector('main, div') ?? visiblePanel())).toMatchSnapshot('search "whisper"')
      await user.clear(box)
      await user.type(box, 'zzzz-nothing')
      await settle(scenario)
      expect.soft(within(visiblePanel() as HTMLElement).getByText(/Nothing matches/)).toBeTruthy()
      expect.soft(snap(visiblePanel())).toMatchSnapshot('search with no match')
      assertClean()
    })
  })
}

runVariant('audio add-on installed, everything configured', { audio: true, populated: true })
runVariant('audio add-on absent, everything configured', { audio: false, populated: true })
runVariant('first run: no keys, no audio, no content', { audio: false, populated: false })

describe('render health', () => {
  it('records console output emitted while rendering every surface', async () => {
    scenario = installScenario({ audio: true, populated: true })
    app = await mountApp(scenario)
    for (const tab of ['Sessions', 'Chronicle', 'Tome of Lore', 'Settings', 'Help']) {
      await goTo(tab)
    }
    expect(scenario.consoleErrors).toMatchSnapshot('console errors and warnings')
  })
})
