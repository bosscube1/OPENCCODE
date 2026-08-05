import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpencodeApi } from '../slices/api'
import type { AppState, GetState, SetState } from '../slices/types'
import type { NanoBalance, NanoUsage, WeeklyTokenData } from '../types'

vi.mock('../slices/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../slices/api')>()
  return { ...actual, api: vi.fn() }
})

import { api } from '../slices/api'
import {
  createNanoQuotaSlice,
  startNanoQuotaPolling,
  stopNanoQuotaPolling,
  type NanoQuotaSlice
} from '../slices/nanoQuotaSlice'

const mockApi = vi.mocked(api)

function createStore(): { get: GetState; set: SetState } {
  let state = {} as AppState
  const set = ((partial: unknown) => {
    const patch = typeof partial === 'function' ? (partial as (s: AppState) => Partial<AppState>)(state) : partial
    state = { ...state, ...(patch as Partial<AppState>) }
  }) as SetState
  const get: GetState = () => state
  return { get, set }
}

function setup(overrides: Partial<AppState> = {}): { get: GetState; slice: NanoQuotaSlice } {
  const { get, set } = createStore()
  const slice = createNanoQuotaSlice(set, get)
  set(slice)
  set(overrides)
  return { get, slice }
}

// Mirrors the real `/api/subscription/v1/usage` shape: dailyInputTokens is null on plans with no
// daily token cap, which is a known fact rather than a missing value.
const mockUsage: NanoUsage = {
  active: true,
  limits: { dailyInputTokens: null, weeklyInputTokens: 3000, dailyImages: 100 },
  dailyInputTokens: null,
  weeklyInputTokens: { used: 50, remaining: 2950, percentUsed: 1.6, resetAt: 12345 },
  dailyImages: { used: 10, remaining: 90, percentUsed: 10, resetAt: 12345 },
  period: { currentPeriodEnd: '2026-09-01T00:00:00.000Z' },
  state: 'active'
}

const mockWeekly: WeeklyTokenData = {
  weekKey: '2026-W32',
  inputTokens: 1000,
  outputTokens: 500,
  totalTokens: 1500
}

const mockBalance: NanoBalance = {
  usd: 12.5,
  nano: 0
}

function mockBridge(overrides: Partial<{ usage: unknown; weeklyUsage: unknown; balance: unknown }> = {}): void {
  mockApi.mockReturnValue({
    nanogpt: {
      usage: overrides.usage ?? vi.fn().mockResolvedValue(mockUsage),
      weeklyUsage: overrides.weeklyUsage ?? vi.fn().mockResolvedValue(mockWeekly),
      balance: overrides.balance ?? vi.fn().mockResolvedValue(mockBalance)
    }
  } as unknown as OpencodeApi)
}

describe('nanoQuotaSlice', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockApi.mockReset()
  })

  afterEach(() => {
    stopNanoQuotaPolling()
    vi.useRealTimers()
  })

  it('fetches usage, weekly tokens, and balance in parallel and updates store', async () => {
    mockBridge()

    const { get, slice } = setup()

    await slice.fetchNanoQuota()

    expect(get().nanoUsage).toEqual(mockUsage)
    expect(get().nanoWeeklyUsage).toEqual(mockWeekly)
    expect(get().nanoBalance).toEqual(mockBalance)
  })

  it('preserves existing store state when an API call rejects', async () => {
    mockBridge({
      usage: vi.fn().mockRejectedValue(new Error('network error')),
      weeklyUsage: vi.fn().mockRejectedValue(new Error('network error')),
      balance: vi.fn().mockRejectedValue(new Error('network error'))
    })

    const { get, slice } = setup({ nanoUsage: mockUsage, nanoBalance: mockBalance, nanoWeeklyUsage: mockWeekly })

    await slice.fetchNanoQuota()

    expect(get().nanoUsage).toEqual(mockUsage)
    expect(get().nanoBalance).toEqual(mockBalance)
    expect(get().nanoWeeklyUsage).toEqual(mockWeekly)
  })

  it('preserves existing store state when usage/balance resolve null (contract T2)', async () => {
    mockBridge({
      usage: vi.fn().mockResolvedValue(null),
      balance: vi.fn().mockResolvedValue(null)
    })

    const { get, slice } = setup({ nanoUsage: mockUsage, nanoBalance: mockBalance })

    const ok = await slice.fetchNanoQuota()

    expect(ok).toBe(false)
    expect(get().nanoUsage).toEqual(mockUsage)
    expect(get().nanoBalance).toEqual(mockBalance)
    // weeklyUsage has no null convention — the resolved (non-null) value still applies.
    expect(get().nanoWeeklyUsage).toEqual(mockWeekly)
  })

  it('updates showBalanceInStatus flag', () => {
    const { get, slice } = setup({ showBalanceInStatus: false })

    slice.setShowBalanceInStatus(true)
    expect(get().showBalanceInStatus).toBe(true)
  })

  it('polls quota every 90 seconds while a NanoGPT key is configured', async () => {
    const usageSpy = vi.fn().mockResolvedValue(mockUsage)
    mockBridge({ usage: usageSpy })

    const { get } = setup({ linkedProviderIDs: ['nanogpt'] })

    startNanoQuotaPolling(get)
    await vi.advanceTimersByTimeAsync(0)

    // First call happens immediately
    expect(usageSpy).toHaveBeenCalledTimes(1)

    // Advance by 90s
    await vi.advanceTimersByTimeAsync(90_000)
    expect(usageSpy).toHaveBeenCalledTimes(2)

    // Advance by another 90s
    await vi.advanceTimersByTimeAsync(90_000)
    expect(usageSpy).toHaveBeenCalledTimes(3)
  })

  it('does not poll when no NanoGPT key is configured (D4)', async () => {
    const usageSpy = vi.fn().mockResolvedValue(mockUsage)
    mockBridge({ usage: usageSpy })

    const { get } = setup({ linkedProviderIDs: [] })

    startNanoQuotaPolling(get)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(200_000)

    expect(usageSpy).not.toHaveBeenCalled()
  })

  it('backs off the poll interval on consecutive failures and resets on success', async () => {
    let shouldFail = true
    const usageSpy = vi.fn().mockImplementation(() => (shouldFail ? Promise.resolve(null) : Promise.resolve(mockUsage)))
    mockBridge({ usage: usageSpy })

    const { get } = setup({ linkedProviderIDs: ['nanogpt'] })

    startNanoQuotaPolling(get)
    await vi.advanceTimersByTimeAsync(0)
    expect(usageSpy).toHaveBeenCalledTimes(1)

    // Failing poll #1 -> next interval doubles 90s -> 180s. Advancing only 90s must NOT fire yet.
    await vi.advanceTimersByTimeAsync(90_000)
    expect(usageSpy).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(90_000)
    expect(usageSpy).toHaveBeenCalledTimes(2)

    // Failing poll #2 -> interval doubles 180s -> 360s.
    await vi.advanceTimersByTimeAsync(180_000)
    expect(usageSpy).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(180_000)
    expect(usageSpy).toHaveBeenCalledTimes(3)

    // Failing poll #3 -> interval doubles 360s -> 720s (the ceiling).
    await vi.advanceTimersByTimeAsync(360_000)
    expect(usageSpy).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(360_000)
    expect(usageSpy).toHaveBeenCalledTimes(4)

    // Now succeed on the next poll (still scheduled at the 720s ceiling) — interval must reset
    // back down to the 90s base for the poll AFTER that.
    shouldFail = false
    await vi.advanceTimersByTimeAsync(720_000)
    expect(usageSpy).toHaveBeenCalledTimes(5)

    await vi.advanceTimersByTimeAsync(90_000)
    expect(usageSpy).toHaveBeenCalledTimes(6)
  })

  it('stopNanoQuotaPolling halts further polling', async () => {
    const usageSpy = vi.fn().mockResolvedValue(mockUsage)
    mockBridge({ usage: usageSpy })

    const { get } = setup({ linkedProviderIDs: ['nanogpt'] })

    startNanoQuotaPolling(get)
    await vi.advanceTimersByTimeAsync(0)
    expect(usageSpy).toHaveBeenCalledTimes(1)

    stopNanoQuotaPolling()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(usageSpy).toHaveBeenCalledTimes(1)
  })
})
