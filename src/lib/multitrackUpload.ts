// React-side client for the multitrack upload endpoints. Mirrors the
// shape of src/lib/sessionsClient.ts; kept separate because uploads use
// multipart form data and need different error/progress plumbing.

export type ExtractedTrack = {
  speakerId: string
  displayName: string
  filename: string
  durationMs: number
  chunkIndex: number
}

export type ExtractedChunk = {
  index: number
  startedAtMs: number
  durationMs: number
  label: string
  tracks: ExtractedTrack[]
}

export type ExtractResult = {
  sessionId: string
  chunks: ExtractedChunk[]
  tracks: ExtractedTrack[]
  /**
   * Total session duration in ms after this batch was stitched on.
   * For append calls, this is the position where the NEXT appended
   * batch would start (Part 1 + Part 2 + … so far).
   */
  totalDurationMs: number
}

export type UploadProgress = {
  /** 0..1, or null if not yet started. Driven by XHR progress events. */
  fraction: number
  /** Bytes sent so far. */
  loaded: number
  /** Total bytes to send. */
  total: number
}

export async function uploadMultitrack(args: {
  files: File[]
  voiceChannelName?: string
  /** Map of originalFilename -> overrideDisplayName from the speaker preview UI. */
  displayNameOverrides?: Record<string, string>
  /** Order to process files in. Each entry is an `originalName`. Used for
   * multi-chunk uploads where each zip = one chunk and chunk order
   * matters for time-stitching. If omitted, upload order is used. */
  fileOrder?: string[]
  onProgress?: (p: UploadProgress) => void
  signal?: AbortSignal
}): Promise<ExtractResult> {
  if (args.files.length === 0) {
    throw new Error('Pick at least one file to upload.')
  }
  const formData = new FormData()
  for (const file of args.files) {
    formData.append('files', file, file.name)
  }
  if (args.voiceChannelName?.trim()) {
    formData.append('voiceChannelName', args.voiceChannelName.trim())
  }
  if (args.displayNameOverrides && Object.keys(args.displayNameOverrides).length > 0) {
    formData.append('displayNameOverrides', JSON.stringify(args.displayNameOverrides))
  }
  if (args.fileOrder && args.fileOrder.length > 0) {
    formData.append('fileOrder', JSON.stringify(args.fileOrder))
  }
  return postWithProgress('/api/sessions/upload-multitrack', formData, args.onProgress, args.signal)
}

/**
 * Append another batch of audio onto an existing session's timeline.
 * Same form-data shape as {@link uploadMultitrack} minus the session
 * label (the session is already labelled). On success the response
 * includes the new totalDurationMs so the UI can display "session is
 * now X long".
 */
export async function appendMultitrack(args: {
  sessionId: string
  files: File[]
  displayNameOverrides?: Record<string, string>
  fileOrder?: string[]
  onProgress?: (p: UploadProgress) => void
  signal?: AbortSignal
}): Promise<ExtractResult> {
  if (args.files.length === 0) {
    throw new Error('Pick at least one file to append.')
  }
  const formData = new FormData()
  for (const file of args.files) {
    formData.append('files', file, file.name)
  }
  if (args.displayNameOverrides && Object.keys(args.displayNameOverrides).length > 0) {
    formData.append('displayNameOverrides', JSON.stringify(args.displayNameOverrides))
  }
  if (args.fileOrder && args.fileOrder.length > 0) {
    formData.append('fileOrder', JSON.stringify(args.fileOrder))
  }
  return postWithProgress(
    `/api/sessions/${encodeURIComponent(args.sessionId)}/append-multitrack`,
    formData,
    args.onProgress,
    args.signal,
  )
}

// We use XHR (not fetch) because we want upload progress events, which
// fetch's request body doesn't expose. Multi-hour FLAC uploads can
// easily run into the tens of minutes, so a progress bar is mandatory.
function postWithProgress(
  url: string,
  formData: FormData,
  onProgress: ((p: UploadProgress) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<ExtractResult> {
  return new Promise<ExtractResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        onProgress?.({
          fraction: e.loaded / e.total,
          loaded: e.loaded,
          total: e.total,
        })
      }
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as ExtractResult)
        } catch (err) {
          reject(new Error(`Bad upload response: ${(err as Error).message}`))
        }
      } else {
        let message = `Upload failed: HTTP ${xhr.status}`
        try {
          const body = JSON.parse(xhr.responseText) as { error?: string }
          if (body.error) message = body.error
        } catch {
          // ignore — fall through with the HTTP-status message
        }
        reject(new Error(message))
      }
    }
    xhr.onerror = () => reject(new Error('Upload failed: network error.'))
    xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'))
    signal?.addEventListener('abort', () => xhr.abort(), { once: true })
    xhr.send(formData)
  })
}

export async function startMultitrackTranscription(sessionId: string): Promise<void> {
  const res = await fetch(`/api/sessions/${sessionId}/transcribe-multitrack`, {
    method: 'POST',
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Start failed: HTTP ${res.status}. ${body.slice(0, 200)}`)
  }
}

export async function cancelMultitrackUpload(sessionId: string): Promise<void> {
  await fetch(`/api/sessions/${sessionId}/upload-multitrack`, { method: 'DELETE' }).catch(
    () => undefined
  )
}

/**
 * Wipe a session's per-speaker audio files but keep manifest.json,
 * session.sbv, and the per-utterance transcript JSONs. The session
 * stays in the Sessions tab and can still hand off to Refinement —
 * but the multi-GB FLAC tracks are gone.
 */
export async function deleteSessionAudio(sessionId: string): Promise<{ bytesFreed: number }> {
  const res = await fetch(`/api/sessions/${sessionId}/audio`, { method: 'DELETE' })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Audio delete failed: HTTP ${res.status}. ${body.slice(0, 200)}`)
  }
  return (await res.json()) as { bytesFreed: number }
}

/**
 * Parse the same speaker-from-filename rules the server uses, for the
 * pre-upload speaker preview table. Kept in sync with
 * server/upload/extractMultitrack.ts.
 */
export function previewSpeakerFromFilename(originalName: string): { displayName: string } {
  const stem = originalName.replace(/\.[^./\\]+$/, '')
  const numericPrefix = stem.match(/^(\d+)[-_](.+)$/)
  if (numericPrefix) {
    return { displayName: numericPrefix[2].trim() || 'Unnamed' }
  }
  return { displayName: stem.trim() || 'Unnamed' }
}
