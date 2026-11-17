/** @vitest-environment jsdom */
// Tier-aware dialog tests — assert that the verbose copy + button disable
// logic gates on (activeTier, permanentlyOnFallback, paidKeyAvailable)
// exactly the way the audit predicted. Without these, the dialog could
// silently regress to offering a no-op "Switch to paid" action even when
// the user is already on Paid (or already auto-flipped to Free).

import { describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { RateLimitDialog, type RateLimitChoice } from './RateLimitDialog'

const baseProps = {
  open: true,
  quotaKind: 'rate_limit' as const,
  paidKeyAvailable: true,
  provider: 'gemini' as const,
  activeTier: 'free' as const,
  model: 'gemini-2.5-flash',
  permanentlyOnFallback: false,
  onChoose: vi.fn<(c: RateLimitChoice) => void>(),
  onClose: vi.fn<() => void>(),
}

describe('RateLimitDialog — verbose copy + tier-aware disable', () => {
  it('renders the verbose Gemini Free title for free-tier rate-limit', () => {
    render(<RateLimitDialog {...baseProps} />)
    expect(screen.getByText('Gemini Free — per-minute rate limit hit')).toBeTruthy()
    cleanup()
  })

  it('renders the verbose Gemini Paid title for paid-tier rate-limit', () => {
    render(<RateLimitDialog {...baseProps} activeTier="paid" />)
    expect(screen.getByText('Gemini Paid — per-minute rate limit hit')).toBeTruthy()
    cleanup()
  })

  it('renders the daily-quota title for daily_quota', () => {
    render(<RateLimitDialog {...baseProps} quotaKind="daily_quota" />)
    expect(screen.getByText('Gemini Free — daily quota exhausted')).toBeTruthy()
    cleanup()
  })

  it('cites the published RPM cap + recent-call count when both are populated', () => {
    render(
      <RateLimitDialog
        {...baseProps}
        rpmCap={10}
        requestsInLastMinute={12}
      />,
    )
    // Use document-level textContent so the assertion isn't tripped by
    // testing-library's "multiple matches" behavior (textContent cascades
    // through ancestors).
    expect(document.body.textContent).toContain('published cap of 10 requests per minute')
    expect(document.body.textContent).toContain('dispatched 12 requests in the last 60 seconds')
    cleanup()
  })

  it('includes the key fingerprint when provided', () => {
    render(<RateLimitDialog {...baseProps} keyFingerprint="abc123" />)
    expect(document.body.textContent).toContain('Key fingerprint: `abc123`')
    cleanup()
  })

  it('falls back to generic description when verbose fields are absent', () => {
    render(<RateLimitDialog {...baseProps} model={undefined} rpmCap={undefined} />)
    expect(document.body.textContent).toContain('hit its per-minute rate limit')
    cleanup()
  })
})

describe('RateLimitDialog — Switch-to-paid button disable logic', () => {
  function getFallbackButton(): HTMLButtonElement {
    // Use accessible-name lookup so the locator isn't tripped by ancestor
    // textContent inclusion (the title's appearance inside the description
    // would otherwise match).
    return screen.getByRole('button', { name: /Switch to paid key/ }) as HTMLButtonElement
  }

  it('enables Switch-to-paid when on Free + paid key exists + not permanently-on-fallback', () => {
    render(<RateLimitDialog {...baseProps} activeTier="free" />)
    const btn = getFallbackButton()
    expect(btn.disabled).toBe(false)
    cleanup()
  })

  it('disables when paidKeyAvailable=false', () => {
    render(<RateLimitDialog {...baseProps} paidKeyAvailable={false} />)
    const btn = getFallbackButton()
    expect(btn.disabled).toBe(true)
    expect(btn.title).toContain('No paid Gemini key is configured')
    cleanup()
  })

  it('disables when activeTier is already paid', () => {
    render(<RateLimitDialog {...baseProps} activeTier="paid" />)
    const btn = getFallbackButton()
    expect(btn.disabled).toBe(true)
    expect(btn.title).toContain("You're already on the Paid key")
    cleanup()
  })

  it('disables when auto-tier has permanently fallen back to Free', () => {
    render(
      <RateLimitDialog
        {...baseProps}
        activeTier="auto"
        permanentlyOnFallback={true}
      />,
    )
    const btn = getFallbackButton()
    expect(btn.disabled).toBe(true)
    expect(btn.title).toContain('already swapped to the Free key')
    cleanup()
  })
})

describe('RateLimitDialog — Slow Down disable logic', () => {
  it('disables Slow Down when quotaKind=daily_quota', () => {
    render(<RateLimitDialog {...baseProps} quotaKind="daily_quota" />)
    // The Slow Down button label has the exact "(3× longer between calls)"
    // suffix in its bold span — use it as a precise locator that doesn't
    // also match the italic body copy.
    const btn = screen.getByRole('button', { name: /Slow down/ }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(btn.title).toContain('Slowing down does not help')
    cleanup()
  })

  it('enables Slow Down when quotaKind=rate_limit', () => {
    render(<RateLimitDialog {...baseProps} quotaKind="rate_limit" />)
    const btn = screen.getByRole('button', { name: /Slow down/ }) as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    cleanup()
  })
})
