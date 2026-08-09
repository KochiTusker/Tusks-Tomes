import { MAX_OUTPUT_TOKENS } from './constants'
import { chunkSizeFor as chunkSizeForProvider } from './chunking'
import { estimateTokensFromChars } from './rateLimit'
import { getProviderSettings, isLocalProvider } from './providers/settings'
import { ensureProvidersInitialized, getActiveProvider } from './providers'
import type { CloudProvider } from './profiles'
import { buildKbConcat } from './pipeline'
import { combineRules, formatContextualHints, preGround, type PreGroundReport } from './preGround'
import { getGlossary } from './glossary'
import { sbvRepair, sbvRepairParts } from './prompts'
import { cleanupTranscript, type CleanupReport } from './transcriptCleanup'
import type { KBDocument, SbvCue } from '@/types'

export type SbvGroundEvent =
  | { type: 'start'; totalChunks: number; totalCues: number }
  | {
      type: 'chunk_done'
      chunkIndex: number
      totalChunks: number
      cuesUpdated: SbvCue[]
      changedInThisChunk: number
      totalChangedSoFar: number
    }
  | { type: 'countdown'; msRemaining: number }
  | { type: 'pre_ground'; report: PreGroundReport }
  | { type: 'cleanup'; report: CleanupReport }
  | { type: 'complete'; cues: SbvCue[]; totalChanged: number }

export type SbvGroundCallbacks = {
  onEvent: (e: SbvGroundEvent) => void
  signal?: AbortSignal
}

function pacingSleep(
  ms: number,
  signal?: AbortSignal,
  onTick?: (remaining: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'))
    const start = Date.now()
    let interval: ReturnType<typeof setInterval> | null = null
    const cleanup = () => {
      if (interval) clearInterval(interval)
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      cleanup()
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (onTick) {
      onTick(ms)
      interval = setInterval(() => {
        const remaining = Math.max(0, ms - (Date.now() - start))
        onTick(remaining)
        if (remaining <= 0 && interval) {
          clearInterval(interval)
          interval = null
        }
      }, 1000)
    }
    setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
  })
}

type CueRange = { start: number; end: number }

/** Default target chars for SBV chunking when the caller doesn't pass one.
 *  Matches the Gemini-paid Phase 1 size; the actual repair pipeline at
 *  runtime overrides this with a provider-specific value. */
const SBV_DEFAULT_CHUNK_CHARS = 30_000

/** Pack contiguous cues into chunks whose marked-up text fits the target. */
export function packCueChunks(cues: SbvCue[], target: number = SBV_DEFAULT_CHUNK_CHARS): CueRange[] {
  if (!cues.length) return []
  const ranges: CueRange[] = []
  let curStart = 0
  let curLen = 0
  for (let i = 0; i < cues.length; i++) {
    // Estimate the marked line length for this cue.
    const markerOverhead = `[${i + 1}] \n`.length
    const lineLen = markerOverhead + cues[i].text.length
    if (curLen > 0 && curLen + lineLen > target) {
      ranges.push({ start: curStart, end: i })
      curStart = i
      curLen = 0
    }
    curLen += lineLen
  }
  if (curStart < cues.length) ranges.push({ start: curStart, end: cues.length })
  return ranges
}

function buildMarkedLines(cues: SbvCue[], range: CueRange): string {
  const out: string[] = []
  for (let i = range.start; i < range.end; i++) {
    // Flatten any internal newlines so each cue is exactly one line in the prompt.
    const flat = cues[i].text.replace(/\s*\n\s*/g, ' ').trim()
    // Use 1-based numbering matching cue position in the original file.
    out.push(`[${i + 1}] ${flat}`)
  }
  return out.join('\n')
}

const MARKER_RE = /^\s*\[(\d+)\]\s*(.*)$/

/** Parse the model's marked output into a Map<lineNumber, correctedText>. */
export function parseMarkedOutput(raw: string): Map<number, string> {
  const result = new Map<number, string>()
  // Strip code fences if the model wrapped things despite the prompt.
  const cleaned = raw
    .replace(/^\s*```(?:\w+)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')

  // Some models emit a marker followed by wrapped continuation lines.
  // Walk lines and accumulate continuation into the most recent marker.
  let lastNum: number | null = null
  for (const rawLine of cleaned.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '')
    if (!line.trim()) {
      lastNum = null
      continue
    }
    const m = line.match(MARKER_RE)
    if (m) {
      lastNum = Number(m[1])
      result.set(lastNum, (m[2] ?? '').trim())
    } else if (lastNum != null) {
      const existing = result.get(lastNum) ?? ''
      result.set(lastNum, (existing ? existing + ' ' : '') + line.trim())
    }
  }
  return result
}

/** Apply a chunk's corrections to the cue array. Returns count of changes made. */
function applyChunkCorrections(
  cues: SbvCue[],
  range: CueRange,
  corrections: Map<number, string>
): { updatedCues: SbvCue[]; changed: number } {
  const updatedCues = cues.slice()
  let changed = 0
  for (let i = range.start; i < range.end; i++) {
    const lineNum = i + 1
    const corrected = corrections.get(lineNum)
    if (corrected == null) continue // Missing → keep original (defensive)
    const cleaned = corrected.trim()
    if (!cleaned) continue // Empty → keep original
    if (cleaned !== cues[i].text.replace(/\s*\n\s*/g, ' ').trim()) {
      updatedCues[i] = { ...cues[i], text: cleaned }
      changed++
    }
  }
  return { updatedCues, changed }
}

/**
 * Run grounding over an SBV cue list. Each chunk is sent to Gemini with [N]
 * markers; the response is parsed and corrections are applied per cue.
 * Cues with missing or empty corrections fall back to their original text.
 */
export async function groundSbvCues(args: {
  cues: SbvCue[]
  kb: KBDocument[]
  callbacks: SbvGroundCallbacks
  startChunkIndex?: number
  priorCues?: SbvCue[]
  priorChanged?: number
}): Promise<{ cues: SbvCue[]; totalChanged: number }> {
  const { cues, kb, callbacks } = args
  const startChunkIndex = args.startChunkIndex ?? 0

  // Load the user glossary once per run; merge with the built-in dictionary.
  const glossary = await getGlossary()
  const allRules = combineRules(glossary.safeReplacements)

  // 1. Per-cue text cleanup (markers, fillers, whitespace). Timestamps
  //    untouched since cue ordering is preserved.
  let cleanupTotalMarkers = 0
  let cleanupTotalFillers = 0
  let cleanupAnyWhitespace = false

  // 2. Per-cue safeReplacements (user glossary + dndDictionary.ts).
  let preGroundedChanged = 0
  const aggregatePerRule = new Map<string, { from: string; to: string; count: number }>()

  const cleanedCues = cues.map((c) => {
    // Cleanup first
    const { text: afterCleanup, report: cleanupRpt } = cleanupTranscript(c.text)
    cleanupTotalMarkers += cleanupRpt.markersStripped
    cleanupTotalFillers += cleanupRpt.fillersCollapsed
    if (cleanupRpt.whitespaceNormalized) cleanupAnyWhitespace = true

    // Then pre-ground
    const { text: cleaned, report } = preGround(afterCleanup, allRules)
    for (const r of report.perRule) {
      const key = `${r.from}::${r.to}`
      const existing = aggregatePerRule.get(key)
      if (existing) existing.count += r.count
      else aggregatePerRule.set(key, { ...r })
    }
    const changed = afterCleanup !== c.text || cleaned !== afterCleanup
    if (changed) {
      preGroundedChanged++
      return { ...c, text: cleaned }
    }
    return c
  })

  if (cleanupTotalMarkers > 0 || cleanupTotalFillers > 0 || cleanupAnyWhitespace) {
    callbacks.onEvent({
      type: 'cleanup',
      report: {
        markersStripped: cleanupTotalMarkers,
        fillersCollapsed: cleanupTotalFillers,
        whitespaceNormalized: cleanupAnyWhitespace,
      },
    })
  }
  const aggregateReport: PreGroundReport = {
    perRule: Array.from(aggregatePerRule.values()),
    totalReplacements: Array.from(aggregatePerRule.values()).reduce(
      (acc, r) => acc + r.count,
      0
    ),
  }
  if (aggregateReport.totalReplacements > 0) {
    callbacks.onEvent({ type: 'pre_ground', report: aggregateReport })
  }

  const contextualHintsBlock = formatContextualHints(glossary.contextualHints)

  // Pack chunks AFTER pre-grounding so chunk sizing reflects the actual prompt.
  // Local providers get smaller packs so each call's prompt fits the GPU's VRAM.
  // SBV repair runs through the active provider; cloud-provider name lets the
  // chunker pick the right per-provider size.
  const activeProviderName = getActiveProvider().name
  const cloudProviderName: CloudProvider | undefined =
    activeProviderName === 'gemini' || activeProviderName === 'claude' || activeProviderName === 'openai'
      ? activeProviderName
      : undefined
  const targetChars = chunkSizeForProvider({
    phase: 'p1',
    isLocal: isLocalProvider(),
    cloudProvider: cloudProviderName,
  })
  const ranges = packCueChunks(cleanedCues, targetChars)

  let workingCues = args.priorCues ? args.priorCues.slice() : cleanedCues.slice()
  let totalChanged = args.priorChanged ?? preGroundedChanged

  callbacks.onEvent({
    type: 'start',
    totalChunks: ranges.length,
    totalCues: cues.length,
  })

  if (!ranges.length) {
    callbacks.onEvent({ type: 'complete', cues: workingCues, totalChanged })
    return { cues: workingCues, totalChanged }
  }

  await ensureProvidersInitialized()
  const kbConcat = buildKbConcat(kb)
  const provider = getActiveProvider()
  const settings = getProviderSettings()
  const model = settings.proModel
  const usingLocal = isLocalProvider()

  for (let i = startChunkIndex; i < ranges.length; i++) {
    if (callbacks.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const range = ranges[i]
    const marked = buildMarkedLines(cleanedCues, range)
    let systemPrompt = ''
    let cacheablePrefix: string | undefined
    let userPrompt: string
    if (usingLocal) {
      userPrompt = sbvRepair({
        kbConcat,
        markedLines: marked,
        index: i,
        total: ranges.length,
        contextualHintsBlock,
      })
    } else {
      const parts = sbvRepairParts({
        kbConcat,
        markedLines: marked,
        index: i,
        total: ranges.length,
        contextualHintsBlock,
      })
      cacheablePrefix = parts.cacheablePrefix
      userPrompt = parts.userPrompt
    }

    // Pace before each cloud call — provider's RateLimitState owns the math.
    if (!usingLocal) {
      const promptChars =
        (systemPrompt?.length ?? 0) + (cacheablePrefix?.length ?? 0) + userPrompt.length
      const delayMs = provider.getNextDelayMs?.(estimateTokensFromChars(promptChars)) ?? 0
      if (delayMs > 0) {
        await pacingSleep(delayMs, callbacks.signal, (ms) =>
          callbacks.onEvent({ type: 'countdown', msRemaining: ms })
        )
      }
    }

    const { text } = await provider.generate(
      {
        systemPrompt,
        cacheablePrefix,
        userPrompt,
        model,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        safetyMode: 'permissive',
      },
      {
        signal: callbacks.signal,
        contextLabel: `SBV Repair — chunk ${i + 1}/${ranges.length}`,
      }
    )
    const corrections = parseMarkedOutput(text)
    const { updatedCues, changed } = applyChunkCorrections(workingCues, range, corrections)
    workingCues = updatedCues
    totalChanged += changed
    callbacks.onEvent({
      type: 'chunk_done',
      chunkIndex: i,
      totalChunks: ranges.length,
      cuesUpdated: workingCues,
      changedInThisChunk: changed,
      totalChangedSoFar: totalChanged,
    })
  }

  callbacks.onEvent({ type: 'complete', cues: workingCues, totalChanged })
  return { cues: workingCues, totalChanged }
}
