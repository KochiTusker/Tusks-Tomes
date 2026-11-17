// Audio transcription (server): the feature's front door.
// Other features import from here, never from a file inside this folder
// (rule d in engineering/tests/boundaries.test.ts). It re-exports only what
// they use; an import that would loop back through here stays deep and is
// listed, with its reason, in engineering/tests/boundaries.allowlist.json.
export { sessionsRouter } from './routes/sessions.js'
export { transcribeRouter } from './routes/transcribe.js'
export { uploadGate, uploadRouter } from './routes/upload.js'
export { whisperRouter } from './routes/whisper.js'
export { registerWhisperCppRoutes } from './routes/whisperCpp.js'
export { registerLiveImpl } from './services/sessions/liveSessionBridge.js'
export { runSetup, venvDir, whisperInstalled } from './services/whisper/bootstrap.js'
export { getLiveSessionState, refreshLiveSbv } from './services/whisper/liveQueue.js'
