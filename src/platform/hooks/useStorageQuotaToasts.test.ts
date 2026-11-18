/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { toast } from 'sonner'
import { STORAGE_QUOTA_EVENT, STORAGE_QUOTA_WARNING_EVENT } from '@/platform/lib/storage'
import { useStorageQuotaToasts } from './useStorageQuotaToasts'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn() } }))

const fire = (name: string, detail?: unknown) => window.dispatchEvent(new CustomEvent(name, { detail }))

afterEach(() => vi.clearAllMocks())

describe('useStorageQuotaToasts', () => {
  it('shows the storage-full error with a backup download', () => {
    renderHook(() => useStorageQuotaToasts())
    fire(STORAGE_QUOTA_EVENT, { key: 'refinement_state', bytes: 1234 })
    expect(toast.error).toHaveBeenCalledTimes(1)
    const [message, opts] = vi.mocked(toast.error).mock.calls[0]
    expect(message).toBe('localStorage full when saving "refinement_state" (~1234 bytes).')
    expect(opts).toMatchObject({ duration: 12000, action: { label: 'Download app-state backup (browser data)' } })
  })

  it('warns once per page load that storage is nearly full, however many writes follow', () => {
    renderHook(() => useStorageQuotaToasts())
    fire(STORAGE_QUOTA_WARNING_EVENT, { key: 'refinement_state', bytes: 10 })
    fire(STORAGE_QUOTA_WARNING_EVENT, { key: 'refinement_state', bytes: 10 })
    fire(STORAGE_QUOTA_WARNING_EVENT, { key: 'refinement_state', bytes: 10 })
    expect(toast.warning).toHaveBeenCalledTimes(1)
    const [message, opts] = vi.mocked(toast.warning).mock.calls[0]
    expect(message).toMatch(/nearly full/)
    expect(opts).toMatchObject({ action: { label: 'Download app-state backup (browser data)' } })
  })

  it('stops listening once unmounted', () => {
    const { unmount } = renderHook(() => useStorageQuotaToasts())
    unmount()
    fire(STORAGE_QUOTA_EVENT, { key: 'k', bytes: 1 })
    fire(STORAGE_QUOTA_WARNING_EVENT, { key: 'k', bytes: 1 })
    expect(toast.error).not.toHaveBeenCalled()
    expect(toast.warning).not.toHaveBeenCalled()
  })
})
