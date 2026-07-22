import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  record429,
  reserveAttempt,
  recordSuccess,
  recordFailure,
  underRateCaps,
  selectModel,
  parseModelKey,
  codingQuality,
  loadLedger,
  saveLedger,
  LEDGER_STORAGE_KEY,
  type Ledger,
  type ModelKey,
  type ModelCapsMap
} from '../routing'

describe('Smart routing v2 (routing.ts)', () => {
  const now = 1700000000000
  const modelA = 'google/gemini-2.5-flash'
  const modelB = 'groq/llama-3.3-70b-versatile'
  const modelC = 'cerebras/gpt-oss-120b'

  describe('record429', () => {
    it('sets initial 30s cooldown on first 429', () => {
      const ledger: Ledger = {}
      const updated = record429(ledger, modelA, now)
      expect(updated[modelA].cooldownMs).toBe(30000)
      expect(updated[modelA].cooldownUntil).toBe(now + 30000)
      expect(updated[modelA].last429).toBe(now)
    })

    it('doubles cooldown on consecutive 429s up to 30 minutes', () => {
      let ledger: Ledger = {}
      ledger = record429(ledger, modelA, now)
      expect(ledger[modelA].cooldownMs).toBe(30000)

      // Second consecutive 429 while cooling down
      ledger = record429(ledger, modelA, now + 10000)
      expect(ledger[modelA].cooldownMs).toBe(60000)
      expect(ledger[modelA].cooldownUntil).toBe(now + 10000 + 60000)

      // Multiple 429s capped at 1800000ms (30m)
      for (let i = 0; i < 10; i++) {
        ledger = record429(ledger, modelA, now + 20000 + i * 1000)
      }
      expect(ledger[modelA].cooldownMs).toBe(1800000)
      expect(ledger[modelA].cooldownUntil).toBe(now + 20000 + 9000 + 1800000)
    })
  })

  describe('recordSuccess', () => {
    it('clears cooldownUntil and updates EWMA latency without double-counting a reserved send', () => {
      const ledger: Ledger = {
        [modelA]: {
          cooldownUntil: now + 30000,
          cooldownMs: 60000,
          success: 2,
          error: 0,
          last429: now - 10000,
          latencyEwma: 1000,
          sends: [now - 100000]
        }
      }

      const updated = recordSuccess(ledger, modelA, 500, now)
      expect(updated[modelA].cooldownUntil).toBe(0)
      expect(updated[modelA].cooldownMs).toBe(30000) // halved from 60000
      expect(updated[modelA].success).toBe(3)
      expect(updated[modelA].latencyEwma).toBe(0.3 * 500 + 0.7 * 1000)
      expect(updated[modelA].sends).toEqual([now - 100000])
    })

    it('reserves attempts before dispatch and prunes sends older than 24h', () => {
      const oldTime = now - 90000000 // > 24h ago
      const recentTime = now - 10000 // 10s ago
      const ledger: Ledger = {
        [modelA]: {
          cooldownUntil: 0,
          cooldownMs: 30000,
          success: 1,
          error: 0,
          last429: null,
          latencyEwma: null,
          sends: [oldTime, recentTime]
        }
      }

      const updated = reserveAttempt(ledger, modelA, now)
      expect(updated[modelA].sends).toEqual([recentTime, now])
    })
  })

  describe('recordFailure', () => {
    it('increments error count without touching cooldowns', () => {
      const ledger: Ledger = {}
      const updated = recordFailure(ledger, modelA, now)
      expect(updated[modelA].error).toBe(1)
      expect(updated[modelA].cooldownUntil).toBe(0)
    })
  })

  describe('underRateCaps', () => {
    const caps: ModelCapsMap = {
      google: { rpm: 2, rpd: 5 },
      groq: { rpm: 10 }
    }

    it('returns true when sends are under limits', () => {
      const ledger: Ledger = {
        [modelA]: {
          cooldownUntil: 0,
          cooldownMs: 30000,
          success: 1,
          error: 0,
          last429: null,
          latencyEwma: null,
          sends: [now - 10000]
        }
      }
      expect(underRateCaps(ledger, modelA, caps, now)).toBe(true)
    })

    it('returns false when RPM cap is exceeded', () => {
      const ledger: Ledger = {
        [modelA]: {
          cooldownUntil: 0,
          cooldownMs: 30000,
          success: 2,
          error: 0,
          last429: null,
          latencyEwma: null,
          sends: [now - 20000, now - 10000]
        }
      }
      expect(underRateCaps(ledger, modelA, caps, now)).toBe(false)
    })

    it('returns false when RPD cap is exceeded', () => {
      const ledger: Ledger = {
        [modelA]: {
          cooldownUntil: 0,
          cooldownMs: 30000,
          success: 5,
          error: 0,
          last429: null,
          latencyEwma: null,
          sends: [
            now - 5000000,
            now - 4000000,
            now - 3000000,
            now - 2000000,
            now - 1000000
          ]
        }
      }
      expect(underRateCaps(ledger, modelA, caps, now)).toBe(false)
    })

    it('aggregates rate caps across models from the same provider', () => {
      const ledger: Ledger = {
        [modelA]: { cooldownUntil: 0, cooldownMs: 30000, success: 0, error: 0, last429: null, latencyEwma: null, sends: [now - 10000] },
        'google/gemini-2.5-pro': { cooldownUntil: 0, cooldownMs: 30000, success: 0, error: 0, last429: null, latencyEwma: null, sends: [now - 5000] }
      }
      expect(underRateCaps(ledger, modelA, caps, now)).toBe(false)
    })

    it('parses nested model IDs without losing any segment', () => {
      expect(parseModelKey('openrouter/qwen/qwen3-coder:free')).toEqual({
        providerID: 'openrouter',
        modelID: 'qwen/qwen3-coder:free'
      })
      expect(parseModelKey('invalid')).toBeNull()
    })
  })

  describe('selectModel', () => {
    const available = new Set([modelA, modelB, modelC])
    const caps: ModelCapsMap = {}

    it('honors sticky mode if sticky model is healthy and available', () => {
      const ledger: Ledger = {}
      const picked = selectModel(null, ledger, caps, now, {
        sticky: true,
        current: modelB,
        available,
        authenticatedProviders: new Set(['google', 'groq', 'cerebras'])
      })
      expect(picked).toBe(modelB)
    })

    it('falls back to scoring when sticky model is in cooldown', () => {
      const ledger: Ledger = {
        [modelB]: {
          cooldownUntil: now + 60000,
          cooldownMs: 60000,
          success: 0,
          error: 1,
          last429: now,
          latencyEwma: null,
          sends: []
        }
      }
      const picked = selectModel(null, ledger, caps, now, {
        sticky: true,
        current: modelB,
        available,
        authenticatedProviders: new Set(['google', 'groq', 'cerebras'])
      })
      expect(picked).toBe(modelC) // gpt-oss is favoured over generic flash
    })

    it('is deterministic when candidates have equal scores', () => {
      const ledger: Ledger = {}
      const picked1 = selectModel([modelC, modelA], ledger, caps, now, {
        sticky: false,
        current: null,
        available,
        authenticatedProviders: new Set(['google', 'groq', 'cerebras'])
      })
      const picked2 = selectModel([modelC, modelA], ledger, caps, now, {
        sticky: false,
        current: null,
        available,
        authenticatedProviders: new Set(['google', 'groq', 'cerebras'])
      })
      expect(picked1).toBe(modelC)
      expect(picked2).toBe(modelC)
    })

    it('returns null if all candidates are cooling down or capped', () => {
      const ledger: Ledger = {
        [modelA]: { cooldownUntil: now + 30000, cooldownMs: 30000, success: 0, error: 0, last429: now, latencyEwma: null, sends: [] },
        [modelB]: { cooldownUntil: now + 30000, cooldownMs: 30000, success: 0, error: 0, last429: now, latencyEwma: null, sends: [] },
        [modelC]: { cooldownUntil: now + 30000, cooldownMs: 30000, success: 0, error: 0, last429: now, latencyEwma: null, sends: [] }
      }
      const picked = selectModel(null, ledger, caps, now, {
        sticky: false,
        current: null,
        available,
        authenticatedProviders: new Set(['google', 'groq', 'cerebras'])
      })
      expect(picked).toBeNull()
    })

    it('never selects an unauthenticated provider or escapes a user pool', () => {
      const picked = selectModel([modelA], {}, caps, now, {
        sticky: false,
        current: null,
        available,
        authenticatedProviders: new Set(['cerebras'])
      })
      expect(picked).toBeNull()
    })

    it('ranks strong coding models deterministically when no pool is set', () => {
      const models = new Set<ModelKey>([
        'google/gemini-2.5-pro',
        'anthropic/claude-sonnet-4',
        'openai/gpt-5.5-codex'
      ])
      const picked = selectModel(null, {}, caps, now, {
        sticky: false,
        current: null,
        available: models,
        authenticatedProviders: new Set(['google', 'anthropic', 'openai'])
      })
      expect(picked).toBe('openai/gpt-5.5-codex')
      expect(codingQuality('openai/gpt-5.5-codex')).toBeGreaterThan(codingQuality('google/gemini-2.5-pro'))
    })
  })

  describe('loadLedger & saveLedger', () => {
    let mockStorage: Record<string, string> = {}

    beforeEach(() => {
      mockStorage = {}
      const localStorageMock = {
        getItem: (k: string) => mockStorage[k] || null,
        setItem: (k: string, v: string) => {
          mockStorage[k] = v
        },
        removeItem: (k: string) => {
          delete mockStorage[k]
        },
        clear: () => {
          mockStorage = {}
        }
      }
      vi.stubGlobal('localStorage', localStorageMock)
    })

    it('loads and prunes ledger entries from localStorage', () => {
      mockStorage[LEDGER_STORAGE_KEY] = JSON.stringify({
        [modelA]: {
          cooldownUntil: 0,
          cooldownMs: 30000,
          success: 5,
          error: 0,
          last429: null,
          latencyEwma: 300,
          sends: [Date.now() - 1000]
        },
        'expired/model': {
          cooldownUntil: 0,
          cooldownMs: 30000,
          success: 0,
          error: 0,
          last429: null,
          latencyEwma: null,
          sends: [Date.now() - 90000000] // > 24h
        }
      })

      const loaded = loadLedger()
      expect(loaded[modelA]).toBeDefined()
      expect(loaded[modelA].success).toBe(5)
      expect(loaded['expired/model']).toBeUndefined()
    })

    it('saves ledger debounced', async () => {
      vi.useFakeTimers()
      const ledger: Ledger = {
        [modelA]: {
          cooldownUntil: 0,
          cooldownMs: 30000,
          success: 1,
          error: 0,
          last429: null,
          latencyEwma: null,
          sends: [Date.now()]
        }
      }

      saveLedger(ledger)
      expect(mockStorage[LEDGER_STORAGE_KEY]).toBeUndefined() // debounced

      vi.advanceTimersByTime(600)
      expect(mockStorage[LEDGER_STORAGE_KEY]).toBeDefined()
      expect(JSON.parse(mockStorage[LEDGER_STORAGE_KEY])[modelA].success).toBe(1)
      vi.useRealTimers()
    })
  })
})
