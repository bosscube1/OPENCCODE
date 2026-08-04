import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const state = vi.hoisted(() => ({ userDataPath: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => state.userDataPath }
}))

import { getISOWeekKey, tokenBudgetTracker, WEEKLY_INPUT_TOKEN_CAP } from '../tokenBudgetTracker'

describe('tokenBudgetTracker', () => {
  beforeEach(() => {
    state.userDataPath = mkdtempSync(join(tmpdir(), 'opencode-tokenbudget-'))
    tokenBudgetTracker.reset()
  })

  afterEach(async () => {
    tokenBudgetTracker.reset()
    await tokenBudgetTracker.whenSettled()
    rmSync(state.userDataPath, { recursive: true, force: true })
  })

  it('computes correct ISO week keys', () => {
    const d1 = new Date(Date.UTC(2026, 7, 4)) // Aug 4, 2026
    expect(getISOWeekKey(d1)).toBe('2026-W32')
  })

  it('initializes with zero token counts for current week', () => {
    const weekly = tokenBudgetTracker.getWeeklyTokens()
    expect(weekly.weekKey).toBe(getISOWeekKey())
    expect(weekly.inputTokens).toBe(0)
    expect(weekly.outputTokens).toBe(0)
    expect(weekly.totalTokens).toBe(0)
  })

  it('accumulates tokens from valid nanogpt SSE message events', () => {
    const event = {
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg-1',
          providerID: 'nanogpt',
          modelID: 'gpt-4o',
          tokens: { input: 1200, output: 350, total: 1550 }
        }
      }
    }

    tokenBudgetTracker.recordEvent(event)

    const weekly = tokenBudgetTracker.getWeeklyTokens()
    expect(weekly.inputTokens).toBe(1200)
    expect(weekly.outputTokens).toBe(350)
    expect(weekly.totalTokens).toBe(1550)
  })

  it('ignores non-nanogpt provider events', () => {
    const event = {
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg-2',
          providerID: 'anthropic',
          modelID: 'claude-3-5-sonnet',
          tokens: { input: 5000, output: 1000 }
        }
      }
    }

    tokenBudgetTracker.recordEvent(event)

    const weekly = tokenBudgetTracker.getWeeklyTokens()
    expect(weekly.inputTokens).toBe(0)
    expect(weekly.totalTokens).toBe(0)
  })

  it('deduplicates identical message events', () => {
    const event = {
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg-dup',
          providerID: 'nanogpt',
          modelID: 'gpt-4o',
          tokens: { input: 100, output: 50 }
        }
      }
    }

    tokenBudgetTracker.recordEvent(event)
    tokenBudgetTracker.recordEvent(event) // second time

    const weekly = tokenBudgetTracker.getWeeklyTokens()
    expect(weekly.inputTokens).toBe(100)
    expect(weekly.outputTokens).toBe(50)
  })

  it('auto-resets counts on ISO week rollover', () => {
    tokenBudgetTracker.addTokens(5000, 1000)
    expect(tokenBudgetTracker.getWeeklyTokens().totalTokens).toBe(6000)

    // Reset with a different week key
    tokenBudgetTracker.reset('2026-W31')
    expect(tokenBudgetTracker.getWeeklyTokens().weekKey).toBe(getISOWeekKey())
    expect(tokenBudgetTracker.getWeeklyTokens().totalTokens).toBe(0)
  })

  it('exports the documented 60M weekly INPUT token cap', () => {
    expect(WEEKLY_INPUT_TOKEN_CAP).toBe(60_000_000)
  })

  function nanoEvent(id: string, input: number, output: number): unknown {
    return {
      type: 'message.updated',
      properties: {
        info: {
          id,
          providerID: 'nanogpt',
          modelID: 'gpt-4o',
          tokens: { input, output }
        }
      }
    }
  }

  it('diffs cumulative message.updated totals into deltas instead of summing raw totals (D1)', () => {
    tokenBudgetTracker.recordEvent(nanoEvent('msg-cum', 100, 0))
    tokenBudgetTracker.recordEvent(nanoEvent('msg-cum', 250, 0))
    tokenBudgetTracker.recordEvent(nanoEvent('msg-cum', 400, 0))

    const weekly = tokenBudgetTracker.getWeeklyTokens()
    // Cumulative totals 100 -> 250 -> 400 must accumulate to 400 (the final cumulative
    // value), not 750 (the naive sum of all three raw readings).
    expect(weekly.inputTokens).toBe(400)
  })

  it('never subtracts or double counts on out-of-order / decreasing cumulative totals', () => {
    tokenBudgetTracker.recordEvent(nanoEvent('msg-ooo', 400, 0))
    // A later event reports a lower cumulative total than we've already seen (out-of-order
    // delivery, or a re-sent stale snapshot).
    tokenBudgetTracker.recordEvent(nanoEvent('msg-ooo', 250, 0))
    expect(tokenBudgetTracker.getWeeklyTokens().inputTokens).toBe(400)

    // A subsequent increase from that lower baseline must not re-add the gap that was
    // already counted, nor should it ever cause the running total to go down.
    tokenBudgetTracker.recordEvent(nanoEvent('msg-ooo', 300, 0))
    expect(tokenBudgetTracker.getWeeklyTokens().inputTokens).toBe(400)

    // A subsequent event above the original peak only adds the true delta beyond it.
    tokenBudgetTracker.recordEvent(nanoEvent('msg-ooo', 500, 0))
    expect(tokenBudgetTracker.getWeeklyTokens().inputTokens).toBe(500)
  })

  it('exposes whenSettled() so callers can await the in-flight save', async () => {
    tokenBudgetTracker.addTokens(10, 5)
    await expect(tokenBudgetTracker.whenSettled()).resolves.toBeUndefined()
  })
})
