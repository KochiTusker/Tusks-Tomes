/** @vitest-environment jsdom */
// ChronicleEditor contract:
//   - Starts with the current text; Cancel discards the draft.
//   - Save with an unchanged draft closes without calling onSave.
//   - Save with a changed draft calls onSave with the new text.
//   - Save is disabled for a blank draft; a rejected save keeps the editor open.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ChronicleEditor } from './ChronicleEditor'

afterEach(() => cleanup())

function box() {
  return screen.getByLabelText('Chronicle text') as HTMLTextAreaElement
}

describe('ChronicleEditor', () => {
  it('starts with the current text', () => {
    render(<ChronicleEditor value="Hello PC-Alpha" onSave={vi.fn()} onCancel={vi.fn()} />)
    expect(box().value).toBe('Hello PC-Alpha')
  })

  it('Cancel discards the draft without saving', () => {
    const onSave = vi.fn()
    const onCancel = vi.fn()
    render(<ChronicleEditor value="a" onSave={onSave} onCancel={onCancel} />)
    fireEvent.change(box(), { target: { value: 'b' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('Save with no change closes without calling onSave', () => {
    const onSave = vi.fn()
    const onCancel = vi.fn()
    render(<ChronicleEditor value="same" onSave={onSave} onCancel={onCancel} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).not.toHaveBeenCalled()
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('Save with a change passes the new text', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<ChronicleEditor value="before" onSave={onSave} onCancel={vi.fn()} />)
    fireEvent.change(box(), { target: { value: 'after' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('after'))
  })

  it('disables Save for a blank draft', () => {
    render(<ChronicleEditor value="text" onSave={vi.fn()} onCancel={vi.fn()} />)
    fireEvent.change(box(), { target: { value: '   ' } })
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('keeps the draft and re-enables Save when onSave rejects', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('nope'))
    render(<ChronicleEditor value="a" onSave={onSave} onCancel={vi.fn()} />)
    fireEvent.change(box(), { target: { value: 'b' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false),
    )
    expect(box().value).toBe('b')
  })
})
