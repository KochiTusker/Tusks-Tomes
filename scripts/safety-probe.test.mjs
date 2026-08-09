// CLI argument-parsing tests for scripts/safety-probe.mjs. Tests only the
// pure parsing surface — running the full CLI is integration territory
// covered by the E2E live-API probe.
//
// Documented flags (must stay green):
//   --tier paid|free|both
//   --variant V0|V1|V2|all
//   --phase phase2|phase4|both
//   --fixture <id1,id2,...>  (alias: --fixtures)
//   --models <id1,id2,...>   (alias: --model)
//   --output <path>
//   --max-tokens <n>
//   --help / -h

import { describe, expect, it } from 'vitest'
import { parseArgs } from './safety-probe.mjs'

describe('parseArgs — defaults', () => {
  it('zero args → default config (both tiers, all variants, both phases)', () => {
    const out = parseArgs([])
    expect(out.tier).toBe('both')
    expect(out.variants).toEqual(['V0', 'V1', 'V2'])
    expect(out.phases).toEqual(['phase2', 'phase4'])
    expect(out.fixtureIds).toBeNull()
    expect(out.models).toBeNull()
    expect(out.output).toBeNull()
    expect(out.maxTokens).toBe(64)
  })
})

describe('parseArgs — --tier', () => {
  it('paid|free|both pass through', () => {
    expect(parseArgs(['--tier', 'paid']).tier).toBe('paid')
    expect(parseArgs(['--tier', 'free']).tier).toBe('free')
    expect(parseArgs(['--tier', 'both']).tier).toBe('both')
  })
  it('rejects invalid tier', () => {
    expect(() => parseArgs(['--tier', 'preview'])).toThrow(/--tier must be one of/)
  })
})

describe('parseArgs — --variant', () => {
  it('V0|V1|V2 pin to that single variant', () => {
    expect(parseArgs(['--variant', 'V0']).variants).toEqual(['V0'])
    expect(parseArgs(['--variant', 'V1']).variants).toEqual(['V1'])
    expect(parseArgs(['--variant', 'V2']).variants).toEqual(['V2'])
  })
  it('all expands to V0+V1+V2', () => {
    expect(parseArgs(['--variant', 'all']).variants).toEqual(['V0', 'V1', 'V2'])
  })
  it('rejects unknown variant', () => {
    expect(() => parseArgs(['--variant', 'V99'])).toThrow(/--variant must be one of/)
  })
})

describe('parseArgs — --phase', () => {
  it('phase2|phase4 pin to that single phase', () => {
    expect(parseArgs(['--phase', 'phase2']).phases).toEqual(['phase2'])
    expect(parseArgs(['--phase', 'phase4']).phases).toEqual(['phase4'])
  })
  it('both expands to phase2+phase4', () => {
    expect(parseArgs(['--phase', 'both']).phases).toEqual(['phase2', 'phase4'])
  })
  it('rejects unknown phase', () => {
    expect(() => parseArgs(['--phase', 'phase99'])).toThrow(/--phase must be one of/)
  })
})

describe('parseArgs — --fixture', () => {
  it('comma-separated list parses to array', () => {
    const out = parseArgs(['--fixture', 'f01_clean,f06_gore'])
    expect(out.fixtureIds).toEqual(['f01_clean', 'f06_gore'])
  })
  it('alias --fixtures also works', () => {
    const out = parseArgs(['--fixtures', 'f01_clean'])
    expect(out.fixtureIds).toEqual(['f01_clean'])
  })
  it('trims whitespace per entry', () => {
    const out = parseArgs(['--fixture', ' f01_clean , f06_gore '])
    expect(out.fixtureIds).toEqual(['f01_clean', 'f06_gore'])
  })
})

describe('parseArgs — --models', () => {
  it('comma-separated list parses to array', () => {
    const out = parseArgs(['--models', 'gemini-2.5-pro,gemini-2.5-flash'])
    expect(out.models).toEqual(['gemini-2.5-pro', 'gemini-2.5-flash'])
  })
  it('alias --model also works', () => {
    expect(parseArgs(['--model', 'gemini-2.5-pro']).models).toEqual(['gemini-2.5-pro'])
  })
})

describe('parseArgs — --output', () => {
  it('passes the path through', () => {
    expect(parseArgs(['--output', '/tmp/probe.md']).output).toBe('/tmp/probe.md')
  })
})

describe('parseArgs — --max-tokens', () => {
  it('positive integer passes through', () => {
    expect(parseArgs(['--max-tokens', '32']).maxTokens).toBe(32)
    expect(parseArgs(['--max-tokens', '128']).maxTokens).toBe(128)
  })
  it('rejects non-numeric', () => {
    expect(() => parseArgs(['--max-tokens', 'lots'])).toThrow(/positive integer/)
  })
  it('rejects zero / negative', () => {
    expect(() => parseArgs(['--max-tokens', '0'])).toThrow(/positive integer/)
    expect(() => parseArgs(['--max-tokens', '-1'])).toThrow(/positive integer/)
  })
})

describe('parseArgs — --help', () => {
  it('--help sets the help flag', () => {
    expect(parseArgs(['--help']).help).toBe(true)
  })
  it('-h is the short form', () => {
    expect(parseArgs(['-h']).help).toBe(true)
  })
})

describe('parseArgs — unknown args', () => {
  it('throws on unknown flag', () => {
    expect(() => parseArgs(['--make-coffee'])).toThrow(/Unknown argument/)
  })
})

describe('parseArgs — combinations', () => {
  it('honors multiple flags at once', () => {
    const out = parseArgs([
      '--tier', 'paid',
      '--variant', 'V1',
      '--phase', 'phase2',
      '--fixture', 'f01_clean,f06_gore',
      '--max-tokens', '32',
    ])
    expect(out.tier).toBe('paid')
    expect(out.variants).toEqual(['V1'])
    expect(out.phases).toEqual(['phase2'])
    expect(out.fixtureIds).toEqual(['f01_clean', 'f06_gore'])
    expect(out.maxTokens).toBe(32)
  })
})
