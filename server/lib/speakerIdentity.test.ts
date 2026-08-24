import { describe, expect, it } from 'vitest'
import {
  findSpeakerFor,
  isLegacyTrackIndexId,
  isSnowflake,
  parseSpeakerFromFilename,
  speakerIdFromName,
} from './speakerIdentity.js'

describe('parseSpeakerFromFilename — Craig track index', () => {
  // The bug this guards: Craig numbers tracks by join order within ONE
  // recording. Uploading a session as two Craig zips gave the same person
  // a different number in each, so keying identity on it merged two
  // different people and filed Part 2's audio under Part 1's character.
  it('does NOT use the track index as identity', () => {
    const { speakerId, trackIndex } = parseSpeakerFromFilename('3-dicegoblin.flac')
    expect(speakerId).not.toBe('3')
    expect(trackIndex).toBe(3)
  })

  it('gives the same speakerId when the same person moves track number', () => {
    // Part 1: joined third. Part 2: joined first.
    const part1 = parseSpeakerFromFilename('3-dicegoblin.flac')
    const part2 = parseSpeakerFromFilename('1-dicegoblin.flac')
    expect(part1.speakerId).toBe(part2.speakerId)
    expect(part1.trackIndex).toBe(3)
    expect(part2.trackIndex).toBe(1)
  })

  it('gives DIFFERENT speakerIds to two people sharing a track number across parts', () => {
    // The wrong-attribution case: track 1 is a different human in each zip.
    const a = parseSpeakerFromFilename('1-zz1234.flac')
    const b = parseSpeakerFromFilename('1-mossknight_.flac')
    expect(a.speakerId).not.toBe(b.speakerId)
  })

  it('is case- and whitespace-insensitive on the username', () => {
    expect(parseSpeakerFromFilename('2-KochiTusker.flac').speakerId).toBe(
      parseSpeakerFromFilename('7- kochitusker .flac').speakerId,
    )
  })

  it('keeps the display name as the Discord username', () => {
    expect(parseSpeakerFromFilename('5-bardcore.aac').displayName).toBe('bardcore')
  })

  it('accepts underscore as the separator', () => {
    const parsed = parseSpeakerFromFilename('4_lanternfly.flac')
    expect(parsed.trackIndex).toBe(4)
    expect(parsed.displayName).toBe('lanternfly')
  })
})

describe('parseSpeakerFromFilename — Discord snowflake', () => {
  it('uses a real snowflake as identity (it is globally stable)', () => {
    const parsed = parseSpeakerFromFilename('100000000000000042-quillfeather.flac')
    expect(parsed.speakerId).toBe('100000000000000042')
    expect(parsed.displayName).toBe('quillfeather')
    expect(parsed.trackIndex).toBeUndefined()
  })

  it('treats the snowflake as identity regardless of the username', () => {
    const a = parseSpeakerFromFilename('100000000000000042-quillfeather.flac')
    const b = parseSpeakerFromFilename('100000000000000042-quillfeather_renamed.flac')
    expect(a.speakerId).toBe(b.speakerId)
  })
})

describe('parseSpeakerFromFilename — generic files', () => {
  it('derives identity from the stem when there is no numeric prefix', () => {
    const parsed = parseSpeakerFromFilename('Dungeon Master.wav')
    expect(parsed.displayName).toBe('Dungeon Master')
    expect(parsed.speakerId).toBe(speakerIdFromName('Dungeon Master'))
    expect(parsed.trackIndex).toBeUndefined()
  })

  it('handles a stem that is only a separator away from empty', () => {
    expect(parseSpeakerFromFilename('9-.flac').displayName).toBe('9-')
  })

  it('produces a filesystem-safe id (used as an audio/<id>/ dir name)', () => {
    const id = parseSpeakerFromFilename('1-a/b\\c:d.flac').speakerId
    expect(id).toMatch(/^u_[0-9a-f]+$/)
  })
})

describe('isSnowflake / isLegacyTrackIndexId', () => {
  it('splits snowflakes from track indices', () => {
    expect(isSnowflake('100000000000000042')).toBe(true)
    expect(isSnowflake('12345678901234567')).toBe(true) // 17 digits
    expect(isSnowflake('1234567890123456')).toBe(false) // 16
    expect(isSnowflake('3')).toBe(false)
  })

  it('recognises legacy track-index ids already on disk', () => {
    expect(isLegacyTrackIndexId('3')).toBe(true)
    expect(isLegacyTrackIndexId('12')).toBe(true)
    expect(isLegacyTrackIndexId('u_2b5dd')).toBe(false)
    expect(isLegacyTrackIndexId('100000000000000042')).toBe(false)
  })
})

describe('findSpeakerFor', () => {
  // Mappings the user saved before the identity fix are keyed by the old
  // track-index id. Without the display-name fallback every player and
  // character name they had entered would stop applying to new uploads.
  const saved = [
    { discordUserId: '3', discordDisplayName: 'dicegoblin', characterName: 'Brody' },
    { discordUserId: 'u_abc', discordDisplayName: 'lanternfly', characterName: 'Kaziel' },
    { discordUserId: '9', characterName: 'No display name' },
  ]

  it('matches on id when present', () => {
    expect(findSpeakerFor(saved, 'u_abc', 'lanternfly')?.characterName).toBe('Kaziel')
  })

  it('falls back to display name for a legacy-keyed row', () => {
    expect(findSpeakerFor(saved, 'u_new', 'dicegoblin')?.characterName).toBe('Brody')
  })

  it('is case-insensitive on the display name', () => {
    expect(findSpeakerFor(saved, 'u_new', ' DiceGoblin ')?.characterName).toBe('Brody')
  })

  it('prefers an id match over a display-name match', () => {
    const rows = [
      { discordUserId: 'x', discordDisplayName: 'dup', characterName: 'by-name' },
      { discordUserId: 'target', discordDisplayName: 'dup', characterName: 'by-id' },
    ]
    expect(findSpeakerFor(rows, 'target', 'dup')?.characterName).toBe('by-id')
  })

  it('returns undefined rather than guessing when there is no display name', () => {
    expect(findSpeakerFor(saved, 'unknown', undefined)).toBeUndefined()
    expect(findSpeakerFor(saved, 'unknown', '   ')).toBeUndefined()
  })
})
