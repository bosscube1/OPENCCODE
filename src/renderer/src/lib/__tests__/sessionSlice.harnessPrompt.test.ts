import { describe, expect, it, vi } from 'vitest'
import type { AppState, SetState, GetState } from '../slices/types'

vi.mock('../slices/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../slices/api')>()
  return { ...actual, api: vi.fn() }
})

import { harnessPromptFields, createSessionSlice, type SessionSlice } from '../slices/sessionSlice'

/** Minimal harness mirroring zustand's set/get shape, without pulling in zustand itself. */
function createStore(): { get: GetState; set: SetState } {
  let state = {} as AppState
  const set = ((partial: unknown) => {
    const patch = typeof partial === 'function' ? (partial as (s: AppState) => Partial<AppState>)(state) : partial
    state = { ...state, ...(patch as Partial<AppState>) }
  }) as SetState
  const get: GetState = () => state
  return { get, set }
}

/**
 * Installs the slice's defaults first, then layers the test's overrides on top.
 * Includes sessionAgents and sessionReadOnly as required by harnessPromptFields.
 */
function setup(overrides: Partial<AppState> = {}): { get: GetState; set: SetState; slice: SessionSlice } {
  const { get, set } = createStore()
  const slice = createSessionSlice(set, get)
  set(slice)
  set({
    providers: [],
    linkedProviderIDs: [],
    routingMode: 'failover',
    modelPool: null,
    providerID: null,
    modelID: null,
    theme: 'auto',
    permissions: [],
    error: null,
    sessionAgents: {},
    sessionReadOnly: {},
    clearSubagents: () => {}
  } as Partial<AppState>)
  set(overrides)
  return { get, set, slice }
}

describe('sessionSlice.harnessPromptFields memoization', () => {
  // harnessPromptFields is memoized to avoid recomputing on every send. It's a pure function
  // of its effective inputs: sessionID, sessionAgents[sessionID], and sessionReadOnly[sessionID].
  //
  // The memoization strategy is a single-entry cache keyed on these three values.
  // When inputs are unchanged, the same result object is returned (cache hit).
  // When inputs change, a new result is computed and cached (cache miss).

  describe('field shape', () => {
    it('includes agent field when agent is pinned for the session', () => {
      const { get } = setup({
        sessionAgents: { 's1': 'claude-opus' },
        sessionReadOnly: { 's1': false }
      })

      const result = harnessPromptFields(get, 's1')
      expect(result).toEqual({ agent: 'claude-opus' })
      expect(result.agent).toBe('claude-opus')
      expect(result.tools).toBeUndefined()
    })

    it('omits agent field when no agent is pinned', () => {
      const { get } = setup({
        sessionAgents: {},
        sessionReadOnly: { 's1': false }
      })

      const result = harnessPromptFields(get, 's1')
      expect(result).toEqual({})
      expect(result.agent).toBeUndefined()
    })

    it('includes tools field (readonly policy) when readOnly is true', () => {
      const { get } = setup({
        sessionAgents: {},
        sessionReadOnly: { 's1': true }
      })

      const result = harnessPromptFields(get, 's1')
      expect(result.tools).toBeDefined()
      expect(typeof result.tools).toBe('object')
      expect(result.agent).toBeUndefined()
    })

    it('omits tools field when readOnly is false', () => {
      const { get } = setup({
        sessionAgents: {},
        sessionReadOnly: { 's1': false }
      })

      const result = harnessPromptFields(get, 's1')
      expect(result.tools).toBeUndefined()
    })

    it('includes both agent and tools when both are active', () => {
      const { get } = setup({
        sessionAgents: { 's1': 'claude-opus' },
        sessionReadOnly: { 's1': true }
      })

      const result = harnessPromptFields(get, 's1')
      expect(result.agent).toBe('claude-opus')
      expect(result.tools).toBeDefined()
      expect(typeof result.tools).toBe('object')
    })

    it('includes neither agent nor tools when both are inactive', () => {
      const { get } = setup({
        sessionAgents: {},
        sessionReadOnly: { 's1': false }
      })

      const result = harnessPromptFields(get, 's1')
      expect(result).toEqual({})
    })

    it('omits agent field when agent is explicitly empty string (falsy but not undefined)', () => {
      const { get } = setup({
        sessionAgents: { 's1': '' as unknown as string },
        sessionReadOnly: { 's1': false }
      })

      const result = harnessPromptFields(get, 's1')
      expect(result).toEqual({})
      expect(result.agent).toBeUndefined()
    })

    it('handles missing sessionID (returns undefined for agent, false for readOnly)', () => {
      const { get } = setup({
        sessionAgents: {},
        sessionReadOnly: {}
      })

      const result = harnessPromptFields(get, 'nonexistent')
      expect(result).toEqual({})
      expect(result.agent).toBeUndefined()
      expect(result.tools).toBeUndefined()
    })
  })

  describe('memoization hits', () => {
    it('returns the same object reference when called twice with unchanged state', () => {
      const { get } = setup({
        sessionAgents: { 's1': 'claude-opus' },
        sessionReadOnly: { 's1': true }
      })

      const first = harnessPromptFields(get, 's1')
      const second = harnessPromptFields(get, 's1')

      // Reference identity: cache is working
      expect(first).toBe(second)
    })

    it('returns the same reference for multiple cache hits within a session', () => {
      const { get } = setup({
        sessionAgents: { 's1': 'claude-sonnet' },
        sessionReadOnly: { 's1': false }
      })

      const result1 = harnessPromptFields(get, 's1')
      const result2 = harnessPromptFields(get, 's1')
      const result3 = harnessPromptFields(get, 's1')

      expect(result1).toBe(result2)
      expect(result2).toBe(result3)
    })

    it('maintains cache hit even when result object is empty', () => {
      const { get } = setup({
        sessionAgents: {},
        sessionReadOnly: { 's1': false }
      })

      const first = harnessPromptFields(get, 's1')
      const second = harnessPromptFields(get, 's1')

      // Empty objects should also be cached
      expect(first).toBe(second)
    })
  })

  describe('memoization misses', () => {
    it('returns a new reference when sessionID changes', () => {
      const { get } = setup({
        sessionAgents: { 's1': 'claude-opus', 's2': 'claude-opus' },
        sessionReadOnly: { 's1': false, 's2': false }
      })

      const first = harnessPromptFields(get, 's1')
      const second = harnessPromptFields(get, 's2')

      // Different sessions → new reference
      expect(first).not.toBe(second)
      expect(first).toEqual(second)
    })

    it('returns a new reference when agent value changes for same sessionID', () => {
      const { get, set } = setup({
        sessionAgents: { 's1': 'claude-opus' },
        sessionReadOnly: { 's1': false }
      })

      const first = harnessPromptFields(get, 's1')
      set({ sessionAgents: { 's1': 'claude-sonnet' } })
      const second = harnessPromptFields(get, 's1')

      // Agent changed → new reference
      expect(first).not.toBe(second)
      expect(first.agent).toBe('claude-opus')
      expect(second.agent).toBe('claude-sonnet')
    })

    it('returns a new reference when agent is added', () => {
      const { get, set } = setup({
        sessionAgents: {},
        sessionReadOnly: { 's1': false }
      })

      const first = harnessPromptFields(get, 's1')
      set({ sessionAgents: { 's1': 'claude-opus' } })
      const second = harnessPromptFields(get, 's1')

      // Agent added → new reference
      expect(first).not.toBe(second)
      expect(first.agent).toBeUndefined()
      expect(second.agent).toBe('claude-opus')
    })

    it('returns a new reference when agent is removed', () => {
      const { get, set } = setup({
        sessionAgents: { 's1': 'claude-opus' },
        sessionReadOnly: { 's1': false }
      })

      const first = harnessPromptFields(get, 's1')
      set({ sessionAgents: {} })
      const second = harnessPromptFields(get, 's1')

      // Agent removed → new reference
      expect(first).not.toBe(second)
      expect(first.agent).toBe('claude-opus')
      expect(second.agent).toBeUndefined()
    })

    it('returns a new reference when readOnly flag changes from false to true', () => {
      const { get, set } = setup({
        sessionAgents: {},
        sessionReadOnly: { 's1': false }
      })

      const first = harnessPromptFields(get, 's1')
      set({ sessionReadOnly: { 's1': true } })
      const second = harnessPromptFields(get, 's1')

      // readOnly changed → new reference (regression: stale prompt)
      expect(first).not.toBe(second)
      expect(first.tools).toBeUndefined()
      expect(second.tools).toBeDefined()
    })

    it('returns a new reference when readOnly flag changes from true to false', () => {
      const { get, set } = setup({
        sessionAgents: {},
        sessionReadOnly: { 's1': true }
      })

      const first = harnessPromptFields(get, 's1')
      set({ sessionReadOnly: { 's1': false } })
      const second = harnessPromptFields(get, 's1')

      // readOnly changed → new reference
      expect(first).not.toBe(second)
      expect(first.tools).toBeDefined()
      expect(second.tools).toBeUndefined()
    })

    it('returns a new reference when both agent and readOnly change independently', () => {
      const { get, set } = setup({
        sessionAgents: { 's1': 'claude-opus' },
        sessionReadOnly: { 's1': false }
      })

      const first = harnessPromptFields(get, 's1')

      // Change agent only
      set({ sessionAgents: { 's1': 'claude-sonnet' } })
      const second = harnessPromptFields(get, 's1')
      expect(second).not.toBe(first)

      // Change readOnly only
      set({ sessionReadOnly: { 's1': true } })
      const third = harnessPromptFields(get, 's1')
      expect(third).not.toBe(second)
    })
  })

  describe('readOnly strictness (=== true)', () => {
    it('requires exact true value to include tools (not just truthy)', () => {
      const { get } = setup({
        sessionAgents: {},
        sessionReadOnly: { 's1': 1 as unknown as boolean }
      })

      const result = harnessPromptFields(get, 's1')
      // 1 is truthy but not === true, so tools should be omitted
      expect(result.tools).toBeUndefined()
    })

    it('requires exact true value: string "true" does not trigger tools', () => {
      const { get } = setup({
        sessionAgents: {},
        sessionReadOnly: { 's1': 'true' as unknown as boolean }
      })

      const result = harnessPromptFields(get, 's1')
      expect(result.tools).toBeUndefined()
    })

    it('requires exact true value: null does not trigger tools', () => {
      const { get } = setup({
        sessionAgents: {},
        sessionReadOnly: { 's1': null as unknown as boolean }
      })

      const result = harnessPromptFields(get, 's1')
      expect(result.tools).toBeUndefined()
    })

    it('with literal true, includes tools field', () => {
      const { get } = setup({
        sessionAgents: {},
        sessionReadOnly: { 's1': true }
      })

      const result = harnessPromptFields(get, 's1')
      expect(result.tools).toBeDefined()
      expect(typeof result.tools).toBe('object')
    })
  })

  describe('tools object content', () => {
    it('copies READONLY_TOOLS when readOnly is true', () => {
      const { get } = setup({
        sessionAgents: {},
        sessionReadOnly: { 's1': true }
      })

      const result = harnessPromptFields(get, 's1')
      expect(result.tools).toBeDefined()
      // Tools should be a record of booleans
      if (result.tools) {
        for (const key in result.tools) {
          expect(typeof result.tools[key]).toBe('boolean')
        }
      }
    })

    it('returns a fresh copy of READONLY_TOOLS on each miss', () => {
      const { get, set } = setup({
        sessionAgents: {},
        sessionReadOnly: { 's1': true }
      })

      const first = harnessPromptFields(get, 's1')
      set({ sessionAgents: { 's1': 'claude-opus' } })
      const second = harnessPromptFields(get, 's1')

      // Different sessions/states → different tools object references
      expect(first.tools).not.toBe(second.tools)
      // But content should be equivalent
      expect(first.tools).toEqual(second.tools)
    })
  })
})
