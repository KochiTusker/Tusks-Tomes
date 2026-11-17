// Shared "show everything" tick for the OpenRouter surfaces.
//
// Kept out of modelVisibility.ts so the predicates there stay pure and
// testable without a DOM. The CustomEvent is what makes the two surfaces agree
// inside one session: localStorage alone would leave a picker that is already
// mounted showing a stale list until it happened to re-render, and the
// catalogue browser sits directly below the routing rows it governs.

import { useCallback, useEffect, useState } from 'react'
import { LS_SHOW_ALL_MODELS } from './constants'
import { safeGet, safeSet } from '../../../platform/lib/storage'

export const SHOW_ALL_MODELS_EVENT = 'sbts:show-all-models'

export function readShowAllModels(): boolean {
  return safeGet<boolean>(LS_SHOW_ALL_MODELS, false) === true
}

export function useShowAllModels(): [boolean, (next: boolean) => void] {
  const [showAll, setShowAll] = useState(readShowAllModels)

  useEffect(() => {
    const sync = () => setShowAll(readShowAllModels())
    window.addEventListener(SHOW_ALL_MODELS_EVENT, sync)
    // `storage` only fires in OTHER tabs, which is exactly the case the
    // CustomEvent cannot cover.
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(SHOW_ALL_MODELS_EVENT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])

  const update = useCallback((next: boolean) => {
    setShowAll(next)
    safeSet(LS_SHOW_ALL_MODELS, next)
    window.dispatchEvent(new CustomEvent(SHOW_ALL_MODELS_EVENT))
  }, [])

  return [showAll, update]
}
