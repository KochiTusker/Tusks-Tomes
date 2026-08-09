// Toggle for the Claude Code explicit-content failsafe.
//
// When ON, two safety nets activate for Claude Code runs:
//   1. real-time — a chunk that looks like a refusal/empty is redone on
//      Gemini (permissive) mid-run;
//   2. post-hoc — detected refusals auto-offer a Gemini "restore explicit
//      content" reconciliation pass over the finished chronicle + extras.
//
// OFF by default (per the project's "risky features default off" convention):
// when off, Claude Code behaves exactly as it would without the failsafe.
// Both layers require a Gemini key to be configured — the UI surfaces that.

const LS_KEY = 'claude_failsafe_enabled'

export const CLAUDE_FAILSAFE_EVENT = 'sbts:claude-failsafe-changed'

export function getClaudeFailsafeEnabled(): boolean {
  try {
    if (typeof localStorage === 'undefined') return false
    return localStorage.getItem(LS_KEY) === 'true'
  } catch {
    return false
  }
}

export function setClaudeFailsafeEnabled(on: boolean): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(LS_KEY, on ? 'true' : 'false')
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(CLAUDE_FAILSAFE_EVENT, { detail: on }))
    }
  } catch {
    /* ignore */
  }
}
