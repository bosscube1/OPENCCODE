import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() }
}))

import { fetchSubscriptionUsage } from '../nanogpt'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

// Captured shape from a live `/api/subscription/v1/usage` response (2026-08). `dailyInputTokens`
// is legitimately `null` on this plan — no daily token cap — both as a bucket and as a limit.
const REAL_PAYLOAD = {
  active: true,
  provider: 'stripe',
  providerStatus: null,
  providerStatusRaw: null,
  stripeSubscriptionId: null,
  cancellationReason: null,
  canceledAt: null,
  endedAt: null,
  cancelAt: null,
  cancelAtPeriodEnd: false,
  limits: { weeklyInputTokens: 5000000, dailyInputTokens: null, dailyImages: 50 },
  allowOverage: false,
  period: { currentPeriodEnd: '2026-09-01T00:00:00.000Z' },
  dailyImages: { used: 12, remaining: 38, percentUsed: 24, resetAt: 1893456000 },
  dailyInputTokens: null,
  weeklyInputTokens: { used: 1200000, remaining: 3800000, percentUsed: 24, resetAt: 1893456000 },
  state: 'active',
  graceUntil: null
}

describe('fetchSubscriptionUsage', () => {
  const previousKey = process.env.NANOGPT_API_KEY
  const previousFetch = globalThis.fetch

  beforeEach(() => {
    process.env.NANOGPT_API_KEY = 'test-key'
  })

  afterEach(() => {
    if (previousKey === undefined) delete process.env.NANOGPT_API_KEY
    else process.env.NANOGPT_API_KEY = previousKey
    globalThis.fetch = previousFetch
    vi.restoreAllMocks()
  })

  it('parses the real payload shape: all three buckets handled, dailyInputTokens null preserved as "no cap"', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(REAL_PAYLOAD))

    const usage = await fetchSubscriptionUsage()

    expect(usage.active).toBe(true)
    expect(usage.state).toBe('active')
    expect(usage.graceUntil).toBeNull()
    expect(usage.period).toEqual({ currentPeriodEnd: '2026-09-01T00:00:00.000Z' })

    // dailyInputTokens is explicitly null in the payload (both bucket and limit) — that's "no
    // cap", a known fact, not "unknown".
    expect(usage.limits.dailyInputTokens).toBeNull()
    expect(usage.dailyInputTokens).toBeNull()

    expect(usage.limits.weeklyInputTokens).toBe(5000000)
    expect(usage.weeklyInputTokens).toEqual({ used: 1200000, remaining: 3800000, percentUsed: 24, resetAt: 1893456000 })

    expect(usage.limits.dailyImages).toBe(50)
    expect(usage.dailyImages).toEqual({ used: 12, remaining: 38, percentUsed: 24, resetAt: 1893456000 })
  })

  it('a null dailyInputTokens bucket does not throw and is distinguishable from an unknown one', async () => {
    // dailyInputTokens absent entirely (unknown) rather than explicitly null (no cap) — the two
    // must not collapse to the same value.
    const { dailyInputTokens: _omit, ...withoutDailyInputTokens } = REAL_PAYLOAD
    void _omit
    const payload = { ...withoutDailyInputTokens, limits: { ...REAL_PAYLOAD.limits, dailyInputTokens: undefined } }

    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(payload))
    const usage = await fetchSubscriptionUsage()

    expect(usage.dailyInputTokens).toBeUndefined()
    expect(usage.limits.dailyInputTokens).toBeUndefined()

    // Contrast with the real payload, where it's explicitly null.
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(REAL_PAYLOAD))
    const usageWithNull = await fetchSubscriptionUsage()
    expect(usageWithNull.dailyInputTokens).toBeNull()
  })

  it('degrades a bucket missing one field instead of throwing: percentUsed and used are derived from limit + remaining', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        active: true,
        state: 'active',
        limits: { weeklyInputTokens: 100, dailyImages: 1000 },
        // weeklyInputTokens has no `used`, only `remaining` — used/percentUsed must be derived from the limit.
        weeklyInputTokens: { remaining: 40, resetAt: 111 },
        dailyImages: { used: 200, remaining: 800, percentUsed: 20, resetAt: 222 }
      })
    )

    const usage = await fetchSubscriptionUsage()

    expect(usage.weeklyInputTokens).toEqual({ used: 60, remaining: 40, percentUsed: 60, resetAt: 111 })
    expect(usage.dailyImages).toEqual({ used: 200, remaining: 800, percentUsed: 20, resetAt: 222 })
  })

  it('renders an entirely missing bucket as undefined rather than throwing, when another bucket is present', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        active: true,
        state: 'active',
        limits: { weeklyInputTokens: 100, dailyImages: 1000 },
        dailyImages: { used: 200, remaining: 800, percentUsed: 20, resetAt: 222 }
        // weeklyInputTokens key entirely absent
      })
    )

    const usage = await fetchSubscriptionUsage()

    expect(usage.weeklyInputTokens).toBeUndefined()
    expect(usage.dailyImages).toEqual({ used: 200, remaining: 800, percentUsed: 20, resetAt: 222 })
  })

  it('falls back to the legacy `daily` name for dailyInputTokens when the new name is absent', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        active: true,
        state: 'active',
        limits: { daily: 100 },
        daily: { used: 10, remaining: 90, percentUsed: 10, resetAt: 111 }
      })
    )

    const usage = await fetchSubscriptionUsage()

    expect(usage.dailyInputTokens).toEqual({ used: 10, remaining: 90, percentUsed: 10, resetAt: 111 })
    expect(usage.limits.dailyInputTokens).toBe(100)
  })

  it('never maps a legacy `monthly` field onto weeklyInputTokens', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        active: true,
        state: 'active',
        limits: { daily: 100, monthly: 1000 },
        daily: { used: 10, remaining: 90, percentUsed: 10, resetAt: 111 },
        monthly: { used: 200, remaining: 800, percentUsed: 20, resetAt: 222 }
      })
    )

    const usage = await fetchSubscriptionUsage()

    expect(usage.weeklyInputTokens).toBeUndefined()
  })

  it('throws only when none of the three buckets is present as an object', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({ active: true, state: 'active', limits: { weeklyInputTokens: 100, dailyImages: 1000 } })
    )

    await expect(fetchSubscriptionUsage()).rejects.toThrow(
      /none of dailyInputTokens, weeklyInputTokens, or dailyImages/
    )
  })

  // The throw is the primary signal about a shape we might get wrong again, so the key list is
  // load-bearing, not decoration — assert it survives.
  it('names the keys the payload did carry, so a repeat failure is diagnosable', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({ active: true, state: 'active', limits: { weeklyInputTokens: 100, dailyImages: 1000 } })
    )

    await expect(fetchSubscriptionUsage()).rejects.toThrow(/Response carried: active, state, limits\./)
  })

  it('says so explicitly when the payload is an empty object', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({}))

    await expect(fetchSubscriptionUsage()).rejects.toThrow(/Response was an empty object\./)
  })
})
