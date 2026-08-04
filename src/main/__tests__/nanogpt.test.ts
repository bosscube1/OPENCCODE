import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// nanogpt.ts imports loadByokEnv from ./keys, which itself imports electron's safeStorage.
// Mock ./keys directly so no real Electron module needs to load in this unit test.
vi.mock('../keys', () => ({
  loadByokEnv: () => ({ NANOGPT_API_KEY: 'sk-nano-test-key' })
}))

import { fetchBalance, fetchSubscriptionModels } from '../nanogpt'
import type { NanoGptError } from '../nanogpt'

/** Build a fetch mock that returns a fixed sequence of responses, one per call. */
function sequencedFetch(responses: Response[]): ReturnType<typeof vi.fn> {
  let call = 0
  return vi.fn(async () => {
    const res = responses[Math.min(call, responses.length - 1)]!
    call++
    return res
  })
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

describe('nanogpt', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('fetchBalance — string parsing per contract T1', () => {
    it('parses a valid response: usd_balance/nano_balance strings, nanoDepositAddress present', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse(200, { usd_balance: '12.34', nano_balance: '5.67', nanoDepositAddress: 'nano_1abc' }))
      )
      const balance = await fetchBalance()
      expect(balance).toEqual({ usd: 12.34, nano: 5.67, depositAddress: 'nano_1abc' })
    })

    it('omits depositAddress when the field is absent', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { usd_balance: '1.00', nano_balance: '0' })))
      const balance = await fetchBalance()
      expect(balance.depositAddress).toBeUndefined()
    })

    it('throws when usd_balance is missing', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { nano_balance: '5.67' })))
      await expect(fetchBalance()).rejects.toThrow(/usd_balance/)
    })

    it('throws when usd_balance is non-numeric', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { usd_balance: 'not-a-number', nano_balance: '5.67' })))
      await expect(fetchBalance()).rejects.toThrow(/usd_balance/)
    })

    it('falls back nano_balance to 0 when non-numeric', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { usd_balance: '1.00', nano_balance: 'garbage' })))
      const balance = await fetchBalance()
      expect(balance.nano).toBe(0)
    })

    it('falls back nano_balance to 0 when missing', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { usd_balance: '1.00' })))
      const balance = await fetchBalance()
      expect(balance.nano).toBe(0)
    })
  })

  describe('retry policy (contract T5)', () => {
    it('retries on 503 and eventually succeeds', async () => {
      const fetchMock = sequencedFetch([
        jsonResponse(503, { message: 'temporarily unavailable' }),
        jsonResponse(200, { data: [{ id: 'model-a' }] })
      ])
      vi.stubGlobal('fetch', fetchMock)
      const models = await fetchSubscriptionModels()
      expect(models).toEqual([{ id: 'model-a' }])
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('does NOT retry on 400 — fails immediately after a single call', async () => {
      const fetchMock = sequencedFetch([jsonResponse(400, { message: 'bad request', code: 'invalid_parameter_value' })])
      vi.stubGlobal('fetch', fetchMock)
      await expect(fetchSubscriptionModels()).rejects.toThrow()
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('gives up after MAX_RETRIES and surfaces the final error', async () => {
      const fetchMock = sequencedFetch([
        jsonResponse(503, {}),
        jsonResponse(503, {}),
        jsonResponse(503, {})
      ])
      vi.stubGlobal('fetch', fetchMock)
      await expect(fetchSubscriptionModels()).rejects.toThrow(/503/)
      // Initial attempt + 2 retries = 3 calls, then no further retry.
      expect(fetchMock).toHaveBeenCalledTimes(3)
    })
  })

  describe('Retry-After handling on 429 (contract T5)', () => {
    it('honours a Retry-After header within the 30s cap and retries', async () => {
      const fetchMock = sequencedFetch([
        jsonResponse(429, { message: 'rate limited' }, { 'Retry-After': '1' }),
        jsonResponse(200, { data: [{ id: 'model-a' }] })
      ])
      vi.stubGlobal('fetch', fetchMock)
      const start = Date.now()
      const models = await fetchSubscriptionModels()
      const elapsed = Date.now() - start
      expect(models).toEqual([{ id: 'model-a' }])
      expect(fetchMock).toHaveBeenCalledTimes(2)
      // Should wait roughly the requested 1s, not the default exponential backoff.
      expect(elapsed).toBeGreaterThanOrEqual(950)
    }, 10000)

    it('fails fast (no retry) when Retry-After exceeds the 30s cap', async () => {
      const fetchMock = sequencedFetch([jsonResponse(429, { message: 'rate limited' }, { 'Retry-After': '60' })])
      vi.stubGlobal('fetch', fetchMock)
      await expect(fetchSubscriptionModels()).rejects.toThrow()
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })
  })

  describe('X-Request-ID (contract T5/T3)', () => {
    it('reaches the thrown error message when present', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse(400, { message: 'bad request' }, { 'X-Request-ID': 'req-abc-123' }))
      )
      await expect(fetchSubscriptionModels()).rejects.toThrow(/req-abc-123/)
    })

    it('is attached as the requestId property on the thrown error', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse(400, { message: 'bad request' }, { 'X-Request-ID': 'req-xyz-789' }))
      )
      let caught: NanoGptError | undefined
      try {
        await fetchSubscriptionModels()
      } catch (error) {
        caught = error as NanoGptError
      }
      expect(caught?.requestId).toBe('req-xyz-789')
    })
  })

  describe('machine-readable code (contract T6)', () => {
    it('is attached to the thrown Error as a code property (top-level code field)', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(404, { message: 'no such model', code: 'model_not_found' })))
      let caught: NanoGptError | undefined
      try {
        await fetchSubscriptionModels()
      } catch (error) {
        caught = error as NanoGptError
      }
      expect(caught?.code).toBe('model_not_found')
    })

    it('is attached to the thrown Error as a code property (nested error.code field)', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse(402, { error: { message: 'insufficient balance', code: 'insufficient_balance' } }))
      )
      let caught: NanoGptError | undefined
      try {
        await fetchSubscriptionModels()
      } catch (error) {
        caught = error as NanoGptError
      }
      expect(caught?.code).toBe('insufficient_balance')
    })
  })

  describe('network failures', () => {
    it('retries a genuine network rejection and succeeds on the next attempt', async () => {
      let call = 0
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          call++
          if (call === 1) throw new TypeError('fetch failed')
          return jsonResponse(200, { data: [{ id: 'model-a' }] })
        })
      )
      const models = await fetchSubscriptionModels()
      expect(models).toEqual([{ id: 'model-a' }])
      expect(call).toBe(2)
    })
  })

  describe('key redaction', () => {
    it('never includes the API key in a thrown error message', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse(400, { message: 'bad request containing sk-nano-test-key in body' }))
      )
      await expect(fetchSubscriptionModels()).rejects.toThrow(/\[redacted\]/)
    })
  })
})
