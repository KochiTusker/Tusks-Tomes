// The cloud connections a run can actually be routed to.
//
// Direct Anthropic and OpenAI keys were retired: OpenRouter reaches the same
// models at the same pass-through rates with one key, so a second and third
// key bought nothing. Gemini keeps its own direct key deliberately: measured
// cheaper direct than through OpenRouter, and the one decoder collapse seen in
// testing happened on the OpenRouter route.
//
// `claudeCode` and `codex` are NOT the retired pair. They bill against a
// subscription rather than an API key and stay exactly as they were.
//
// Config written before the retirement is migrated on read; the server's
// legacyProviders.ts owns the only remaining reference to the old names.
export type CloudProvider = 'gemini' | 'claudeCode' | 'codex' | 'openrouter'

export type GeminiTier = 'paid' | 'free' | 'auto'
