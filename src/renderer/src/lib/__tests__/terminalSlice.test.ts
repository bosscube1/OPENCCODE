import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { OpencodeApi } from '../slices/api'
import type { AppState, SetState, GetState } from '../slices/types'
import type { TermId } from '../types'

vi.mock('../slices/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../slices/api')>()
  return { ...actual, api: vi.fn() }
})

import { api } from '../slices/api'
import { createTerminalSlice, type TerminalSlice } from '../slices/terminalSlice'

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

/**
 * Installs the slice's own defaults first, then layers the test's overrides on top —
 * calling `set(slice)` *after* the overrides would clobber them with the slice's
 * initial values (terminals: [], activeTermID: null).
 */
function setup(overrides: Partial<AppState> = {}): { get: GetState; slice: TerminalSlice } {
  const { get, set } = createStore()
  const slice = createTerminalSlice(set, get)
  set(slice)
  set(overrides)
  return { get, slice }
}

function fakeApi(overrides: Partial<OpencodeApi['term']>): OpencodeApi {
  return { term: { start: vi.fn(), write: vi.fn(), resize: vi.fn(), kill: vi.fn(), onData: vi.fn(), onExit: vi.fn(), ...overrides } } as unknown as OpencodeApi
}

describe('terminalSlice', () => {
  beforeEach(() => {
    mockApi.mockReset()
  })

  describe('startTerminal', () => {
    it('requires a directory first', async () => {
      const startFn = vi.fn()
      mockApi.mockReturnValue(fakeApi({ start: startFn }))

      const { get, slice } = setup({ directory: null })

      await slice.startTerminal()
      expect(startFn).not.toHaveBeenCalled()
      expect(get().error).toBe('Pick a project folder first.')
      expect(get().terminals).toEqual([])
    })

    it('appends a new terminal, numbering titles sequentially, and activates it', async () => {
      let n = 0
      mockApi.mockReturnValue(fakeApi({ start: vi.fn(async () => ({ id: `t${++n}` as TermId })) }))

      const { get, slice } = setup({ directory: '/proj' })

      await slice.startTerminal()
      expect(get().terminals).toEqual([{ id: 't1', title: 'Terminal 1' }])
      expect(get().activeTermID).toBe('t1')

      await slice.startTerminal()
      expect(get().terminals).toEqual([
        { id: 't1', title: 'Terminal 1' },
        { id: 't2', title: 'Terminal 2' }
      ])
      expect(get().activeTermID).toBe('t2')
    })

    it('sets error and leaves the terminal list untouched when the backend fails', async () => {
      mockApi.mockReturnValue(
        fakeApi({
          start: vi.fn(async () => {
            throw new Error('pty spawn failed')
          })
        })
      )

      const { get, slice } = setup({ directory: '/proj' })

      await slice.startTerminal()
      expect(get().error).toBe('pty spawn failed')
      expect(get().terminals).toEqual([])
      expect(get().activeTermID).toBeNull()
    })
  })

  describe('setActiveTermID', () => {
    it('ignores an id that is not a live terminal', () => {
      const { get, slice } = setup({ terminals: [{ id: 't1', title: 'Terminal 1' }], activeTermID: 't1' })

      slice.setActiveTermID('stale-tab' as TermId)
      expect(get().activeTermID).toBe('t1') // unchanged — the stale click is ignored
    })

    it('accepts a live terminal id', () => {
      const { get, slice } = setup({
        terminals: [
          { id: 't1', title: 'Terminal 1' },
          { id: 't2', title: 'Terminal 2' }
        ],
        activeTermID: 't1'
      })

      slice.setActiveTermID('t2')
      expect(get().activeTermID).toBe('t2')
    })

    it('accepts null to clear the active tab', () => {
      const { get, slice } = setup({ terminals: [{ id: 't1', title: 'Terminal 1' }], activeTermID: 't1' })

      slice.setActiveTermID(null)
      expect(get().activeTermID).toBeNull()
    })
  })

  describe('killTerminal', () => {
    it('removes the terminal from the list', async () => {
      mockApi.mockReturnValue(fakeApi({ kill: vi.fn(async () => {}) }))

      const { get, slice } = setup({
        terminals: [
          { id: 't1', title: 'Terminal 1' },
          { id: 't2', title: 'Terminal 2' }
        ],
        activeTermID: 't1'
      })

      await slice.killTerminal('t2')
      expect(get().terminals).toEqual([{ id: 't1', title: 'Terminal 1' }])
      expect(get().activeTermID).toBe('t1') // unaffected — t2 was not active
    })

    it('falls back to the most recently added terminal when the active one is killed', async () => {
      mockApi.mockReturnValue(fakeApi({ kill: vi.fn(async () => {}) }))

      const { get, slice } = setup({
        terminals: [
          { id: 't1', title: 'Terminal 1' },
          { id: 't2', title: 'Terminal 2' },
          { id: 't3', title: 'Terminal 3' }
        ],
        activeTermID: 't2'
      })

      await slice.killTerminal('t2')
      expect(get().terminals.map((t) => t.id)).toEqual(['t1', 't3'])
      expect(get().activeTermID).toBe('t3')
    })

    it('clears activeTermID to null when the last terminal is killed', async () => {
      mockApi.mockReturnValue(fakeApi({ kill: vi.fn(async () => {}) }))

      const { get, slice } = setup({ terminals: [{ id: 't1', title: 'Terminal 1' }], activeTermID: 't1' })

      await slice.killTerminal('t1')
      expect(get().terminals).toEqual([])
      expect(get().activeTermID).toBeNull()
    })

    it('still removes the terminal from the list even when the backend kill call fails', async () => {
      mockApi.mockReturnValue(
        fakeApi({
          kill: vi.fn(async () => {
            throw new Error('pty already gone')
          })
        })
      )

      const { get, slice } = setup({ terminals: [{ id: 't1', title: 'Terminal 1' }], activeTermID: 't1' })

      await slice.killTerminal('t1')
      expect(get().error).toBe('pty already gone')
      // The `finally` block cleans up local state regardless of backend failure.
      expect(get().terminals).toEqual([])
      expect(get().activeTermID).toBeNull()
    })
  })
})
