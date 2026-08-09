import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { AppErrorBoundary } from './components/AppErrorBoundary'
import { AddonProvider } from './contexts/AddonContext'
import './index.css'
import { LS_REFINEMENT, LS_SBV_REPAIR } from './lib/constants'
import { ensureProvidersInitialized } from './lib/providers'

const BOOT_ID_KEY = 'server_boot_id'

// Workflow state that should NOT survive a server restart. The KB, campaign
// name, and session number are intentionally preserved — they're workspace
// inputs, not in-progress pipeline state.
const TRANSIENT_KEYS = [LS_REFINEMENT, LS_SBV_REPAIR]

// A FINISHED chronicle run is not stale in-progress state — it's a result the
// user hasn't actioned yet. Preserve it across a boot so the Chronicle tab
// still shows it after a reload / dev-server restart. (It's also auto-saved
// server-side to the Saved Chronicles library, but keeping the working view
// honours "persist in the UI until actioned".) In-progress runs still get
// cleared — those resume from on-disk checkpoints, not localStorage.
function isFinishedRun(raw: string | null): boolean {
  if (!raw) return false
  try {
    const status = (JSON.parse(raw) as { status?: string }).status
    return status === 'done' || status === 'phase6_condense'
  } catch {
    return false
  }
}

function clearTransientState(): void {
  for (const key of TRANSIENT_KEYS) {
    if (key === LS_REFINEMENT && isFinishedRun(localStorage.getItem(key))) continue
    localStorage.removeItem(key)
  }
}

async function ensureFreshSessionOnNewBoot(): Promise<void> {
  try {
    const res = await fetch('/api/boot', { cache: 'no-store' })
    if (!res.ok) return
    const { bootId } = (await res.json()) as { bootId?: string }
    if (!bootId) return
    const stored = localStorage.getItem(BOOT_ID_KEY)
    if (stored === bootId) return
    clearTransientState()
    localStorage.setItem(BOOT_ID_KEY, bootId)
  } catch (err) {
    // If the boot endpoint isn't reachable, fall back to fresh-on-every-load
    // so a confused server can never resurrect stale workflow state.
    clearTransientState()
    console.warn('[boot] Could not verify server boot ID; cleared transient state:', err)
  }
}

ensureFreshSessionOnNewBoot().finally(() => {
  // Kick off provider initialization eagerly so the in-browser SDKs and
  // hasApiKey()/listAvailableModels() see the keystore-decrypted keys
  // immediately on first render. We don't await — UI components will
  // re-render when subscribers emit, and the pipeline awaits it anyway
  // before its first call.
  void ensureProvidersInitialized()
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <AppErrorBoundary>
        <AddonProvider>
          <App />
        </AddonProvider>
      </AppErrorBoundary>
    </React.StrictMode>
  )
})
