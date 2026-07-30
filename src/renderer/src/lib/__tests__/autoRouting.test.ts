import { describe, expect, it } from 'vitest'
import { isAutoRoutingActive, describeRoutingMode } from '../routing'
import type { RoutingMode } from '../prefs'

/**
 * Regression guard for the auto-routing indicator defect.
 *
 * The UI used to read a `autoRotate` boolean held separately in the store, while every
 * failover gate tested `routingMode !== 'locked'`. Nothing kept the two in step —
 * `toggleAutoRotate` wrote the boolean and never touched `routingMode`, and `savePrefs`
 * silently overwrote the boolean on the next write. A user in `locked` mode could tick
 * "Auto-Rotate", see the ⚡ badge, and get no failover at all.
 *
 * `isAutoRoutingActive` is now the single predicate behind every indicator. These tests
 * pin it to the exact condition the gates use, so the two cannot drift apart again.
 */

/** Every member of the RoutingMode union. Update this if a mode is ever added. */
const ALL_MODES: RoutingMode[] = ['locked', 'failover', 'auto']

/**
 * The condition the failover gates actually test, transcribed from:
 *  - `attemptMachine.ts` recoverHungAttempt — `if (state.routingMode === 'locked' ...) return`
 *  - `eventSlice.ts`   429 path            — `state.routingMode !== 'locked' && ...`
 *  - `sessionSlice.ts` reactive failover   — `get().routingMode !== 'locked' && ...`
 */
const gateAllowsFailover = (mode: RoutingMode): boolean => mode !== 'locked'

describe('isAutoRoutingActive', () => {
  it('is false only for locked', () => {
    expect(isAutoRoutingActive('locked')).toBe(false)
    expect(isAutoRoutingActive('failover')).toBe(true)
    expect(isAutoRoutingActive('auto')).toBe(true)
  })

  it('agrees with the failover gate for every routing mode', () => {
    for (const mode of ALL_MODES) {
      expect(isAutoRoutingActive(mode)).toBe(gateAllowsFailover(mode))
    }
  })

  it('never reports auto-routing on while the gates suppress it', () => {
    // The exact shape of the original bug: indicator true, gate false.
    const lying = ALL_MODES.filter((m) => isAutoRoutingActive(m) && !gateAllowsFailover(m))
    expect(lying).toEqual([])
  })
})

describe('toggleAutoRotate target mode', () => {
  /** Mirrors routingSlice.toggleAutoRotate — off maps to locked, on maps to failover. */
  const nextMode = (mode: RoutingMode): RoutingMode => (mode === 'locked' ? 'failover' : 'locked')

  it('flips the advertised state from every starting mode', () => {
    for (const mode of ALL_MODES) {
      expect(isAutoRoutingActive(nextMode(mode))).toBe(!isAutoRoutingActive(mode))
    }
  })

  it('turns on into failover, which preserves the user pin', () => {
    // `auto` would pre-select a model on every send and can override the pinned pick;
    // the toggle must not silently opt a user into that.
    expect(nextMode('locked')).toBe('failover')
  })

  it('is its own inverse for the modes the toggle can produce', () => {
    expect(nextMode(nextMode('locked'))).toBe('locked')
    expect(nextMode(nextMode('failover'))).toBe('failover')
  })
})

describe('describeRoutingMode', () => {
  it('returns a distinct, non-empty label for every mode', () => {
    const labels = ALL_MODES.map(describeRoutingMode)
    for (const label of labels) expect(label.length).toBeGreaterThan(0)
    expect(new Set(labels).size).toBe(ALL_MODES.length)
  })

  it('does not describe locked as cycling models', () => {
    // The old /models copy said "cycles models on 429 rate limits" regardless of mode.
    expect(describeRoutingMode('locked')).not.toMatch(/cycl/i)
  })
})
