/**
 * Main-process rate limiter and concurrency queue for NanoGPT API requests.
 *
 * Enforces NanoGPT's documented rate limits across all Electron windows:
 * - Max concurrent in-flight requests: 10
 * - Sliding burst window: 10 requests per 10,000 ms
 * - Sustained window: 60 requests per 60,000 ms
 *
 * Usage:
 * ```ts
 * const release = await nanogptLimiter.acquireSlot()
 * try {
 *   return await doApiCall()
 * } finally {
 *   release()
 * }
 * ```
 */

export interface RateLimiterOptions {
  maxConcurrent?: number
  burstLimit?: number
  burstWindowMs?: number
  sustainedLimit?: number
  sustainedWindowMs?: number
}

export class NanogptLimiter {
  private maxConcurrent: number
  private burstLimit: number
  private burstWindowMs: number
  private sustainedLimit: number
  private sustainedWindowMs: number

  private activeRequests = 0
  private requestTimestamps: number[] = []
  private sustainedTimestamps: number[] = []
  private queue: Array<{ resolve: (release: () => void) => void }> = []
  private checkTimer: NodeJS.Timeout | null = null
  private pauseUntil: number = 0

  constructor(options: RateLimiterOptions = {}) {
    this.maxConcurrent = options.maxConcurrent ?? 10
    this.burstLimit = options.burstLimit ?? 10
    this.burstWindowMs = options.burstWindowMs ?? 10_000
    this.sustainedLimit = options.sustainedLimit ?? 60
    this.sustainedWindowMs = options.sustainedWindowMs ?? 60_000
  }

  /**
   * Acquire a slot for a NanoGPT request.
   * If limits are exceeded, returns a Promise that resolves when capacity becomes available.
   * Returns a `release` callback that MUST be called when the request completes or fails.
   */
  async acquireSlot(): Promise<() => void> {
    if (this.queue.length === 0 && this.canProceed()) {
      return this.takeSlot()
    }

    return new Promise<() => void>((resolve) => {
      this.queue.push({ resolve })
      this.scheduleCheck()
    })
  }

  /** Current number of active in-flight requests. */
  getActiveCount(): number {
    return this.activeRequests
  }

  /** Current length of the waiting queue. */
  getQueueLength(): number {
    return this.queue.length
  }

  /** Reset all internal state and timers. Useful for unit tests. */
  reset(): void {
    this.activeRequests = 0
    this.requestTimestamps = []
    this.sustainedTimestamps = []
    this.queue = []
    this.pauseUntil = 0
    if (this.checkTimer) {
      clearTimeout(this.checkTimer)
      this.checkTimer = null
    }
  }

  private pruneTimestamps(): void {
    const now = Date.now()
    const burstCutoff = now - this.burstWindowMs
    const sustainedCutoff = now - this.sustainedWindowMs
    this.requestTimestamps = this.requestTimestamps.filter((ts) => ts > burstCutoff)
    this.sustainedTimestamps = this.sustainedTimestamps.filter((ts) => ts > sustainedCutoff)
  }

  private canProceed(): boolean {
    this.pruneTimestamps()
    const now = Date.now()
    return (
      now >= this.pauseUntil &&
      this.activeRequests < this.maxConcurrent &&
      this.requestTimestamps.length < this.burstLimit &&
      this.sustainedTimestamps.length < this.sustainedLimit
    )
  }

  private takeSlot(): () => void {
    this.activeRequests++
    const now = Date.now()
    this.requestTimestamps.push(now)
    this.sustainedTimestamps.push(now)

    let released = false
    return () => {
      if (released) return
      released = true
      this.activeRequests = Math.max(0, this.activeRequests - 1)
      this.processQueue()
    }
  }

  private processQueue(): void {
    while (this.queue.length > 0 && this.canProceed()) {
      const next = this.queue.shift()
      if (next) {
        const release = this.takeSlot()
        next.resolve(release)
      }
    }

    this.scheduleCheck()
  }

  /**
   * Pause new grants for the specified duration (e.g., when a 429 Retry-After is received).
   * Existing in-flight requests are unaffected; only new slot acquisitions are deferred.
   */
  pauseFor(ms: number): void {
    this.pauseUntil = Math.max(this.pauseUntil, Date.now() + ms)
  }

  private scheduleCheck(): void {
    if (this.checkTimer) {
      clearTimeout(this.checkTimer)
      this.checkTimer = null
    }

    if (this.queue.length === 0) return

    this.pruneTimestamps()

    const now = Date.now()
    let nextWakeMs = Infinity

    // Account for pause deadline
    if (this.pauseUntil > now) {
      nextWakeMs = Math.min(nextWakeMs, this.pauseUntil - now)
    }

    // Account for burst window expiry
    if (this.requestTimestamps.length > 0) {
      const oldest = this.requestTimestamps[0]
      const burstWakeMs = oldest + this.burstWindowMs - now
      nextWakeMs = Math.min(nextWakeMs, burstWakeMs)
    }

    // Account for sustained window expiry
    if (this.sustainedTimestamps.length > 0) {
      const oldest = this.sustainedTimestamps[0]
      const sustainedWakeMs = oldest + this.sustainedWindowMs - now
      nextWakeMs = Math.min(nextWakeMs, sustainedWakeMs)
    }

    if (!Number.isFinite(nextWakeMs)) return

    const waitMs = Math.max(1, nextWakeMs)
    this.checkTimer = setTimeout(() => {
      this.checkTimer = null
      this.processQueue()
    }, waitMs)
  }
}

/** Main-process singleton instance. */
export const nanogptLimiter = new NanogptLimiter()
