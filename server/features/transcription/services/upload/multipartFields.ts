/**
 * The two optional JSON-encoded form fields both multitrack upload routes
 * accept next to the audio files. A field that is absent, blank, malformed or
 * the wrong shape reads as "not supplied": the caller then falls back to
 * filename-derived names and upload order, so a bad field never fails the upload.
 */

export function parseDisplayNameOverrides(body: { displayNameOverrides?: unknown }): Record<string, string> | undefined {
  if (typeof body.displayNameOverrides === 'string' && body.displayNameOverrides.trim()) {
    try {
      const parsed = JSON.parse(body.displayNameOverrides)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, string>
      }
    } catch {
      // malformed overrides: fall back to filename-derived names
    }
  }
  return undefined
}

export function parseFileOrder(body: { fileOrder?: unknown }): string[] | undefined {
  if (typeof body.fileOrder === 'string' && body.fileOrder.trim()) {
    try {
      const parsed = JSON.parse(body.fileOrder)
      if (Array.isArray(parsed) && parsed.every((s) => typeof s === 'string')) {
        return parsed as string[]
      }
    } catch {
      // malformed fileOrder: fall back to upload order
    }
  }
  return undefined
}
