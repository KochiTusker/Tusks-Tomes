// The "Keep the model list up to date automatically" setting, readable from
// any feature without importing the maintenance feature that owns settings.json.
// Default ON: only an explicit false turns it off, so a hand-edited or
// unreadable file never silently stops the list updating.

import { readJson, settingsFile } from './appData.js'

export function coerceAutoUpdateModelList(raw: unknown): boolean {
  return (raw as { autoUpdateModelList?: unknown } | null)?.autoUpdateModelList !== false
}

export async function readAutoUpdateModelList(): Promise<boolean> {
  try {
    return coerceAutoUpdateModelList(await readJson<unknown>(settingsFile(), {}))
  } catch {
    return true
  }
}
