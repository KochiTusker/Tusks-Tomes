// The result of a multitrack upload, as returned by the extract and append
// endpoints.

export type ExtractedTrack = {
  /** Synthetic or Craig-derived speaker ID. Stable within a session. */
  speakerId: string
  /** Filename-derived display name shown in the UI. */
  displayName: string
  /** Path to the audio file relative to the session's audio directory. */
  filename: string
  /** Detected duration in milliseconds. 0 if probe failed. */
  durationMs: number
  /** Chunk index this track belongs to. 0 for single-chunk uploads. */
  chunkIndex: number
  /** Craig's per-recording track number, when the filename carried one.
   *  Display/ordering only — see shared/speakers/identity.ts for why it
   *  must never be used as identity. */
  trackIndex?: number
}

export type ExtractedChunk = {
  /** 0-based order in which the chunk was processed. */
  index: number
  /** Where this chunk starts in session-relative time. */
  startedAtMs: number
  /** Chunk duration (max of its speakers' track durations). */
  durationMs: number
  /** Display label — zip filename or "Loose files". */
  label: string
  /** Tracks within this chunk. */
  tracks: ExtractedTrack[]
}

export type ExtractResult = {
  sessionId: string
  chunks: ExtractedChunk[]
  /** Flat track list across all chunks, for the legacy single-chunk UI path. */
  tracks: ExtractedTrack[]
  /** Total session duration in ms after this batch was stitched on. For an
   *  append call this is the position where the NEXT appended batch would
   *  start (part 1 + part 2 + ... so far). */
  totalDurationMs: number
}
