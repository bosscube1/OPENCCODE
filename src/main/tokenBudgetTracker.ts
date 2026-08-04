/**
 * Main-process service tracking weekly token budget for NanoGPT models per ISO week (YYYY-Www).
 *
 * Listens to `opencode serve` SSE stream events emitted via `server.ts`.
 * Accumulates input and output tokens for any `nanogpt/*` model.
 * Auto-resets counters when transitioning to a new ISO week.
 */
import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface WeeklyTokenData {
  weekKey: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

/**
 * Documented NanoGPT subscription cap (contract T3): 60 million INPUT tokens per week.
 * This is NOT a total-token cap — `outputTokens` is tracked for display only and must
 * never be compared against this constant.
 */
export const WEEKLY_INPUT_TOKEN_CAP = 60_000_000

function dataFilePath(): string {
  return join(app.getPath('userData'), 'nanogpt-weekly-tokens.json')
}

/** Compute ISO week key formatted as "YYYY-Www" (e.g. "2026-W32"). */
export function getISOWeekKey(d: Date = new Date()): string {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const dayNum = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  const weekNo = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  const weekStr = weekNo < 10 ? `0${weekNo}` : `${weekNo}`
  return `${date.getUTCFullYear()}-W${weekStr}`
}

function emptyWeeklyData(weekKey = getISOWeekKey()): WeeklyTokenData {
  return {
    weekKey,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0
  }
}

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null
}

export class TokenBudgetTracker {
  /** Lazily initialized on first use — never touch disk/Electron APIs at construction (D3). */
  private currentData: WeeklyTokenData | null = null

  /**
   * Last-seen cumulative {input, output} totals per message id, used to derive per-event
   * deltas from opencode's cumulative `message.updated` totals (D1). Bounded the same way
   * `processedIds` was bounded before: past ~1000 tracked ids, the oldest entry is dropped.
   * A dropped entry re-baselines to 0 on next sight (i.e. it is treated as a fresh message
   * id, and its next cumulative reading becomes the first delta) rather than attempting to
   * reconstruct lost state — bounded memory and forward progress are prioritized over the
   * negligible risk of a re-count for a message id that survives past 1000 other distinct
   * message ids without another update.
   */
  private lastSeenTotals = new Map<string, { input: number; output: number }>()

  /** Tracks the most recent in-flight save so `whenSettled()` can await it (D4). */
  private pendingSave: Promise<void> | null = null

  /** Lazily load persisted state on first access instead of doing disk I/O at construction. */
  private data(): WeeklyTokenData {
    if (this.currentData === null) {
      this.currentData = this.loadSync()
    }
    return this.currentData
  }

  /** Get current weekly token counts, auto-rolling over if the ISO week has changed. */
  getWeeklyTokens(): WeeklyTokenData {
    this.checkWeekRollover()
    return { ...this.data() }
  }

  /**
   * Process an SSE event payload from `opencode serve`.
   * Accumulates tokens if the event pertains to a `nanogpt` model.
   *
   * opencode's `message.updated` event carries the running CUMULATIVE token total for that
   * message (it fires repeatedly as the message streams), not a per-event delta. We diff
   * against the last-seen cumulative total for that message id and add only the positive
   * difference.
   */
  recordEvent(event: unknown): void {
    if (!isRecord(event)) return

    const properties = isRecord(event.properties) ? event.properties : {}
    const info = isRecord(properties.info) ? properties.info : {}

    // Extract provider and model from info or properties
    const providerID = typeof info.providerID === 'string'
      ? info.providerID
      : typeof properties.providerID === 'string'
        ? properties.providerID
        : ''

    const modelID = typeof info.modelID === 'string'
      ? info.modelID
      : typeof properties.modelID === 'string'
        ? properties.modelID
        : ''

    const isNanoGPT =
      providerID === 'nanogpt' ||
      providerID.includes('nanogpt') ||
      modelID.startsWith('nanogpt/')

    if (!isNanoGPT) return

    // Extract token metrics from info.tokens or properties.tokens
    const tokensSource = isRecord(info.tokens)
      ? info.tokens
      : isRecord(properties.tokens)
        ? properties.tokens
        : null

    if (!tokensSource) return

    // Message id used to diff cumulative totals into deltas. Keyed on id ALONE (never on
    // the token values themselves — that was the D1 bug: keying on values made every
    // cumulative update look like a "new" event and re-added the whole running total).
    const messageId = typeof info.id === 'string'
      ? info.id
      : typeof properties.id === 'string'
        ? properties.id
        : null

    const cumulativeInput = typeof tokensSource.input === 'number' && Number.isFinite(tokensSource.input)
      ? tokensSource.input
      : 0
    const cumulativeOutput = typeof tokensSource.output === 'number' && Number.isFinite(tokensSource.output)
      ? tokensSource.output
      : 0

    if (cumulativeInput === 0 && cumulativeOutput === 0) return

    if (!messageId) {
      // No id to diff against — nothing to dedupe/delta, treat the reading as-is.
      this.addTokens(cumulativeInput, cumulativeOutput)
      return
    }

    // The baseline is a monotonic high-water-mark, not just "the last reading" — an
    // out-of-order or stale lower reading must never move it down. If it did, a later
    // partial recovery (e.g. 400 -> 250 (stale) -> 300) would compute a positive delta
    // against the lowered baseline and re-credit tokens already counted at the peak.
    const baseline = this.lastSeenTotals.get(messageId) ?? { input: 0, output: 0 }
    const deltaInput = Math.max(0, cumulativeInput - baseline.input)
    const deltaOutput = Math.max(0, cumulativeOutput - baseline.output)

    this.lastSeenTotals.set(messageId, {
      input: Math.max(baseline.input, cumulativeInput),
      output: Math.max(baseline.output, cumulativeOutput)
    })

    // Keep lastSeenTotals bounded to ~1000 entries, same as processedIds was bounded before.
    if (this.lastSeenTotals.size > 1000) {
      const firstKey = this.lastSeenTotals.keys().next().value
      if (firstKey !== undefined) this.lastSeenTotals.delete(firstKey)
    }

    if (deltaInput === 0 && deltaOutput === 0) return

    this.addTokens(deltaInput, deltaOutput)
  }

  /** Add input and output tokens directly. */
  addTokens(input: number, output: number): void {
    this.checkWeekRollover()
    const data = this.data()
    data.inputTokens += Math.max(0, input)
    data.outputTokens += Math.max(0, output)
    data.totalTokens = data.inputTokens + data.outputTokens
    this.triggerSave()
  }

  /** Reset counter for testing or manual reset. */
  reset(weekKey = getISOWeekKey()): void {
    this.currentData = emptyWeeklyData(weekKey)
    this.lastSeenTotals.clear()
    this.triggerSave()
  }

  /** Resolves once any in-flight save (including one triggered just before this call) completes. */
  async whenSettled(): Promise<void> {
    await this.pendingSave
  }

  private checkWeekRollover(): void {
    const activeWeek = getISOWeekKey()
    if (this.data().weekKey !== activeWeek) {
      this.currentData = emptyWeeklyData(activeWeek)
      this.lastSeenTotals.clear()
      this.triggerSave()
    }
  }

  private loadSync(): WeeklyTokenData {
    try {
      const path = dataFilePath()
      if (!existsSync(path)) return emptyWeeklyData()
      const raw = readFileSync(path, 'utf8')
      const parsed = JSON.parse(raw) as unknown
      if (!isRecord(parsed)) return emptyWeeklyData()

      const weekKey = typeof parsed.weekKey === 'string' ? parsed.weekKey : getISOWeekKey()
      if (weekKey !== getISOWeekKey()) return emptyWeeklyData()

      const inputTokens = typeof parsed.inputTokens === 'number' && Number.isFinite(parsed.inputTokens)
        ? parsed.inputTokens
        : 0
      const outputTokens = typeof parsed.outputTokens === 'number' && Number.isFinite(parsed.outputTokens)
        ? parsed.outputTokens
        : 0
      const totalTokens = typeof parsed.totalTokens === 'number' && Number.isFinite(parsed.totalTokens)
        ? parsed.totalTokens
        : inputTokens + outputTokens

      return { weekKey, inputTokens, outputTokens, totalTokens }
    } catch {
      return emptyWeeklyData()
    }
  }

  /** Kick off a save and track it so `whenSettled()` can be awaited by callers (D4). */
  private triggerSave(): void {
    const snapshot = { ...this.data() }
    this.pendingSave = (async () => {
      try {
        await writeFile(dataFilePath(), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
      } catch {
        /* best effort */
      }
    })()
  }
}

/** Main-process singleton instance. Load is lazy — no disk I/O happens at import time (D3). */
export const tokenBudgetTracker = new TokenBudgetTracker()
