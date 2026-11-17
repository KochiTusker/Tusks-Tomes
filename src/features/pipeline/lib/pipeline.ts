// The six-phase Chronicle pipeline. Each phase lives in ./phases/ and runs its
// chunks through chunkedGenerate (./chunkedGenerate.ts); phaseModel.ts picks
// the provider, model and chunk size, and pipelineEvents.ts defines what a run
// reports to the UI. This file is the stable entry point the rest of the app
// (and the tests that mock the pipeline) import.
export { buildKbConcat } from './buildKbConcat'
export { runPhase1 } from './phases/phase1Ground'
export { runPhase2 } from './phases/phase2Audit'
export { runPhase3 } from './phases/phase3Chronicle'
export { runPhase4 } from './phases/phase4Extras'
export { runPhase5Polish } from './phases/phase5Polish'
export { runPhase6 } from './phases/phase6Condense'
export type { PipelineCallbacks, PipelineEvent } from './pipelineEvents'
export { resolveThinkingBudget } from './thinkingBudget'
