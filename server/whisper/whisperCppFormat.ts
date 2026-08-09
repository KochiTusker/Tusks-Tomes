// Translate whisper.cpp's `--output-json-full` output into the same shape the
// faster-whisper sidecar produces.
//
// WHY THIS IS A SEPARATE, PURE MODULE. The bridge to whisper.cpp is a
// bring-your-own-binary arrangement: the user installs and (for GPU support)
// compiles it themselves, so this code can never be exercised on a machine
// that doesn't have it. Keeping the format translation pure — JSON string in,
// Segment[] out, no filesystem, no spawning — means the risky part is fully
// testable against fixtures on any machine, including CI. What's left in the
// invoke path is just "spawn a process and read stdout".
//
// The contract to match lives in server/whisper/invoke.ts:
//   Segment { startMs, endMs, text, words: Word[], confidence }
//   Word    { startMs, endMs, text, confidence }
//
// Word timings matter more than they look: liveQueue.ts splits utterances on
// word-level silence gaps, so returning empty `words` degrades segmentation
// rather than just dropping a nicety.

import type { Segment, Word } from './invoke.js'

/** One entry of whisper.cpp's `transcription` array. Only the fields we
 *  consume are typed; the file carries more (timestamps as strings, token
 *  ids, model params) that we deliberately ignore. */
type CppToken = {
  text?: string
  offsets?: { from?: number; to?: number }
  p?: number
}

type CppSegment = {
  text?: string
  offsets?: { from?: number; to?: number }
  tokens?: CppToken[]
}

type CppOutput = {
  systeminfo?: string
  result?: { language?: string }
  transcription?: CppSegment[]
}

export type WhisperCppParseResult = {
  segments: Segment[]
  durationMs: number
  language: string | null
}

/** whisper.cpp emits special markers as ordinary tokens. They are not speech
 *  and must not become words, or every segment gains a bogus leading word. */
const SPECIAL_TOKEN = /^\s*\[_(BEG|TT|EOT|SOT|PREV|NOT|NOSP)[^\]]*\]\s*$/i

const isSpeechToken = (t: CppToken): boolean => {
  const text = t.text ?? ''
  return text.trim().length > 0 && !SPECIAL_TOKEN.test(text)
}

/**
 * Merge whisper.cpp's sub-word tokens into whole words.
 *
 * whisper.cpp tokenises like the original model: a leading space marks the
 * start of a new word, and continuations arrive as bare fragments — " Hello",
 * " world", "." becomes "Hello", "world." rather than three words. Emitting
 * tokens directly as words would roughly double the word count and wreck the
 * silence-gap segmentation downstream.
 */
type PartialWord = { startMs: number; endMs: number; text: string; ps: number[] }

function tokensToWords(tokens: CppToken[]): Word[] {
  const words: Word[] = []

  // `flush` takes the pending word as an argument rather than closing over the
  // loop variable. A closure that nulled it out would defeat TypeScript's
  // narrowing at every call site, forcing non-null assertions through the
  // whole loop.
  const flush = (pending: PartialWord | null) => {
    if (!pending) return
    const text = pending.text.trim()
    if (!text) return
    words.push({
      startMs: pending.startMs,
      endMs: pending.endMs,
      text,
      confidence: pending.ps.length ? pending.ps.reduce((a, b) => a + b, 0) / pending.ps.length : null,
    })
  }

  let current: PartialWord | null = null
  for (const token of tokens) {
    if (!isSpeechToken(token)) continue
    const raw = token.text ?? ''
    const from = Number(token.offsets?.from ?? 0)
    const to = Number(token.offsets?.to ?? from)

    if (current === null || /^\s/.test(raw)) {
      flush(current)
      current = { startMs: from, endMs: to, text: raw, ps: [] }
    } else {
      current.text += raw
      current.endMs = to
    }
    if (typeof token.p === 'number') current.ps.push(token.p)
  }
  flush(current)
  return words
}

/**
 * Parse whisper.cpp `--output-json-full` content.
 *
 * Throws on unusable input rather than returning an empty transcript: a
 * silently-empty result would look like "the session had no speech", which is
 * a far more confusing failure than an error message.
 */
export function parseWhisperCppJson(raw: string): WhisperCppParseResult {
  let doc: CppOutput
  try {
    doc = JSON.parse(raw)
  } catch (err) {
    throw new Error(`whisper.cpp did not return valid JSON: ${(err as Error).message}`)
  }
  if (!Array.isArray(doc.transcription)) {
    throw new Error(
      'whisper.cpp JSON has no "transcription" array — was it run with --output-json-full?',
    )
  }

  const segments: Segment[] = []
  for (const seg of doc.transcription) {
    const text = (seg.text ?? '').trim()
    const startMs = Number(seg.offsets?.from ?? 0)
    const endMs = Number(seg.offsets?.to ?? startMs)
    const words = tokensToWords(seg.tokens ?? [])
    // A segment whose text is empty after trimming carries no information;
    // faster-whisper's VAD drops these too, so the shapes stay comparable.
    if (!text) continue
    const ps = (seg.tokens ?? []).filter(isSpeechToken).map((t) => t.p).filter((p): p is number => typeof p === 'number')
    segments.push({
      startMs,
      endMs,
      text,
      words,
      confidence: ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : null,
    })
  }

  // whisper.cpp reports no explicit duration, so take the end of the last
  // segment. Slightly under-reports trailing silence, which nothing downstream
  // depends on.
  const durationMs = segments.length ? Math.max(...segments.map((s) => s.endMs)) : 0

  return {
    segments,
    durationMs,
    language: doc.result?.language?.trim() || null,
  }
}

export type WhisperCppBackends = {
  /** Compiled-in GPU backends, as reported in the systeminfo line. */
  cuda: boolean
  vulkan: boolean
  metal: boolean
  coreml: boolean
  openvino: boolean
  blas: boolean
  /** True when no GPU backend at all is compiled in — the common case for
   *  people who downloaded an official release build rather than compiling. */
  cpuOnly: boolean
  /** The raw line, so the UI can show exactly what the binary reported. */
  raw: string
}

/**
 * Read which backends a whisper.cpp build actually has compiled in.
 *
 * This is the crux of the whole bridge. Official whisper.cpp releases ship
 * CPU/BLAS/CUDA builds only — there is no Vulkan release asset — so someone
 * who downloads a release binary expecting AMD acceleration gets a CPU-only
 * build and no indication why it's slow. Parsing the systeminfo line lets the
 * UI say "this build has no GPU backend" instead of leaving them to guess.
 *
 * The line looks roughly like:
 *   system_info: n_threads = 4 | AVX = 1 | ... | VULKAN = 1 | BLAS = 1 | ...
 */
export function parseBackends(systeminfo: string): WhisperCppBackends {
  const raw = (systeminfo ?? '').trim()
  // `NAME = 1` means present; `NAME = 0` means compiled out.
  const on = (name: string) => new RegExp(`\\b${name}\\s*=\\s*1\\b`, 'i').test(raw)
  const cuda = on('CUDA') || on('CUBLAS')
  const vulkan = on('VULKAN')
  const metal = on('METAL')
  const coreml = on('COREML')
  const openvino = on('OPENVINO')
  const blas = on('BLAS')
  return {
    cuda,
    vulkan,
    metal,
    coreml,
    openvino,
    blas,
    // BLAS is a CPU maths library, not a GPU backend — deliberately excluded
    // from this check. A BLAS build is still CPU-only.
    cpuOnly: !cuda && !vulkan && !metal && !coreml && !openvino,
    raw,
  }
}
