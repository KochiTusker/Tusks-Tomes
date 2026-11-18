// Tells the user when browser storage is filling up, and again if a save
// fails because it is full. Both toasts offer the same backup download so the
// in-progress state can be kept outside the browser.
//
// The warning fires on every write inside the warning band (a running
// pipeline writes on every chunk), so it is shown once per page load rather
// than once per write.

import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { STORAGE_QUOTA_EVENT, STORAGE_QUOTA_WARNING_EVENT, dumpAllAsJson } from '@/platform/lib/storage'

const BACKUP_LABEL = 'Download app-state backup (browser data)'

function downloadBrowserBackup(): void {
  const blob = new Blob([dumpAllAsJson()], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `sbts-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  a.click()
  URL.revokeObjectURL(url)
}

export function useStorageQuotaToasts(): void {
  const warnedRef = useRef(false)

  useEffect(() => {
    function handleQuota(e: Event) {
      const detail = (e as CustomEvent).detail as { key: string; bytes: number } | undefined
      toast.error(`localStorage full when saving "${detail?.key ?? '?'}" (~${detail?.bytes ?? '?'} bytes).`, {
        duration: 12000,
        action: { label: BACKUP_LABEL, onClick: downloadBrowserBackup },
      })
    }
    function handleQuotaWarning() {
      if (warnedRef.current) return
      warnedRef.current = true
      toast.warning(
        'Browser storage is nearly full. Saving your progress in this browser may soon stop working. ' +
          'Download a backup now to keep a copy.',
        {
          duration: 15000,
          action: { label: BACKUP_LABEL, onClick: downloadBrowserBackup },
        },
      )
    }
    window.addEventListener(STORAGE_QUOTA_EVENT, handleQuota)
    window.addEventListener(STORAGE_QUOTA_WARNING_EVENT, handleQuotaWarning)
    return () => {
      window.removeEventListener(STORAGE_QUOTA_EVENT, handleQuota)
      window.removeEventListener(STORAGE_QUOTA_WARNING_EVENT, handleQuotaWarning)
    }
  }, [])
}
