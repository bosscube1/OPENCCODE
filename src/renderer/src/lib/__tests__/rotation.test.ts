import { describe, expect, it } from 'vitest'
import { FREE_ROUTING_CANDIDATES, isRateLimitError, pickDefaultModel } from '../rotation'
import type { Provider } from '../types'

describe('rotation helpers', () => {
  it('identifies rate limit error strings correctly', () => {
    expect(isRateLimitError('429 Too Many Requests')).toBe(true)
    expect(isRateLimitError('Rate limit exceeded')).toBe(true)
    expect(isRateLimitError('Quota reached for today')).toBe(true)
    expect(isRateLimitError('RESOURCE_EXHAUSTED')).toBe(true)
    expect(isRateLimitError('Overloaded')).toBe(true)
    expect(isRateLimitError('Invalid API Key')).toBe(false)
    expect(isRateLimitError('Network timeout')).toBe(false)
  })

  it('selects free routing candidates in order when available', () => {
    const mockProviders: Provider[] = [
      {
        id: 'google',
        name: 'Google Gemini',
        source: 'config',
        env: [],
        options: {},
        models: {
          'gemini-2.5-flash': {
            id: 'gemini-2.5-flash',
            name: 'Gemini 2.5 Flash',
            capabilities: { toolcall: true, input: { text: true }, output: { text: true } }
          } as any
        }
      }
    ]
    const picked = pickDefaultModel(mockProviders)
    expect(picked).toEqual({
      providerID: 'google',
      modelID: 'gemini-2.5-flash'
    })
  })

  it('has valid free routing candidates array', () => {
    expect(FREE_ROUTING_CANDIDATES.length).toBeGreaterThan(0)
    expect(FREE_ROUTING_CANDIDATES[0]).toHaveProperty('providerID')
    expect(FREE_ROUTING_CANDIDATES[0]).toHaveProperty('modelID')
  })
})
