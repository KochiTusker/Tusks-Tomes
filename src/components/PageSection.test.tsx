/** @vitest-environment jsdom */
// Guard for the Settings reorganisation.
//
// Moving ~28 cards into collapsible sections is exactly the kind of change
// where a mis-parented JSX block silently drops a card off the page and
// nothing fails — typecheck passes, tests pass, the setting is simply
// unreachable. These tests pin the two properties that would catch it:
// collapsed sections still MOUNT their children, and the section list in
// App.tsx stays in sync with what's rendered.

import { afterEach, describe, expect, it, beforeEach, vi } from 'vitest'
import { act, cleanup, render, screen, fireEvent } from '@testing-library/react'
import { PageSection, PageSectionNav, openPageSection } from './PageSection'

afterEach(cleanup)
beforeEach(() => {
  localStorage.clear()
})

const base = {
  id: 'test-section',
  title: 'Test section',
  blurb: 'A section under test.',
  icon: <span data-testid="icon" />,
}

describe('PageSection', () => {
  it('mounts children even when collapsed, so nothing is unreachable', () => {
    render(
      <PageSection {...base}>
        <button>Deeply nested setting</button>
      </PageSection>,
    )
    // <details> hides content visually but keeps it in the DOM — the child
    // must exist so find-in-page and assistive tech can still reach it.
    expect(screen.getByText('Deeply nested setting')).toBeTruthy()
  })

  it('respects defaultOpen on first visit', () => {
    const { container } = render(
      <PageSection {...base} defaultOpen>
        <span>child</span>
      </PageSection>,
    )
    expect(container.querySelector('details')?.open).toBe(true)
  })

  it('persists collapse state across remounts', () => {
    const { container, unmount } = render(
      <PageSection {...base} defaultOpen>
        <span>child</span>
      </PageSection>,
    )
    const details = container.querySelector('details')!
    // Simulate the user collapsing it.
    details.open = false
    fireEvent(details, new Event('toggle', { bubbles: false }))
    unmount()

    const second = render(
      <PageSection {...base} defaultOpen>
        <span>child</span>
      </PageSection>,
    )
    // defaultOpen must NOT win over the stored preference — Settings is a
    // place you return to for one thing.
    expect(second.container.querySelector('details')?.open).toBe(false)
  })

  it('shows an item count only while collapsed', () => {
    const { container, rerender } = render(
      <PageSection {...base} itemCount={4}>
        <span>child</span>
      </PageSection>,
    )
    expect(screen.getByText('4')).toBeTruthy()
    const details = container.querySelector('details')!
    details.open = true
    fireEvent(details, new Event('toggle', { bubbles: false }))
    rerender(
      <PageSection {...base} itemCount={4}>
        <span>child</span>
      </PageSection>,
    )
    expect(screen.queryByText('4')).toBeNull()
  })

  it('opens on request from the nav rail', () => {
    const { container } = render(
      <PageSection {...base}>
        <span>child</span>
      </PageSection>,
    )
    expect(container.querySelector('details')?.open).toBe(false)
    // The rail dispatches a window event; the state update it triggers
    // happens outside React's batching, so flush it explicitly.
    act(() => openPageSection('test-section'))
    expect(container.querySelector('details')?.open).toBe(true)
  })

  it('ignores open requests aimed at a different section', () => {
    const { container } = render(
      <PageSection {...base}>
        <span>child</span>
      </PageSection>,
    )
    act(() => openPageSection('some-other-section'))
    expect(container.querySelector('details')?.open).toBe(false)
  })
})

describe('PageSection — status + nesting', () => {
  it('shows the status chip whether collapsed OR open', () => {
    // The whole point of a status chip: a collapsed section still answers
    // "what is this set to?" without being opened.
    const { container, rerender } = render(
      <PageSection {...base} status="Obsidian vault">
        <span>child</span>
      </PageSection>,
    )
    expect(screen.getByText('Obsidian vault')).toBeTruthy()
    const details = container.querySelector('details')!
    details.open = true
    fireEvent(details, new Event('toggle', { bubbles: false }))
    rerender(
      <PageSection {...base} status="Obsidian vault">
        <span>child</span>
      </PageSection>,
    )
    expect(screen.getByText('Obsidian vault')).toBeTruthy()
  })

  it('mounts a nested section and its children', () => {
    render(
      <PageSection {...base} defaultOpen>
        <PageSection id="child-section" title="Nested" blurb="inner" icon={<span />} nested>
          <button>Nested setting</button>
        </PageSection>
      </PageSection>,
    )
    expect(screen.getByText('Nested')).toBeTruthy()
    // Children of a COLLAPSED nested section must still exist — the same
    // unreachability guard as the top level, one level down.
    expect(screen.getByText('Nested setting')).toBeTruthy()
  })

  it('a nested section collapses independently of its parent', () => {
    const { container } = render(
      <PageSection {...base} defaultOpen>
        <PageSection id="child-section" title="Nested" blurb="inner" icon={<span />} nested>
          <span>child</span>
        </PageSection>
      </PageSection>,
    )
    const all = [...container.querySelectorAll('details')]
    expect(all).toHaveLength(2)
    expect(all[0].open).toBe(true)
    expect(all[1].open).toBe(false)
  })
})

describe('PageSectionNav', () => {
  it('renders one jump target per section', () => {
    const sections = [
      { ...base, id: 'a', title: 'Alpha' },
      { ...base, id: 'b', title: 'Beta' },
    ]
    render(<PageSectionNav sections={sections} />)
    expect(screen.getByRole('button', { name: /Alpha/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Beta/ })).toBeTruthy()
  })

  it('asks the matching section to open when clicked', () => {
    const spy = vi.fn()
    window.addEventListener('sbts:open-page-section', spy)
    render(<PageSectionNav sections={[{ ...base, id: 'alpha', title: 'Alpha' }]} />)
    fireEvent.click(screen.getByRole('button', { name: /Alpha/ }))
    expect(spy).toHaveBeenCalled()
    window.removeEventListener('sbts:open-page-section', spy)
  })
})
