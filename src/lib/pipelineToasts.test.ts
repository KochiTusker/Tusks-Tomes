import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CleanupReport } from './transcriptCleanup'
import type { PreGroundReport } from './preGround'

const mockToastMessage = vi.fn()
const mockToastSuccess = vi.fn()

vi.mock('sonner', () => ({
  toast: {
    message: mockToastMessage,
    success: mockToastSuccess,
  },
}))

const { showCleanupToast, showPreGroundToast } = await import('./pipelineToasts')

// ─── showCleanupToast ────────────────────────────────────────────────────────

describe('showCleanupToast', () => {
  beforeEach(() => mockToastMessage.mockClear())

  it('does not fire when all fields are falsy', () => {
    showCleanupToast({ markersStripped: 0, fillersCollapsed: 0, whitespaceNormalized: false })
    expect(mockToastMessage).not.toHaveBeenCalled()
  })

  it('uses singular "marker" for markersStripped === 1', () => {
    showCleanupToast({ markersStripped: 1, fillersCollapsed: 0, whitespaceNormalized: false })
    expect(mockToastMessage.mock.calls[0][1].description).toBe('1 marker stripped')
  })

  it('uses plural "markers" for markersStripped > 1', () => {
    showCleanupToast({ markersStripped: 3, fillersCollapsed: 0, whitespaceNormalized: false })
    expect(mockToastMessage.mock.calls[0][1].description).toContain('3 markers stripped')
  })

  it('uses singular "filler run" for fillersCollapsed === 1', () => {
    showCleanupToast({ markersStripped: 0, fillersCollapsed: 1, whitespaceNormalized: false })
    expect(mockToastMessage.mock.calls[0][1].description).toBe('1 filler run collapsed')
  })

  it('uses plural "filler runs" for fillersCollapsed > 1', () => {
    showCleanupToast({ markersStripped: 0, fillersCollapsed: 4, whitespaceNormalized: false })
    expect(mockToastMessage.mock.calls[0][1].description).toContain('4 filler runs collapsed')
  })

  it('shows only "whitespace normalized" when only that field is set', () => {
    showCleanupToast({ markersStripped: 0, fillersCollapsed: 0, whitespaceNormalized: true })
    expect(mockToastMessage.mock.calls[0][1].description).toBe('whitespace normalized')
  })

  it('joins all three items with " · " when all fields are set', () => {
    const r: CleanupReport = { markersStripped: 2, fillersCollapsed: 3, whitespaceNormalized: true }
    showCleanupToast(r)
    const desc: string = mockToastMessage.mock.calls[0][1].description
    expect(desc.split(' · ')).toHaveLength(3)
  })

  it('uses the correct toast title and 5000 ms duration', () => {
    showCleanupToast({ markersStripped: 1, fillersCollapsed: 0, whitespaceNormalized: false })
    expect(mockToastMessage.mock.calls[0][0]).toBe('Transcript cleanup complete')
    expect(mockToastMessage.mock.calls[0][1].duration).toBe(5000)
  })
})

// ─── showPreGroundToast ──────────────────────────────────────────────────────

const makeRule = (from: string, to: string, count: number) => ({ from, to, count })

describe('showPreGroundToast', () => {
  beforeEach(() => mockToastSuccess.mockClear())

  it('uses singular "term" when totalReplacements === 1', () => {
    const r: PreGroundReport = { totalReplacements: 1, perRule: [makeRule('a', 'b', 1)] }
    showPreGroundToast(r)
    expect(mockToastSuccess.mock.calls[0][0]).toMatch(/1 term before AI/)
  })

  it('uses plural "terms" when totalReplacements > 1', () => {
    const r: PreGroundReport = { totalReplacements: 5, perRule: [makeRule('a', 'b', 5)] }
    showPreGroundToast(r)
    expect(mockToastSuccess.mock.calls[0][0]).toMatch(/5 terms before AI/)
  })

  it('formats rule summary as "from→to ×count"', () => {
    const r: PreGroundReport = { totalReplacements: 3, perRule: [makeRule('paladin', 'Paladin', 3)] }
    showPreGroundToast(r)
    expect(mockToastSuccess.mock.calls[0][1].description).toBe('paladin→Paladin ×3')
  })

  it('shows all rules when perRule has exactly 3 entries — no "+N more" suffix', () => {
    const r: PreGroundReport = {
      totalReplacements: 6,
      perRule: [makeRule('a', 'A', 2), makeRule('b', 'B', 2), makeRule('c', 'C', 2)],
    }
    showPreGroundToast(r)
    const desc: string = mockToastSuccess.mock.calls[0][1].description
    expect(desc).not.toContain('more rules')
    expect(desc.split(', ')).toHaveLength(3)
  })

  it('truncates to 3 rules and appends "+N more rules" when perRule has 5 entries', () => {
    const r: PreGroundReport = {
      totalReplacements: 10,
      perRule: [
        makeRule('a', 'A', 2), makeRule('b', 'B', 2), makeRule('c', 'C', 2),
        makeRule('d', 'D', 2), makeRule('e', 'E', 2),
      ],
    }
    showPreGroundToast(r)
    const desc: string = mockToastSuccess.mock.calls[0][1].description
    expect(desc).toContain('+2 more rules')
    const beforeSuffix = desc.replace(/, \+2 more rules$/, '')
    expect(beforeSuffix.split(', ')).toHaveLength(3)
  })

  it('uses 6000 ms duration', () => {
    const r: PreGroundReport = { totalReplacements: 1, perRule: [makeRule('a', 'b', 1)] }
    showPreGroundToast(r)
    expect(mockToastSuccess.mock.calls[0][1].duration).toBe(6000)
  })
})
