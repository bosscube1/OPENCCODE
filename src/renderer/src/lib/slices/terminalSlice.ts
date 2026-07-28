/**
 * Terminal session bookkeeping (Phase 1 code surface). The store only tracks which
 * PTYs exist and which is active — output streaming (`term.onData`/`onExit`) is wired
 * directly by the terminal panel component, not buffered in the store.
 */

import { api, errText } from './api'
import type { AppState, SetState, GetState } from './types'
import type { TermId } from '../types'

export type TerminalSlice = Pick<AppState, 'terminals' | 'activeTermID' | 'startTerminal' | 'killTerminal'>

export function createTerminalSlice(set: SetState, get: GetState): TerminalSlice {
  return {
    terminals: [],
    activeTermID: null,

    async startTerminal(): Promise<void> {
      const { directory } = get()
      if (!directory) {
        set({ error: 'Pick a project folder first.' })
        return
      }
      try {
        const { id } = await api().term.start({ directory, cols: 80, rows: 24 })
        set((state) => ({
          terminals: [...state.terminals, { id, title: `Terminal ${state.terminals.length + 1}` }],
          activeTermID: id
        }))
      } catch (e) {
        set({ error: errText(e) })
      }
    },

    async killTerminal(id: TermId): Promise<void> {
      try {
        await api().term.kill(id)
      } catch (e) {
        set({ error: errText(e) })
      } finally {
        set((state) => {
          const terminals = state.terminals.filter((t) => t.id !== id)
          const activeTermID =
            state.activeTermID === id
              ? terminals.length > 0
                ? terminals[terminals.length - 1].id
                : null
              : state.activeTermID
          return { terminals, activeTermID }
        })
      }
    }
  }
}
