// Cross-platform native "choose a folder" dialog, invoked by the local server
// on the user's own desktop. Used by the Obsidian Vault add-on so users can
// browse to their vault instead of typing an absolute path.
//
// Local-first only: the dialog pops on the machine running the server. In a
// headless / remote setup no GUI is available, so callers must fall back to a
// text input (the UI does). All commands use STATIC prompts — no user input
// reaches the shell.

import { spawn } from 'node:child_process'

export type FolderDialogResult =
  | { ok: true; path: string }
  | { ok: false; reason: 'cancelled' | 'unavailable' | 'error'; detail?: string }

const PROMPT = 'Select your Obsidian vault folder'
const TIMEOUT_MS = 180_000 // generous — the user has to navigate + click

/** Run a command, resolve with trimmed stdout (or null on non-zero/empty). */
function run(
  command: string,
  args: string[],
  opts: { shell?: boolean } = {},
): Promise<{ code: number | null; stdout: string; stderr: string; spawnError?: string }> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, { shell: opts.shell ?? false })
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: '', spawnError: (err as Error).message })
      return
    }
    child.stdout?.on('data', (c) => (stdout += String(c)))
    child.stderr?.on('data', (c) => (stderr += String(c)))
    child.on('error', (err) => resolve({ code: null, stdout, stderr, spawnError: err.message }))
    child.on('exit', (code) => resolve({ code, stdout, stderr }))
    setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* */
      }
      resolve({ code: null, stdout, stderr, spawnError: 'timeout' })
    }, TIMEOUT_MS)
  })
}

async function pickWindows(): Promise<FolderDialogResult> {
  // PowerShell FolderBrowserDialog. -STA is required for WinForms dialogs.
  // The script writes the selected path to stdout, or nothing on cancel.
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    '$f = New-Object System.Windows.Forms.FolderBrowserDialog',
    `$f.Description = '${PROMPT}'`,
    '$f.ShowNewFolderButton = $false',
    'if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($f.SelectedPath) }',
  ].join('; ')
  const r = await run('powershell', ['-NoProfile', '-STA', '-Command', script])
  if (r.spawnError) return { ok: false, reason: 'unavailable', detail: r.spawnError }
  const p = r.stdout.trim()
  return p ? { ok: true, path: p } : { ok: false, reason: 'cancelled' }
}

async function pickMac(): Promise<FolderDialogResult> {
  // osascript: returns POSIX path, or errors (-128) on user cancel.
  const r = await run('osascript', [
    '-e',
    `POSIX path of (choose folder with prompt "${PROMPT}")`,
  ])
  if (r.spawnError) return { ok: false, reason: 'unavailable', detail: r.spawnError }
  const p = r.stdout.trim()
  if (p) return { ok: true, path: p }
  // User cancel surfaces as a non-zero exit with "User canceled" on stderr.
  return { ok: false, reason: /cancel/i.test(r.stderr) ? 'cancelled' : 'error', detail: r.stderr.trim() || undefined }
}

async function pickLinux(): Promise<FolderDialogResult> {
  // Prefer zenity, then kdialog. Both are common but neither is guaranteed.
  const zen = await run('zenity', ['--file-selection', '--directory', `--title=${PROMPT}`])
  if (!zen.spawnError) {
    const p = zen.stdout.trim()
    if (p) return { ok: true, path: p }
    return { ok: false, reason: 'cancelled' }
  }
  const kd = await run('kdialog', ['--getexistingdirectory', process.env.HOME ?? '/'])
  if (!kd.spawnError) {
    const p = kd.stdout.trim()
    if (p) return { ok: true, path: p }
    return { ok: false, reason: 'cancelled' }
  }
  return {
    ok: false,
    reason: 'unavailable',
    detail: 'No GUI folder dialog found (install zenity or kdialog, or paste the path manually).',
  }
}

/** Open the OS folder-picker and return the chosen absolute path. */
export async function pickFolder(): Promise<FolderDialogResult> {
  try {
    if (process.platform === 'win32') return await pickWindows()
    if (process.platform === 'darwin') return await pickMac()
    return await pickLinux()
  } catch (err) {
    return { ok: false, reason: 'error', detail: (err as Error).message }
  }
}
