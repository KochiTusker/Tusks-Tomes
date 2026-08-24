// Cross-fade a state change where the platform can, without ever letting the
// animation decide whether the change happens.
//
// The View Transitions API skips a transition started while the document is
// hidden, and rejects `ready` with InvalidStateError when it does. That is a
// reachable state here, not a theoretical one: `sbts:load-transcript` and
// `sbts:open-doc` both switch tabs programmatically, and a run long enough to
// warrant walking away is exactly when the window is backgrounded. The update
// callback still runs in that case, so the switch itself is always correct —
// the only casualty is the animation.
//
// Left unhandled, that skip surfaced as an uncaught promise rejection on every
// such switch. A dropped animation is a cosmetic outcome and should be silent.

type ViewTransitionLike = {
  ready?: Promise<unknown>
  finished?: Promise<unknown>
}

export type TransitionCapableDocument = {
  startViewTransition?: (callback: () => void) => ViewTransitionLike | void
}

/**
 * Apply `update`, cross-fading it when the platform supports transitions and
 * the user has not asked for reduced motion. Never a behaviour fork: `update`
 * runs exactly once on every path.
 */
export function transitionOrJustDo(
  update: () => void,
  doc: TransitionCapableDocument,
  prefersReducedMotion: boolean
): void {
  if (!doc.startViewTransition || prefersReducedMotion) {
    update()
    return
  }

  const transition = doc.startViewTransition(update)
  if (!transition) return

  // Swallow both promises. A skipped or interrupted transition is not a
  // failure the user can act on, and the state change has already happened.
  transition.ready?.catch(() => {})
  transition.finished?.catch(() => {})
}
