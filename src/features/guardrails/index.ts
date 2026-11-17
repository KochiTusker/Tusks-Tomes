// Content guardrails: the feature's front door.
// Other features import from here, never from a file inside this folder
// (rule d in engineering/tests/boundaries.test.ts). It re-exports only what
// they use; an import that would loop back through here stays deep and is
// listed, with its reason, in engineering/tests/boundaries.allowlist.json.
export { GuardrailsCard } from './components/GuardrailsCard'
export {
  getClaudeFailsafeEnabled,
  getFailsafeTarget,
  setClaudeFailsafeEnabled,
  setFailsafeTarget,
} from './lib/claudeFailsafe'
export { FAILSAFE_TARGETS } from './lib/failsafeTargets'
export type { FailsafeTarget } from './lib/failsafeTargets'
export { getGuardrails } from './lib/guardrails'
