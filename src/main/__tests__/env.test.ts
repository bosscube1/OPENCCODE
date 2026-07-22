import { describe, expect, it } from 'vitest'
import { linkedProviderIDs } from '../env'

describe('linkedProviderIDs', () => {
  it('authorizes known providers from non-secret API-key presence only', () => {
    expect(linkedProviderIDs({ OPENAI_API_KEY: 'sk-test', GROQ_API_KEY: 'gsk-test' })).toEqual([
      'groq',
      'openai'
    ])
  })

  it('recognizes Google aliases without leaking their values', () => {
    expect(linkedProviderIDs({ GOOGLE_API_KEY: 'test' })).toEqual(['google'])
    expect(linkedProviderIDs({ GOOGLE_GENERATIVE_AI_API_KEY: 'test' })).toEqual(['google'])
  })

  it('does not authorize a provider for empty or unrelated environment values', () => {
    expect(linkedProviderIDs({ OPENAI_API_KEY: '  ', SOME_OTHER_KEY: 'test' })).toEqual([])
  })
})
