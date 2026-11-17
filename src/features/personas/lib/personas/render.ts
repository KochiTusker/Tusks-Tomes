import type { PromptVars } from '@shared/personas/types'

export { extractPlaceholders } from '@shared/personas/validate'

const STRING_KEYS = new Set([
  'groundedChunk',
  'chronicleChunk',
  'chronicle',
  'kbConcat',
  'qaBlock',
  'answersBlock',
  'priorTail',
  'campaign',
])
const NUMBER_KEYS = new Set(['chunkIndex', 'chunkTotal', 'sessionNumber'])

/**
 * Replace `{key}` tokens in `template` with the matching `vars` value.
 *
 * - Unknown keys are left untouched so users see broken templates instead of
 *   silent empty strings.
 * - Strings substitute literally; numbers stringify; `undefined`/`null` become
 *   `''`. `chunkIndex` is expected to already be 1-based (pipeline converts
 *   from the 0-based internal index before calling).
 * - Token syntax is intentionally minimal — `{x}` with no whitespace, no
 *   expressions — so user-authored prompts don't need to learn a templating
 *   language.
 */
export function renderPersonaPrompt(template: string, vars: PromptVars): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    if (STRING_KEYS.has(key)) {
      const v = (vars as Record<string, unknown>)[key]
      return v === undefined || v === null ? '' : String(v)
    }
    if (NUMBER_KEYS.has(key)) {
      const v = (vars as Record<string, unknown>)[key]
      return v === undefined || v === null ? '' : String(v)
    }
    return match
  })
}
