/**
 * Domain slice managing NanoGPT subscription usage quota, weekly token accumulation,
 * pay-per-prompt balance, and balance display preferences.
 */

import { savePrefs } from '../prefs'
import { api } from './api'
import type { AppState, GetState, SetState } from './types'
import type { NanoBalance, NanoUsage, WeeklyTokenData } from '../types'

export type NanoQuotaSlice = Pick<
  AppState,
  | 'nanoUsage'
  | 'nanoBalance'
  | 'nanoWeeklyUsage'
  | 'showBalanceInStatus'
  | 'fetchNanoQuota'
  | 'setShowBalanceInStatus'
>

/** Base polling interval (D4). Doubles on each consecutive failed poll, up to the ceiling below. */
const POLL_BASE_MS = 90_000
/** Backoff ceiling — 8x the base interval (~12 minutes) so a dead connection is not hammered forever. */
const POLL_MAX_MS = POLL_BASE_MS * 8

let pollTimer: ReturnType<typeof setTimeout> | null = null
/** Bumped on every start/stop so an in-flight tick from a superseded run cannot reschedule itself. */
let pollGeneration = 0
let currentIntervalMs = POLL_BASE_MS
let teardownWired = false

/**
 * Fetch usage/weekly/balance in parallel and merge into the store.
 *
 * Contract T2: main resolves `null` on failure rather than throwing for `usage`/`balance` — a
 * resolved `null` must leave the previous value in place, exactly like a rejected promise, so a
 * transient failure never regresses a `$0.00`/`0%` false reading over a genuine last-known value.
 *
 * Returns whether every call came back with usable (non-null) data, for the poller's backoff.
 */
async function loadQuota(set: SetState, get: GetState): Promise<boolean> {
  const bridge = api()
  const [usageResult, weeklyResult, balanceResult] = await Promise.allSettled([
    bridge.nanogpt.usage(),
    bridge.nanogpt.weeklyUsage(),
    bridge.nanogpt.balance()
  ])

  const nanoUsage: NanoUsage | null =
    usageResult.status === 'fulfilled' && usageResult.value !== null ? usageResult.value : get().nanoUsage

  const nanoWeeklyUsage: WeeklyTokenData | null =
    weeklyResult.status === 'fulfilled' ? weeklyResult.value : get().nanoWeeklyUsage

  const nanoBalance: NanoBalance | null =
    balanceResult.status === 'fulfilled' && balanceResult.value !== null ? balanceResult.value : get().nanoBalance

  set({ nanoUsage, nanoWeeklyUsage, nanoBalance })

  return (
    usageResult.status === 'fulfilled' &&
    usageResult.value !== null &&
    weeklyResult.status === 'fulfilled' &&
    balanceResult.status === 'fulfilled' &&
    balanceResult.value !== null
  )
}

export function createNanoQuotaSlice(set: SetState, get: GetState): NanoQuotaSlice {
  return {
    nanoUsage: null,
    nanoBalance: null,
    nanoWeeklyUsage: null,
    showBalanceInStatus: false,

    async fetchNanoQuota(): Promise<boolean> {
      try {
        return await loadQuota(set, get)
      } catch {
        /* best effort; leave previous quota state intact */
        return false
      }
    },

    setShowBalanceInStatus(show: boolean): void {
      set({ showBalanceInStatus: show })
      savePrefs({
        directory: get().directory,
        providerID: get().providerID,
        modelID: get().modelID,
        theme: get().theme,
        modelPool: get().modelPool,
        routingMode: get().routingMode,
        showPaidModels: get().showPaidModels,
        viewMode: get().viewMode,
        showBalanceInStatus: show
      })
    }
  }
}

/**
 * Start background polling for quota updates.
 *
 * D4: gated on a NanoGPT key actually being configured — `linkedProviderIDs` is the
 * main-verified source of truth (never inferred from provider metadata). Without this gate every
 * user pays three network round-trips every 90s forever, even when NanoGPT is never used.
 *
 * Backs off by doubling the interval (capped at `POLL_MAX_MS`) after each poll that comes back
 * without full data, and resets to `POLL_BASE_MS` the moment a poll fully succeeds. Safe to call
 * multiple times; replaces any existing timer/schedule.
 */
export function startNanoQuotaPolling(get: GetState): void {
  stopNanoQuotaPolling()

  if (!get().linkedProviderIDs?.includes('nanogpt')) return

  wireTeardown()

  const generation = ++pollGeneration
  currentIntervalMs = POLL_BASE_MS

  const schedule = (): void => {
    if (generation !== pollGeneration) return
    pollTimer = setTimeout(tick, currentIntervalMs)
  }

  const tick = (): void => {
    if (generation !== pollGeneration) return
    void get()
      .fetchNanoQuota()
      .then((ok) => {
        if (generation !== pollGeneration) return
        currentIntervalMs = ok ? POLL_BASE_MS : Math.min(currentIntervalMs * 2, POLL_MAX_MS)
        schedule()
      })
  }

  // Initial fetch runs immediately; its result seeds the first backoff decision.
  tick()
}

/** Stop quota background polling (e.g. on app teardown or unit test cleanup). */
export function stopNanoQuotaPolling(): void {
  pollGeneration++
  if (pollTimer) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
  currentIntervalMs = POLL_BASE_MS
}

/** Ensures the timer does not outlive the window (D4). Wired once; a no-op outside a DOM/window context (e.g. unit tests). */
function wireTeardown(): void {
  if (teardownWired) return
  teardownWired = true
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
  window.addEventListener('beforeunload', () => stopNanoQuotaPolling())
}
