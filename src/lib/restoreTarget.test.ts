import { beforeEach, describe, expect, it, vi } from 'vitest'

// Which providers "have a key" is the only input that matters here, so the
// provider registry is the one thing mocked.
const keyed = new Set<string>()
vi.mock('./providers', () => ({
  getCloudProvider: (provider: string) => ({ hasKey: () => keyed.has(provider) }),
}))

import { resolveRestoreTarget, restoreAvailable } from './restoreTarget'

beforeEach(() => keyed.clear())

describe('choosing who repairs a refused chunk', () => {
  it('uses Gemini by default, preserving the original behaviour', () => {
    keyed.add('gemini')
    expect(resolveRestoreTarget('in-run')?.provider).toBe('gemini')
    expect(resolveRestoreTarget('pass')?.provider).toBe('gemini')
  })

  it('sends the in-run retry to a cheaper tier than the whole-chronicle pass', () => {
    // The in-run failsafe redoes ONE small chunk; the pass reconciles an entire
    // chronicle against an entire transcript in a single call.
    keyed.add('gemini')
    expect(resolveRestoreTarget('in-run')?.model).toBe('gemini-2.5-flash')
    expect(resolveRestoreTarget('pass')?.model).toBe('gemini-2.5-pro')
  })

  it('uses OpenRouter when a preset asks for it', () => {
    keyed.add('gemini')
    keyed.add('openrouter')
    const t = resolveRestoreTarget('pass', 'openrouter')
    expect(t?.provider).toBe('openrouter')
    expect(t?.model).toBe('deepseek/deepseek-v4-pro')
  })

  it('repairs on the other provider rather than not repairing at all', () => {
    // The whole point of resolving instead of hardcoding. A user with no
    // Gemini key used to get no repair, and the refusal became a permanent
    // hole in the chronicle.
    keyed.add('openrouter')
    expect(resolveRestoreTarget('pass', 'gemini')?.provider).toBe('openrouter')

    keyed.clear()
    keyed.add('gemini')
    expect(resolveRestoreTarget('pass', 'openrouter')?.provider).toBe('gemini')
  })

  it('reports no target when nothing can repair, rather than naming one that cannot run', () => {
    expect(resolveRestoreTarget('pass')).toBeNull()
    expect(resolveRestoreTarget('in-run', 'openrouter')).toBeNull()
    expect(restoreAvailable()).toBe(false)
  })

  it('labels the target so the run log shows what did the repair', () => {
    keyed.add('openrouter')
    expect(resolveRestoreTarget('pass', 'openrouter')?.label).toContain('openrouter')
    keyed.clear()
    keyed.add('gemini')
    expect(resolveRestoreTarget('pass')?.label).toContain('gemini')
  })

  it('picks a repair model with no prompt-level moderation filter', () => {
    // A repair runs BECAUSE something already refused this content. Routing it
    // to a moderated model invites the same refusal twice.
    keyed.add('openrouter')
    const t = resolveRestoreTarget('pass', 'openrouter')
    expect(t?.model.startsWith('deepseek/')).toBe(true)
  })
})
