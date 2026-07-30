import { describe, expect, it } from 'vitest'
import {
  DEFAULT_GEMINI_LIVE_CONFIG,
  GEMINI_LIVE_VOICES,
  validateGeminiLiveConfig
} from '../geminiLiveConfig'

describe('validateGeminiLiveConfig', () => {
  it('returns the defaults when the renderer sends no config', () => {
    expect(validateGeminiLiveConfig(undefined)).toEqual(DEFAULT_GEMINI_LIVE_CONFIG)
    expect(validateGeminiLiveConfig(null)).toEqual(DEFAULT_GEMINI_LIVE_CONFIG)
    expect(validateGeminiLiveConfig({})).toEqual(DEFAULT_GEMINI_LIVE_CONFIG)
  })

  it('returns a fresh object that cannot mutate the shared defaults', () => {
    const resolved = validateGeminiLiveConfig({ voice: 'Puck' })
    resolved.voice = 'Fenrir'
    expect(DEFAULT_GEMINI_LIVE_CONFIG.voice).toBe('Kore')
    expect(validateGeminiLiveConfig(undefined).model).toBe('gemini-3.1-flash-live-preview')
  })

  it('rejects non-object configs', () => {
    expect(() => validateGeminiLiveConfig('Kore')).toThrow(/must be an object/)
    expect(() => validateGeminiLiveConfig(42)).toThrow(/must be an object/)
    expect(() => validateGeminiLiveConfig(['Kore'])).toThrow(/must be an object/)
  })

  it('accepts every documented voice and rejects unknown ones', () => {
    for (const voice of GEMINI_LIVE_VOICES) {
      expect(validateGeminiLiveConfig({ voice }).voice).toBe(voice)
    }
    expect(() => validateGeminiLiveConfig({ voice: 'kore' })).toThrow(/voice must be one of/)
    expect(() => validateGeminiLiveConfig({ voice: 'Brian' })).toThrow(/voice must be one of/)
    expect(() => validateGeminiLiveConfig({ voice: 7 })).toThrow(/voice must be one of/)
  })

  it('accepts safe model ids and rejects unsafe ones', () => {
    expect(validateGeminiLiveConfig({ model: 'gemini-2.5-flash-native-audio-dialog' }).model)
      .toBe('gemini-2.5-flash-native-audio-dialog')
    expect(validateGeminiLiveConfig({ model: 'm_v2.0-x' }).model).toBe('m_v2.0-x')
    expect(() => validateGeminiLiveConfig({ model: '' })).toThrow(/model must be/)
    expect(() => validateGeminiLiveConfig({ model: 'a'.repeat(129) })).toThrow(/model must be/)
    expect(() => validateGeminiLiveConfig({ model: 'has space' })).toThrow(/model must be/)
    expect(() => validateGeminiLiveConfig({ model: 'has/slash' })).toThrow(/model must be/)
    expect(() => validateGeminiLiveConfig({ model: 'https://evil.example' })).toThrow(/model must be/)
    expect(() => validateGeminiLiveConfig({ model: 12 })).toThrow(/model must be/)
  })

  it('accepts a custom system instruction within the length bound', () => {
    expect(validateGeminiLiveConfig({ systemInstruction: 'Be terse.' }).systemInstruction).toBe('Be terse.')
    expect(validateGeminiLiveConfig({ systemInstruction: '' }).systemInstruction).toBe('')
    expect(validateGeminiLiveConfig({ systemInstruction: 'x'.repeat(4000) }).systemInstruction).toHaveLength(4000)
    expect(() => validateGeminiLiveConfig({ systemInstruction: 'x'.repeat(4001) })).toThrow(/systemInstruction must be/)
    expect(() => validateGeminiLiveConfig({ systemInstruction: {} })).toThrow(/systemInstruction must be/)
  })

  it('drops unknown keys instead of forwarding them to the API', () => {
    const resolved = validateGeminiLiveConfig({ voice: 'Aoede', admin: true, endpoint: 'wss://evil.example' })
    expect(resolved).toEqual({ ...DEFAULT_GEMINI_LIVE_CONFIG, voice: 'Aoede' })
    expect('admin' in resolved).toBe(false)
    expect('endpoint' in resolved).toBe(false)
  })
})
