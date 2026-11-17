// Chronicle pipeline: the feature's front door.
// Other features import from here, never from a file inside this folder
// (rule d in engineering/tests/boundaries.test.ts). It re-exports only what
// they use; an import that would loop back through here stays deep and is
// listed, with its reason, in engineering/tests/boundaries.allowlist.json.
export { CondenseSlider } from './components/CondenseSlider'
export { PhaseThinking } from './components/PhaseThinking'
export { PipelineTuningCard } from './components/PipelineTuningCard'
export { chunkSizeFor } from './lib/chunking'
export type { ChunkPhase } from './lib/chunking'
export { sleepWithCountdown } from './lib/countdown'
export { tryParseJson } from './lib/jsonExtract'
export { buildKbConcat, runPhase3, runPhase4, runPhase6 } from './lib/pipeline'
export type { PipelineCallbacks, PipelineEvent } from './lib/pipeline'
export { showCleanupToast, showPreGroundToast } from './lib/pipelineToasts'
export { sbvRepair, sbvRepairParts } from './lib/prompts'
export { quoteToPlainText } from './lib/quotes'
export type { FallbackRecord, RefusalRecord } from './lib/refusalDetection'
export { geminiAvailableForRestore, runChronicleRestore, runExtrasRestore } from './lib/restorePass'
export { fetchRunSettings } from './lib/runSettings'
export { cleanupTranscript } from './lib/transcriptCleanup'
export type { CleanupReport } from './lib/transcriptCleanup'
export { initialRefinementState, initialSbvRepairState } from './lib/types'
export type {
  CondenseOutput,
  DMAnswers,
  DMQuestion,
  ExtrasOutput,
  KBDocument,
  Quote,
  RefinementState,
  SbvCue,
  SbvRepairState,
} from './lib/types'
