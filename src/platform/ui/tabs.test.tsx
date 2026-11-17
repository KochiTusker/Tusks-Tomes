// @vitest-environment jsdom
//
// The Tabs primitive is the project's own, not Radix's, and one prop on it is
// load-bearing: `forceMount` is the only thing standing between a tab switch
// and an aborted pipeline run. The panel that owns a run also owns the
// AbortController that cancels it on unmount, and AbortError is the one error
// the diagnostics path deliberately ignores — so an unmount took a multi-hour
// run down silently. These tests pin the mechanism rather than the symptom,
// because the symptom costs three hours to observe.

import { describe, expect, it, vi } from 'vitest'
import { useEffect, useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs'

/** Stands in for a panel that owns work: it aborts on unmount, exactly as
 *  RefinementTool and CaptionRepair do. */
function RunOwner({ onAbort, label }: { onAbort: () => void; label: string }) {
  useEffect(() => onAbort, [onAbort])
  return <div>{label}</div>
}

function Harness({ keepMounted }: { keepMounted: boolean }) {
  const [tab, setTab] = useState('work')
  const abortWork = (Harness as unknown as { abortWork: () => void }).abortWork
  return (
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList>
        <TabsTrigger value="work">Work</TabsTrigger>
        <TabsTrigger value="other">Other</TabsTrigger>
      </TabsList>
      <TabsContent value="work" forceMount={keepMounted}>
        <RunOwner onAbort={abortWork} label="run in progress" />
      </TabsContent>
      <TabsContent value="other">
        <div>somewhere else</div>
      </TabsContent>
    </Tabs>
  )
}

function renderHarness(keepMounted: boolean) {
  const abortWork = vi.fn()
  ;(Harness as unknown as { abortWork: () => void }).abortWork = abortWork
  const utils = render(<Harness keepMounted={keepMounted} />)
  return { abortWork, ...utils }
}

describe('Tabs — forceMount is what keeps a run alive', () => {
  it('does not unmount a force-mounted panel when the user leaves it', () => {
    const { abortWork } = renderHarness(true)
    expect(screen.getByText('run in progress')).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: 'Other' }))

    // The cleanup that would have aborted the run never ran.
    expect(abortWork).not.toHaveBeenCalled()
    // The panel is still mounted, and still holds whatever state it had.
    expect(screen.getByText('run in progress')).toBeTruthy()
    cleanup()
  })

  it('hides the force-mounted panel rather than removing it', () => {
    renderHarness(true)
    const panel = screen.getByText('run in progress').closest('[role="tabpanel"]')
    expect(panel?.hasAttribute('hidden')).toBe(false)

    fireEvent.click(screen.getByRole('tab', { name: 'Other' }))
    expect(panel?.hasAttribute('hidden')).toBe(true)

    // And back: the same element, never re-created.
    fireEvent.click(screen.getByRole('tab', { name: 'Work' }))
    expect(panel?.hasAttribute('hidden')).toBe(false)
    expect(screen.getByText('run in progress').closest('[role="tabpanel"]')).toBe(panel)
    cleanup()
  })

  it('still unmounts a panel that has not asked to stay', () => {
    // The default has to keep working, or every tab in the app would pay the
    // cost of the one that needs this.
    const { abortWork } = renderHarness(false)
    expect(screen.getByText('run in progress')).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: 'Other' }))

    expect(abortWork).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('run in progress')).toBeNull()
    cleanup()
  })

  it('keeps the inactive panel out of the accessibility tree while hidden', () => {
    // Force-mounting must not leave two panels readable at once; `hidden` is
    // what stops a screen reader walking a tab the user is not on.
    renderHarness(true)
    fireEvent.click(screen.getByRole('tab', { name: 'Other' }))
    // getByRole ignores hidden subtrees, so exactly one panel is exposed.
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1)
    expect(screen.getByRole('tabpanel').textContent).toContain('somewhere else')
    cleanup()
  })
})
