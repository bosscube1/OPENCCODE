import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { OpencodeApi } from '../slices/api'
import type { AppState, SetState, GetState } from '../slices/types'
import type { Agent } from '../types'

vi.mock('../slices/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../slices/api')>()
  return { ...actual, api: vi.fn() }
})

import { api } from '../slices/api'
import { createAgentSlice, type AgentSlice } from '../slices/agentSlice'

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

/** Slice defaults first, then overrides — same ordering trap as subagentSlice.test.ts. */
function setup(overrides: Partial<AppState> = {}): { get: GetState; slice: AgentSlice } {
  const { get, set } = createStore()
  const slice = createAgentSlice(set, get)
  set(slice)
  set(overrides)
  return { get, slice }
}

function makeAgent(name: string, mode: Agent['mode'] = 'primary'): Agent {
  return { name, mode, builtIn: true, permission: { edit: 'ask', bash: {}, tools: {} }, tools: {} } as unknown as Agent
}

describe('agentSlice', () => {
  beforeEach(() => {
    mockApi.mockReset()
  })

  it('pins and clears a per-session agent without touching other sessions', () => {
    const { get, slice } = setup()
    slice.setSessionAgent('s1', 'plan')
    slice.setSessionAgent('s2', 'build')
    expect(get().sessionAgents).toEqual({ s1: 'plan', s2: 'build' })
    slice.setSessionAgent('s1', null)
    expect(get().sessionAgents).toEqual({ s2: 'build' })
  })

  it('stores read-only as a set/delete flag per session', () => {
    const { get, slice } = setup()
    slice.setSessionReadOnly('s1', true)
    slice.setSessionReadOnly('s2', true)
    slice.setSessionReadOnly('s1', false)
    expect(get().sessionReadOnly).toEqual({ s2: true })
  })

  it('loadAgents stores the registry for the current directory', async () => {
    const agents = [makeAgent('build'), makeAgent('plan')]
    mockApi.mockReturnValue({ agents: vi.fn().mockResolvedValue(agents) } as unknown as OpencodeApi)
    const { get, slice } = setup({ directory: '/proj' })
    await slice.loadAgents('/proj')
    expect(get().agents).toEqual(agents)
  })

  it('loadAgents drops a stale response after the directory changed', async () => {
    mockApi.mockReturnValue({ agents: vi.fn().mockResolvedValue([makeAgent('build')]) } as unknown as OpencodeApi)
    const { get, slice } = setup({ directory: '/other' })
    await slice.loadAgents('/proj')
    expect(get().agents).toEqual([])
  })

  it('loadAgents is quiet on failure and clears the registry', async () => {
    mockApi.mockReturnValue({ agents: vi.fn().mockRejectedValue(new Error('down')) } as unknown as OpencodeApi)
    const { get, slice } = setup({ directory: '/proj', agents: [makeAgent('build')] })
    await slice.loadAgents('/proj')
    expect(get().agents).toEqual([])
  })
})
