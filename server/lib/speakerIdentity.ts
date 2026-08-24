// Stable speaker identity for uploaded multitrack sessions.
//
// Craig names each track in a multitrack download as either
//   "<trackIndex>-<username>.flac"      (Craig 2.x — track index)
//   "<discordUserId>-<username>.flac"   (newer exports — real snowflake)
//
// The track index is assigned PER RECORDING, in the order people joined
// the voice channel. It is not an identity. Record one session as two
// Craig recordings and the same person is very likely track 3 in the
// first zip and track 5 in the second — Discord reconnects rarely
// happen in the same order twice.
//
// Keying a participant on that number therefore merges two different
// people when a second batch is appended, and files Part 2's audio under
// Part 1's character. It also makes the persistent speakers.json mapping
// wrong for every subsequent session, because "3 → Brody" only held for
// the one recording it was saved from.
//
// So the numeric prefix is used as identity ONLY when it is long enough
// to be a Discord snowflake. Otherwise identity is derived from the
// username, which IS stable for the same account across recordings.

/** Discord snowflakes are 17+ digits; Craig track indices are 1-3. */
export const SNOWFLAKE_MIN_DIGITS = 17

export type ParsedSpeaker = {
  /** Stable within a session AND across separately-uploaded batches. */
  speakerId: string
  /** Filename-derived display name shown in the UI (the Discord username). */
  displayName: string
  /** Craig's per-recording track number, when the filename carried one.
   *  Ordering/display only — never identity. */
  trackIndex?: number
}

export function isSnowflake(digits: string): boolean {
  return digits.length >= SNOWFLAKE_MIN_DIGITS
}

/** True for speaker IDs written before identity moved off the track
 *  index. Sessions recorded then still carry these in their manifest. */
export function isLegacyTrackIndexId(id: string): boolean {
  return /^\d{1,3}$/.test(id)
}

/** Synthetic ID derived from a Discord username. Case- and
 *  whitespace-insensitive so the same account collapses to one ID.
 *  Filesystem-safe: the ID is used as an audio/<id>/ directory name. */
export function speakerIdFromName(name: string): string {
  return `u_${hashAscii(name.trim().toLowerCase())}`
}

/**
 * Filename conventions recognised:
 *   - Craig 2.x:     "1-{username}.flac"          → identity from username
 *   - Craig (newer): "{discordUserId}-{username}"  → identity from the ID
 *   - Generic:       "{displayName}.{ext}"         → identity from the stem
 */
export function parseSpeakerFromFilename(originalName: string): ParsedSpeaker {
  const stem = originalName.replace(/\.[^./\\]+$/, '')
  const numericPrefix = stem.match(/^(\d+)[-_](.+)$/)
  if (numericPrefix) {
    const digits = numericPrefix[1]
    const name = numericPrefix[2].trim() || 'Unnamed'
    if (isSnowflake(digits)) {
      // A real Discord user ID — globally stable, so use it directly.
      return { speakerId: digits, displayName: name }
    }
    // Craig track index: keep it for ordering, never for identity.
    return { speakerId: speakerIdFromName(name), displayName: name, trackIndex: Number(digits) }
  }
  const name = stem.trim() || 'Unnamed'
  return { speakerId: speakerIdFromName(name), displayName: name }
}

/**
 * Resolve a saved speaker row for one manifest participant.
 *
 * Matches on ID first, then falls back to the Discord display name, so a
 * mapping saved against a legacy track-index ID still resolves for
 * sessions uploaded after the identity fix. Without the fallback, every
 * player/character name the user had already entered would silently stop
 * applying to new uploads.
 */
export function findSpeakerFor<T extends { discordUserId: string; discordDisplayName?: string }>(
  speakers: readonly T[],
  userId: string,
  displayName: string | undefined,
): T | undefined {
  const byId = speakers.find((s) => s.discordUserId === userId)
  if (byId) return byId
  const needle = displayName?.trim().toLowerCase()
  if (!needle) return undefined
  return speakers.find((s) => s.discordDisplayName?.trim().toLowerCase() === needle)
}

function hashAscii(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
  }
  return h.toString(16)
}
