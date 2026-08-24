// Markdown export for the chronicle view + partial-state export from the
// rate-limit dialog. Extracted from ChronicleView so both call sites share
// one renderer.

import type { CondenseOutput, ExtrasOutput, Quote, RefinementState } from '@/types'

export type MarkdownArgs = {
  campaign: string
  sessionNumber: number
  chronicle: string
  extras: ExtrasOutput | null
  condensed: CondenseOutput | null
}

/** One quote as markdown list lines. A single-line quote is one bullet; an
 *  exchange is a participant bullet with the turns nested beneath it, so the
 *  back-and-forth reads in order instead of collapsing to one run-on line. */
function quoteMarkdown(q: Quote): string[] {
  if (!q.exchange?.length) {
    const suffix = q.context ? ` — _${q.context}_` : ''
    return [`- **${q.speaker}:** "${q.line}"${suffix}`]
  }
  const head = q.context ? `- **${q.speaker}** — _${q.context}_` : `- **${q.speaker}**`
  return [head, ...q.exchange.map((t) => `  - **${t.speaker}:** "${t.line}"`)]
}

/** Build a markdown export of a completed chronicle. Tolerates partial
 *  state — empty/missing sections are omitted or filled with placeholders.
 *  The original (pre-extraction) renderer lived in ChronicleView.tsx. */
export function buildMarkdown(args: MarkdownArgs): string {
  const { campaign, sessionNumber, chronicle, extras, condensed } = args
  const lines: string[] = []
  lines.push(`# ${campaign || 'Campaign'} — Session ${sessionNumber}`)
  lines.push('')
  lines.push('## Chronicle')
  lines.push('')
  lines.push(chronicle.trim() || '_(empty)_')
  if (condensed) {
    if (condensed.narrative.trim()) {
      lines.push('\n## Condensed Chronicle')
      lines.push('')
      lines.push(condensed.narrative.trim())
    }
    if (condensed.bulletPoints.length) {
      lines.push('\n## Catch-up Recap')
      condensed.bulletPoints.forEach((b) => lines.push(`- ${b}`))
    }
  }
  if (extras) {
    if (extras.jests.length) {
      lines.push('\n## Jests')
      extras.jests.forEach((j) => lines.push(`- ${j}`))
    }
    if (extras.gore.length) {
      lines.push('\n## Gore')
      extras.gore.forEach((g) => lines.push(`- ${g}`))
    }
    if (extras.quotes.length) {
      const groups = {
        funny: extras.quotes.filter((q) => (q.kind ?? 'funny') === 'funny'),
        stupid: extras.quotes.filter((q) => q.kind === 'stupid'),
        dark: extras.quotes.filter((q) => q.kind === 'dark'),
      }
      lines.push('\n## Quotes')
      for (const [label, list] of [
        ['Funny', groups.funny],
        ['Stupid', groups.stupid],
        ['Dark', groups.dark],
      ] as const) {
        if (!list.length) continue
        lines.push(`\n### ${label}`)
        list.forEach((q) => lines.push(...quoteMarkdown(q)))
      }
    }
  }
  return lines.join('\n')
}

/** Highest pipeline phase that has produced output in the current state.
 *  Used by the partial-export header so the reader knows where the run
 *  was stopped. */
export function lastCompletedPhase(state: RefinementState): 0 | 1 | 2 | 3 | 4 | 6 {
  if (state.condensed) return 6
  if (state.extras) return 4
  if (state.chronicle.trim()) return 3
  if (state.dmQuestions.length > 0) return 2
  if (state.groundedTranscript.trim()) return 1
  return 0
}

/**
 * Render the in-progress state as markdown. Includes whatever phases
 * completed plus the grounded transcript when no chronicle exists yet
 * (so even a phase-1-only stop produces something usable).
 */
export function buildPartialMarkdown(state: RefinementState): string {
  const last = lastCompletedPhase(state)
  const header = [
    `# ${state.campaign || 'Campaign'} — Session ${state.sessionNumber}`,
    '',
    `_(partial export — pipeline stopped after Phase ${last || '0 (nothing produced yet)'}.)_`,
    '',
  ]

  // Phase 3+ uses the same renderer as the full export so the layout
  // matches a completed chronicle.
  if (last >= 3) {
    return [
      header[0],
      header[2],
      '',
      buildMarkdown({
        campaign: state.campaign,
        sessionNumber: state.sessionNumber,
        chronicle: state.chronicle,
        extras: state.extras,
        condensed: state.condensed,
      })
        // strip the duplicate title the full renderer adds back
        .split('\n')
        .slice(1)
        .join('\n'),
    ].join('\n')
  }

  // Phase 1 / 2 — emit the grounded transcript (and any DM questions
  // raised so far) so the user can at least eyeball the grounded text.
  const lines: string[] = [...header]
  if (state.groundedTranscript.trim()) {
    lines.push('## Grounded Transcript (Phase 1 output)')
    lines.push('')
    lines.push(state.groundedTranscript.trim())
  } else {
    lines.push('## Raw Transcript')
    lines.push('')
    lines.push(state.rawTranscript.trim() || '_(empty)_')
  }
  if (state.dmQuestions.length > 0) {
    lines.push('')
    lines.push('## DM Clarifications (Phase 2)')
    state.dmQuestions.forEach((q, i) => {
      lines.push(`${i + 1}. **${q.question}**`)
      if (q.context) lines.push(`   _"${q.context}"_`)
      const answer = state.dmAnswers[q.id]
      if (answer) lines.push(`   → ${answer}`)
    })
  }
  return lines.join('\n')
}

export function downloadMarkdownFile(filename: string, contents: string): void {
  const blob = new Blob([contents], { type: 'text/markdown' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
