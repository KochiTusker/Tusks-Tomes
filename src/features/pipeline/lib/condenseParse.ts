// Reads one Phase 6 (Condense) chunk's output.
//
// Condense answers with a JSON object whose narrative is long prose full of
// quoted dialogue — exactly where models slip. One line of speech with its
// quote marks left bare makes the whole object invalid JSON, and a chunk that
// cannot be read loses its part of the session from the condensed narrative
// AND the recap at once. So when strict parsing fails, this reads the two
// fields by their keys instead of by JSON grammar.

import type { CondenseOutput } from '@/features/pipeline/lib/types'
import { repairJson, stripCodeFences, tryParseJson } from './jsonExtract'

/** Parse a Phase 6 chunk. Null only when neither field can be recovered —
 *  the caller should treat that as a failed chunk, never as an empty one. */
export function parseCondenseChunk(raw: string): CondenseOutput | null {
  const parsed = tryParseJson<Partial<CondenseOutput>>(raw, '{')
  if (parsed && (typeof parsed.narrative === 'string' || Array.isArray(parsed.bulletPoints))) {
    return normalise(parsed.narrative, parsed.bulletPoints)
  }
  return salvageCondenseChunk(stripCodeFences(raw))
}

const NARRATIVE_OPEN = /"narrative"\s*:\s*"/
const NARRATIVE_CLOSE_BEFORE_BULLETS = /"\s*,\s*"bulletPoints"\s*:\s*\[/
const BULLETS_OPEN = /"bulletPoints"\s*:\s*\[/

/** Recover `narrative` and `bulletPoints` from an object that is not valid
 *  JSON. Relies on the field keys, not on the quoting inside their values. */
export function salvageCondenseChunk(text: string): CondenseOutput | null {
  const open = NARRATIVE_OPEN.exec(text)
  if (!open) return null
  const rest = text.slice(open.index + open[0].length)

  let narrativeBody: string
  let bulletsBody: string | null
  const close = NARRATIVE_CLOSE_BEFORE_BULLETS.exec(rest)
  if (close) {
    // The order the prompt asks for: narrative, then bulletPoints.
    narrativeBody = rest.slice(0, close.index)
    bulletsBody = rest.slice(close.index + close[0].length)
  } else {
    // Narrative is the last (or only) field: it ends at the final quote.
    const end = rest.lastIndexOf('"')
    if (end < 0) return null
    narrativeBody = rest.slice(0, end)
    const before = text.slice(0, open.index)
    const bulletsOpen = BULLETS_OPEN.exec(before)
    bulletsBody = bulletsOpen ? before.slice(bulletsOpen.index + bulletsOpen[0].length) : null
  }

  const out = normalise(decodeLoose(narrativeBody), readBullets(bulletsBody))
  return out.narrative || out.bulletPoints.length > 0 ? out : null
}

function normalise(narrative: unknown, bullets: unknown): CondenseOutput {
  return {
    narrative: typeof narrative === 'string' ? narrative.trim() : '',
    bulletPoints: Array.isArray(bullets)
      ? bullets
          .filter((b): b is string => typeof b === 'string' && b.trim().length > 0)
          .map((b) => b.trim())
      : [],
  }
}

/** `body` starts just after the array's `[`; everything after its last `]`
 *  is ignored. */
function readBullets(body: string | null): string[] {
  if (body === null) return []
  const end = body.lastIndexOf(']')
  const inner = (end >= 0 ? body.slice(0, end) : body).trim()
  if (!inner) return []
  try {
    const arr: unknown = JSON.parse(repairJson(`[${inner}]`))
    if (Array.isArray(arr)) return arr.filter((b): b is string => typeof b === 'string')
  } catch { /* bare quotes inside a bullet — split on the item separators */ }
  return inner
    .replace(/^"/, '')
    .replace(/"\s*,?$/, '')
    .split(/"\s*,\s*"/)
    .map(decodeLoose)
}

/** Decode the body of a JSON string literal whose inner quotes may be bare. */
function decodeLoose(body: string): string {
  let out = ''
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch === '\\' && i + 1 < body.length) {
      out += ch + body[i + 1]
      i++
      continue
    }
    out += ch === '"' ? '\\"' : ch
  }
  try {
    const decoded: unknown = JSON.parse(repairJson(`"${out}"`))
    if (typeof decoded === 'string') return decoded
  } catch { /* an escape JSON does not know, e.g. \' */ }
  return body.replace(/\\n/g, '\n').replace(/\\(["\\/'])/g, '$1')
}
