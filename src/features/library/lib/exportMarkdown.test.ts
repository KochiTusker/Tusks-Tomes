import { describe, expect, it } from 'vitest'
import { buildMarkdown, buildPartialMarkdown, lastCompletedPhase } from './exportMarkdown'
import { initialRefinementState, type RefinementState } from '@/features/pipeline'

function makeState(over: Partial<RefinementState> = {}): RefinementState {
  return { ...initialRefinementState, ...over }
}

describe('lastCompletedPhase', () => {
  it('returns 0 for an untouched state', () => {
    expect(lastCompletedPhase(makeState())).toBe(0)
  })
  it('returns 1 after grounding', () => {
    expect(lastCompletedPhase(makeState({ groundedTranscript: 'g' }))).toBe(1)
  })
  it('returns 2 after questions land (even if grounded too)', () => {
    expect(
      lastCompletedPhase(
        makeState({ groundedTranscript: 'g', dmQuestions: [{ id: 'q', question: 'q?', context: '' }] }),
      ),
    ).toBe(2)
  })
  it('returns 3 after chronicle prose lands', () => {
    expect(lastCompletedPhase(makeState({ chronicle: 'prose' }))).toBe(3)
  })
  it('returns 4 after extras land', () => {
    expect(
      lastCompletedPhase(makeState({ chronicle: 'prose', extras: { jests: [], gore: [], quotes: [] } })),
    ).toBe(4)
  })
  it('returns 6 when condensed exists', () => {
    expect(
      lastCompletedPhase(makeState({ chronicle: 'prose', condensed: { narrative: '', bulletPoints: [] } })),
    ).toBe(6)
  })
})

describe('buildPartialMarkdown', () => {
  it('produces a phase-0 stub when nothing has run yet', () => {
    const md = buildPartialMarkdown(makeState({ campaign: 'Acme', sessionNumber: 1 }))
    expect(md).toContain('# Acme — Session 1')
    expect(md).toContain('partial export')
    expect(md).toContain('Phase 0')
  })

  it('includes the grounded transcript when only Phase 1 has completed', () => {
    const md = buildPartialMarkdown(
      makeState({ campaign: 'Acme', sessionNumber: 1, groundedTranscript: 'GROUNDED-BODY' }),
    )
    expect(md).toContain('Phase 1')
    expect(md).toContain('Grounded Transcript')
    expect(md).toContain('GROUNDED-BODY')
  })

  it('includes DM questions when Phase 2 has produced them', () => {
    const md = buildPartialMarkdown(
      makeState({
        campaign: 'Acme',
        sessionNumber: 1,
        groundedTranscript: 'GROUNDED-BODY',
        dmQuestions: [{ id: 'q1', question: 'Who attacked the manor?', context: 'cross-talk in chunk 3' }],
      }),
    )
    expect(md).toContain('DM Clarifications')
    expect(md).toContain('Who attacked the manor?')
    expect(md).toContain('cross-talk in chunk 3')
  })

  it('hands off to buildMarkdown when chronicle exists (Phase 3+)', () => {
    const md = buildPartialMarkdown(
      makeState({
        campaign: 'Acme',
        sessionNumber: 1,
        groundedTranscript: 'g',
        chronicle: 'CHRONICLE-PROSE',
      }),
    )
    expect(md).toContain('CHRONICLE-PROSE')
    expect(md).toContain('## Chronicle')
    // Should NOT include the partial-only "Grounded Transcript" section
    // when chronicle has landed.
    expect(md).not.toContain('## Grounded Transcript')
  })

  it('renders raw transcript when grounding has not completed yet', () => {
    const md = buildPartialMarkdown(
      makeState({ campaign: 'Acme', sessionNumber: 1, rawTranscript: 'RAW-CRAIG-OUTPUT' }),
    )
    expect(md).toContain('## Raw Transcript')
    expect(md).toContain('RAW-CRAIG-OUTPUT')
  })
})

describe('buildMarkdown (full export — back-compat)', () => {
  it('produces the same headers as before extraction', () => {
    const md = buildMarkdown({
      campaign: 'Acme',
      sessionNumber: 1,
      chronicle: 'prose',
      extras: { jests: ['hilarious'], gore: ['ouch'], quotes: [{ speaker: 'X', line: 'Y', kind: 'funny' }] },
      condensed: { narrative: 'tightened', bulletPoints: ['a', 'b'] },
    })
    expect(md).toContain('# Acme — Session 1')
    expect(md).toContain('## Chronicle')
    expect(md).toContain('## Condensed Chronicle')
    expect(md).toContain('## Catch-up Recap')
    expect(md).toContain('## Jests')
    expect(md).toContain('## Gore')
    expect(md).toContain('## Quotes')
    expect(md).toContain('### Funny')
    expect(md).toContain('- **X:** "Y"')
  })

  it('nests an exchange under its participants instead of one run-on line', () => {
    const md = buildMarkdown({
      campaign: 'Acme',
      sessionNumber: 1,
      chronicle: 'prose',
      extras: {
        jests: [],
        gore: [],
        quotes: [
          {
            speaker: 'Eamon, Maeve & Verity',
            line: 'flattened fallback',
            kind: 'funny',
            // Deliberately does NOT open with a character name. Rendered, this
            // becomes `_<context>_`, and an underscore is a word character —
            // so a leading name would sit at `_Name`, where the fixture-name
            // rotation's word-boundary substitution cannot see it. The fixture
            // would then move on while this expectation kept the old name.
            context: 'The mule had gone missing two days earlier.',
            exchange: [
              { speaker: 'Eamon', line: 'Did you feed the mule this morning?' },
              { speaker: 'Maeve', line: 'I always feed the mule.' },
              { speaker: 'Verity', line: "You can't even see the mule from here." },
            ],
          },
        ],
      },
      condensed: null,
    })
    expect(md).toContain('- **Eamon, Maeve & Verity** — _The mule had gone missing two days earlier._')
    expect(md).toContain('  - **Eamon:** "Did you feed the mule this morning?"')
    expect(md).toContain('  - **Maeve:** "I always feed the mule."')
    expect(md).toContain('  - **Verity:** "You can\'t even see the mule from here."')
    // The flattened fallback is for legacy consumers, not the markdown export.
    expect(md).not.toContain('flattened fallback')
  })
})

describe('buildMarkdown (pinned full output)', () => {
  // Both Markdown downloads (result view and saved-chronicles list) use this
  // builder, so the exact file is pinned here.
  it('renders the chronicle, condensed, recap, jests, gore and quotes in order', () => {
    const md = buildMarkdown({
      campaign: 'Acme',
      sessionNumber: 2,
      chronicle: '  prose  ',
      extras: {
        jests: ['j1'],
        gore: ['g1'],
        quotes: [
          { speaker: 'A', line: 'one', kind: 'funny' },
          { speaker: 'B', line: 'two', kind: 'dark', context: 'late' },
        ],
      },
      condensed: { narrative: 'short', bulletPoints: ['b1'] },
    })
    expect(md).toBe(
      [
        '# Acme — Session 2',
        '',
        '## Chronicle',
        '',
        'prose',
        '\n## Condensed Chronicle',
        '',
        'short',
        '\n## Catch-up Recap',
        '- b1',
        '\n## Jests',
        '- j1',
        '\n## Gore',
        '- g1',
        '\n## Quotes',
        '\n### Funny',
        '- **A:** "one"',
        '\n### Dark',
        '- **B:** "two" — _late_',
      ].join('\n'),
    )
  })
})
