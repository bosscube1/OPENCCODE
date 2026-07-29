/**
 * The "agent harness" controls: the server's agent registry for the active directory, the
 * per-session agent picker selection, and the per-session read-only toggle.
 *
 * Both selections are keyed by session id and held in memory only. A session with no entry
 * behaves exactly as before: the server's default agent runs and every tool stays enabled.
 */

import { api } from './api'
import type { AppState, SetState, GetState } from './types'

export type AgentSlice = Pick<
  AppState,
  | 'agents'
  | 'sessionAgents'
  | 'sessionReadOnly'
  | 'loadAgents'
  | 'setSessionAgent'
  | 'setSessionReadOnly'
>

export function createAgentSlice(set: SetState, get: GetState): AgentSlice {
  return {
    agents: [],
    sessionAgents: {},
    sessionReadOnly: {},

    /**
     * Fetch the agent registry for a directory. Called from `setDirectory`; failures are quiet
     * (an empty registry just hides the picker) and a stale response for a previous directory
     * is dropped.
     */
    async loadAgents(directory: string): Promise<void> {
      try {
        const agents = await api().agents(directory)
        if (get().directory !== directory) return
        set({ agents: agents ?? [] })
      } catch {
        if (get().directory === directory) set({ agents: [] })
      }
    },

    setSessionAgent(sessionID: string, agent: string | null): void {
      set((state) => {
        const next = { ...state.sessionAgents }
        if (agent === null) delete next[sessionID]
        else next[sessionID] = agent
        return { sessionAgents: next }
      })
    },

    setSessionReadOnly(sessionID: string, readOnly: boolean): void {
      set((state) => {
        const next = { ...state.sessionReadOnly }
        if (readOnly) next[sessionID] = true
        else delete next[sessionID]
        return { sessionReadOnly: next }
      })
    }
  }
}
