import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { OpencodeApi } from '../slices/api'
import type { AppState, SetState, GetState } from '../slices/types'
import type { Message, MessageWithParts, Part, Session } from '../types'

vi.mock('../slices/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../slices/api')>()
  return { ...actual, api: vi.fn() }
})

import { api } from '../slices/api'
import { createSessionSlice, type SessionSlice } from '../slices/sessionSlice'

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

/** Slice defaults first, then overrides — same ordering trap as agentSlice.test.ts. */
function setup(overrides: Partial<AppState> = {}): { get: GetState; set: SetState; slice: SessionSlice } {
  const { get, set } = createStore()
  const slice = createSessionSlice(set, get)
  set(slice)
  // retryExchange reads sessionAgents/sessionReadOnly via harnessPromptFields; selectSession
  // (invoked by branchFromMessage) calls into the subagent slice, which isn't under test here.
  set({ sessionAgents: {}, sessionReadOnly: {}, clearSubagents: vi.fn() } as Partial<AppState>)
  set(overrides)
  return { get, set, slice }
}

function makeSession(id: string): Session {
  return {
    id,
    directory: '/proj',
    projectID: 'p1',
    title: 'Untitled',
    time: { created: 1, updated: 1 }
  } as unknown as Session
}

function makeUserMessage(id: string, sessionID: string, text: string): MessageWithParts {
  const info = { id, sessionID, role: 'user', time: { created: 1 } } as unknown as Message
  const parts = [{ id: `${id}-p1`, messageID: id, sessionID, type: 'text', text } as unknown as Part]
  return { info, parts }
}

function makeAssistantMessage(id: string, sessionID: string): MessageWithParts {
  const info = {
    id,
    sessionID,
    role: 'assistant',
    time: { created: 2, completed: 3 },
    modelID: 'gpt',
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    cost: 0
  } as unknown as Message
  return { info, parts: [] }
}

describe('sessionSlice.branchFromMessage', () => {
  beforeEach(() => {
    mockApi.mockReset()
  })

  it('bails without a directory or an active session', async () => {
    const forkSession = vi.fn()
    mockApi.mockReturnValue({ forkSession } as unknown as OpencodeApi)
    const { slice } = setup({ directory: null, activeSessionID: 's1' })
    await slice.branchFromMessage('m1')
    const { slice: slice2 } = setup({ directory: '/proj', activeSessionID: null })
    await slice2.branchFromMessage('m1')
    expect(forkSession).not.toHaveBeenCalled()
  })

  it('forks a new session, upserts it, and switches to it — leaving the source session in place', async () => {
    const forked = makeSession('s2')
    const forkSession = vi.fn().mockResolvedValue(forked)
    const messagesFn = vi.fn().mockResolvedValue([])
    const todosFn = vi.fn().mockResolvedValue([])
    mockApi.mockReturnValue({
      forkSession,
      messages: messagesFn,
      sessions: { todos: todosFn }
    } as unknown as OpencodeApi)

    const original = makeSession('s1')
    const { get, slice } = setup({
      directory: '/proj',
      activeSessionID: 's1',
      sessions: [original],
      messages: [makeUserMessage('m1', 's1', 'hello')]
    })

    await slice.branchFromMessage('m1')

    expect(forkSession).toHaveBeenCalledWith({ directory: '/proj', sessionID: 's1', messageID: 'm1' })
    // Source session is untouched; the forked session is upserted alongside it.
    expect(get().sessions.map((s) => s.id).sort()).toEqual(['s1', 's2'])
    expect(get().sessions.find((s) => s.id === 's1')).toEqual(original)
    // selectSession switched the active session to the new branch.
    expect(get().activeSessionID).toBe('s2')
  })

  it('sets an error and does not switch sessions when the fork call fails', async () => {
    const forkSession = vi.fn().mockRejectedValue(new Error('server exploded'))
    mockApi.mockReturnValue({ forkSession } as unknown as OpencodeApi)
    const { get, slice } = setup({
      directory: '/proj',
      activeSessionID: 's1',
      sessions: [makeSession('s1')],
      messages: [makeUserMessage('m1', 's1', 'hello')]
    })

    await slice.branchFromMessage('m1')

    expect(get().activeSessionID).toBe('s1')
    expect(get().error).toBe('server exploded')
  })
})

describe('sessionSlice.retryExchange override', () => {
  beforeEach(() => {
    mockApi.mockReset()
  })

  it('uses the store providerID/modelID when no override is given (existing behaviour)', async () => {
    const prompt = vi.fn().mockResolvedValue(undefined)
    mockApi.mockReturnValue({ prompt } as unknown as OpencodeApi)
    const { slice } = setup({
      directory: '/proj',
      activeSessionID: 's1',
      providerID: 'anthropic',
      modelID: 'claude',
      messages: [makeUserMessage('u1', 's1', 'hi'), makeAssistantMessage('a1', 's1')]
    })

    await slice.retryExchange('a1')

    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({ providerID: 'anthropic', modelID: 'claude', text: 'hi' })
    )
  })

  it('uses the one-shot override providerID/modelID instead of the store selection', async () => {
    const prompt = vi.fn().mockResolvedValue(undefined)
    mockApi.mockReturnValue({ prompt } as unknown as OpencodeApi)
    const { get, slice } = setup({
      directory: '/proj',
      activeSessionID: 's1',
      providerID: 'anthropic',
      modelID: 'claude',
      pinnedProviderID: 'anthropic',
      pinnedModelID: 'claude',
      routingMode: 'locked',
      messages: [makeUserMessage('u1', 's1', 'hi'), makeAssistantMessage('a1', 's1')]
    })

    await slice.retryExchange('a1', { providerID: 'google', modelID: 'gemini' })

    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({ providerID: 'google', modelID: 'gemini', text: 'hi' })
    )
    // The override must be one-shot: the store's own selection and pins are untouched.
    expect(get().providerID).toBe('anthropic')
    expect(get().modelID).toBe('claude')
    expect(get().pinnedProviderID).toBe('anthropic')
    expect(get().pinnedModelID).toBe('claude')
    expect(get().routingMode).toBe('locked')
  })
})
