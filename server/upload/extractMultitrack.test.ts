// Zip Slip defence regression. extractMultitrack.ts iterates the zip
// entries before extraction and rejects any whose resolved target
// escapes the workdir.
//
// adm-zip itself sanitises `../` segments away on addFile() — so a
// proper hostile zip can't be constructed through its public API.
// The runtime defence still matters because the .zip on disk could
// have been crafted by another library (or by hand) with traversal
// entries intact; that's the actual attack scenario.
//
// This test exercises the predicate directly on a synthesised entry
// list rather than crafting a real malicious archive (which would
// require building a zip header by hand).

import { describe, expect, it } from 'vitest'
import path from 'node:path'

// Import the REAL predicate from the production module. Phase 6.3
// closed the copy-paste regression that previously had a stale copy
// here. A future change to extractMultitrack.ts's predicate trips this
// test the same day, not weeks later in a /ship.
import { isEntrySafe } from './extractMultitrack.js'

describe('Zip Slip predicate (workdir containment)', () => {
  const workdir = path.resolve('/tmp/zipslip-fixture')

  // Hostile entry names — must all be rejected.
  const hostile = [
    '../escape.flac',
    '../../escape.flac',
    '../../../etc/passwd',
    '/etc/passwd',
    '/C:/Windows/System32/foo',
    'sub/../../escape.flac',
    'a/../../../../../escape.flac',
  ]
  for (const name of hostile) {
    it(`rejects hostile entry ${JSON.stringify(name)}`, () => {
      expect(isEntrySafe(workdir, name)).toBe(false)
    })
  }

  // Benign entries — must all pass.
  const benign = [
    'a.flac',
    'sub/b.flac',
    'deep/nested/path/c.flac',
    './d.flac',
  ]
  for (const name of benign) {
    it(`accepts benign entry ${JSON.stringify(name)}`, () => {
      expect(isEntrySafe(workdir, name)).toBe(true)
    })
  }
})
