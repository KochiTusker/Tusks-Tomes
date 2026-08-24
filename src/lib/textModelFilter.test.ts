import { describe, expect, it } from 'vitest'
import { isTextPipelineModel } from './openrouterModelsClient'
import type { OpenRouterModelInfo } from './openrouterModelsClient'

function m(over: Partial<OpenRouterModelInfo> = {}): OpenRouterModelInfo {
  return {
    id: 'vendor/model',
    name: 'M',
    inputPerM: 1,
    outputPerM: 3,
    contextLength: 200_000,
    maxCompletionTokens: 65_536,
    supportsStructuredOutputs: true,
    isModerated: false,
    isFree: false,
    inputModalities: ['text'],
    outputModalities: ['text'],
    ...over,
  }
}

describe('isTextPipelineModel', () => {
  it('accepts an ordinary text model', () => {
    expect(isTextPipelineModel(m())).toBe(true)
  })

  it('accepts a vision model that still reads and writes text', () => {
    // A model that can also see images can still ground a transcript.
    expect(
      isTextPipelineModel(m({ inputModalities: ['text', 'image'], outputModalities: ['text'] })),
    ).toBe(true)
  })

  it('rejects anything that outputs more than text', () => {
    // An image generator that also emits a caption is not a prose model.
    expect(isTextPipelineModel(m({ outputModalities: ['text', 'image'] }))).toBe(false)
    expect(isTextPipelineModel(m({ outputModalities: ['image'] }))).toBe(false)
    expect(isTextPipelineModel(m({ outputModalities: ['transcription'] }))).toBe(false)
  })

  it('rejects a model that cannot accept text at all', () => {
    expect(
      isTextPipelineModel(m({ inputModalities: ['audio'], outputModalities: ['text'] })),
    ).toBe(false)
  })

  it('rejects speech, image, video and embedding endpoints by id', () => {
    // Backstop for rows whose modality metadata is thin.
    for (const id of [
      'openai/whisper-large-v3',
      'openai/gpt-4o-transcribe',
      'google/chirp-3',
      'nvidia/parakeet-tdt-0.6b-v3',
      'mistralai/voxtral-mini-transcribe',
      'google/lyria-3-pro-preview',
      'google/gemini-3-pro-image',
      'some/model-tts',
      'vendor/text-embedding-3',
      'vendor/rerank-v2',
    ]) {
      expect(isTextPipelineModel(m({ id })), id).toBe(false)
    }
  })

  it('does not reject ordinary models whose names merely contain a substring', () => {
    // Guard against over-matching. These are real text models.
    for (const id of [
      'deepseek/deepseek-v4-flash',
      'moonshotai/kimi-k2.6',
      'qwen/qwen3-235b-a22b-2507',
      'z-ai/glm-4.7',
      'nvidia/nemotron-3.5-lightning',
      'inclusionai/ling-2.6-flash',
      'x-ai/grok-4.6',
    ]) {
      expect(isTextPipelineModel(m({ id })), id).toBe(true)
    }
  })

  it('rejects a model with no context window', () => {
    // Speech endpoints report context_length 0 and cannot take a chunk.
    expect(isTextPipelineModel(m({ contextLength: 0 }))).toBe(false)
  })

  it('accepts a model with no declared input modalities', () => {
    // Sparse metadata should not exclude an otherwise-usable text model.
    expect(isTextPipelineModel(m({ inputModalities: [] }))).toBe(true)
  })
})
