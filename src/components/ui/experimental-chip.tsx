// The "work in progress" disclosure that used to live on the add-on rows.
// When six add-ons became builtins their rows disappeared — and this
// warning silently disappeared with them, which was a regression against
// an explicit decision: the caveat carries forward onto each feature's
// own surface. Each experimental surface renders the chip itself; the
// truth is owned where the feature lives, not in a list that no longer
// exists.

import { FlaskConical } from 'lucide-react'

export function ExperimentalChip() {
  return (
    <span
      className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400"
      title="Still being refined — it works, but expect rough edges and changes."
    >
      <FlaskConical className="h-3 w-3" />
      Experimental
    </span>
  )
}
