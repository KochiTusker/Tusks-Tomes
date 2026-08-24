// Bridge between sessions.ts and the audio add-on's liveQueue.
// sessions.ts imports from here instead of whisper/liveQueue directly so
// the sessions router compiles and runs correctly even when the audio
// add-on is not loaded. The audio add-on calls registerLiveImpl() inside
// its registerRoutes() to wire in the real implementations.

export type LiveState = {
  active: boolean
  pending: number
  processedUtterances: number
  enqueued: number
  segments: unknown[]
  errors: string[]
  participants: Map<string, { discordDisplayName?: string }>
}

type GetLiveStateFn = (sessionId: string) => LiveState | undefined
type RefreshLiveSbvFn = (sessionId: string) => Promise<void>

let _getLiveState: GetLiveStateFn = () => undefined
let _refreshLiveSbv: RefreshLiveSbvFn = async () => {}

export function registerLiveImpl(
  getLiveState: GetLiveStateFn,
  refreshLiveSbv: RefreshLiveSbvFn,
): void {
  _getLiveState = getLiveState
  _refreshLiveSbv = refreshLiveSbv
}

export function getLiveSessionState(sessionId: string): LiveState | undefined {
  return _getLiveState(sessionId)
}

export async function refreshLiveSbv(sessionId: string): Promise<void> {
  return _refreshLiveSbv(sessionId)
}
