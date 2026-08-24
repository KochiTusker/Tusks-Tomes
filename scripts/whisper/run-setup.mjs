#!/usr/bin/env node
// Cross-platform dispatcher for the Whisper sidecar setup script.
//
// Before v1.1.0, `npm run whisper:setup` was hardcoded to PowerShell, which
// silently fails on macOS/Linux clones (the CLI exits "powershell: command
// not found"). Users had to know to type `npm run whisper:setup:posix`
// instead. This dispatcher means `npm run whisper:setup` Just Works on
// every platform — picks the .ps1 on Windows, the .sh on POSIX, streams
// the child's stdout/stderr inline.
//
// The in-app "Install Audio Transcription" button has always been
// platform-aware (server/whisper/bootstrap.ts:runSetup). This dispatcher
// closes the gap for users who run the CLI form.

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isWin = process.platform === 'win32'

const ps1 = path.join(__dirname, 'setup.ps1')
const sh = path.join(__dirname, 'setup.sh')

const [command, args] = isWin
  ? ['powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, ...process.argv.slice(2)]]
  : ['bash', [sh, ...process.argv.slice(2)]]

const child = spawn(command, args, { stdio: 'inherit', cwd: path.resolve(__dirname, '..', '..') })

child.on('error', (err) => {
  console.error(`[whisper:setup] failed to spawn ${command}:`, err.message)
  if (!isWin && err.code === 'ENOENT') {
    console.error('  (bash not found on PATH — install bash, or run the script directly: `sh scripts/whisper/setup.sh`)')
  }
  process.exit(1)
})

child.on('close', (code) => {
  process.exit(code ?? 1)
})
