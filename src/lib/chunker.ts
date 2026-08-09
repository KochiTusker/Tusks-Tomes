// Chunker that prefers natural break points over hard substring cuts.
//
// Cascade of splitters, each with its own joiner:
//   1. Paragraphs (joined by \n\n) — preferred boundary.
//   2. Sentences (joined by ' ') — used when a single paragraph overflows.
//   3. Speaker turns (joined by '\n') — used when a single sentence overflows.
//   4. Hard substring cut at `target` — last resort.
//
// Choosing natural boundaries protects Phase 3 chronicle continuity by
// avoiding mid-sentence and mid-thought splits.

const SENTENCE_END_RE = /([.!?])(\s+)(?=[A-Z"'(\[])/g
const SPEAKER_TURN_RE = /^([A-Z][A-Za-z' .-]{1,40}):\s/m

type Splitter = {
  split: (s: string) => string[]
  /** How to rejoin units of this kind when packing. */
  joiner: string
}

function splitOnSentences(text: string): string[] {
  const indices: number[] = []
  let m: RegExpExecArray | null
  SENTENCE_END_RE.lastIndex = 0
  while ((m = SENTENCE_END_RE.exec(text)) !== null) {
    indices.push(m.index + m[1].length + m[2].length)
  }
  if (!indices.length) return [text]
  const out: string[] = []
  let cursor = 0
  for (const idx of indices) {
    out.push(text.slice(cursor, idx))
    cursor = idx
  }
  out.push(text.slice(cursor))
  return out.map((s) => s.trim()).filter(Boolean)
}

function splitOnSpeakerTurns(text: string): string[] {
  const lines = text.split(/\r?\n/)
  const groups: string[] = []
  let current: string[] = []
  for (const line of lines) {
    if (SPEAKER_TURN_RE.test(line) && current.length > 0) {
      groups.push(current.join('\n'))
      current = [line]
    } else {
      current.push(line)
    }
  }
  if (current.length) groups.push(current.join('\n'))
  return groups.map((s) => s.trim()).filter(Boolean)
}

function hardCut(text: string, target: number): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += target) {
    out.push(text.slice(i, i + target))
  }
  return out
}

function pack(units: string[], target: number, joiner: string, fallbacks: Splitter[]): string[] {
  const chunks: string[] = []
  let current = ''
  const push = () => {
    if (current.length > 0) {
      chunks.push(current)
      current = ''
    }
  }
  for (const unit of units) {
    if (unit.length > target) {
      push()
      if (fallbacks.length === 0) {
        for (const c of hardCut(unit, target)) chunks.push(c)
        continue
      }
      const [next, ...rest] = fallbacks
      const subChunks = pack(next.split(unit), target, next.joiner, rest)
      for (const c of subChunks) chunks.push(c)
      continue
    }
    const candidate = current ? current + joiner + unit : unit
    if (candidate.length > target) {
      push()
      current = unit
    } else {
      current = candidate
    }
  }
  push()
  return chunks
}

export function chunkText(text: string, target: number): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  if (trimmed.length <= target) return [trimmed]

  const paragraphs = trimmed.split(/\n\n+/)
  return pack(paragraphs, target, '\n\n', [
    { split: splitOnSentences, joiner: ' ' },
    { split: splitOnSpeakerTurns, joiner: '\n' },
  ])
}
