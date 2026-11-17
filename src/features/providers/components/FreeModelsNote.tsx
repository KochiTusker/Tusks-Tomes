import { AlertTriangle } from 'lucide-react'

/**
 * The note that appears wherever the "show all models" tick has just put free
 * models on offer. One component for every surface that shares the tick, so
 * a surface cannot offer a free model without saying what it costs instead of
 * money.
 */
export function FreeModelsNote() {
  return (
    <p
      role="status"
      className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-muted-foreground"
    >
      <AlertTriangle className="mr-1 inline h-3.5 w-3.5 text-amber-500" aria-hidden="true" />
      Free models are now offered. Every one of them runs on a host that
      keeps a copy of what you send, and around half may train on it — a
      session transcript is your players&rsquo; conversation, and they are
      not in the room for that decision. Small and lower-performing models
      are offered too; the ones with a grade have that grade shown in the
      picker.
    </p>
  )
}
