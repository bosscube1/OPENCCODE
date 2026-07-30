import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { OpencodeApi } from '../slices/api'
import type { AppState, SetState, GetState } from '../slices/types'
import type { Message, MessageWithParts, OcEvent, Part, Session } from '../types'

vi.mock('../slices/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../slices/api')>()
  return { ...actual, api: vi.fn() }
})

import { api } from '../slices/api'
import { applySubagentEvent, createSubagentSlice, type SubagentSlice } from '../slices/subagentSlice'

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

/** Slice defaults first, then overrides — same ordering trap as terminalSlice.test.ts. */
function setup(overrides: Partial<AppState> = {}): { get: GetState; set: SetState; slice: SubagentSlice } {
  const { get, set } = createStore()
  const slice = createSubagentSlice(set, get)
  set(slice)
  set(overrides)
  return { get, set, slice }
}

function makeSession(id: string, parentID?: string): Session {
  return {
    id,
    parentID,
    directory: '/proj',
    projectID: 'p1',
    title: `${id} (@scout subagent)`,
    time: { created: 1, updated: 1 }
  } as unknown as Session
}

function makeMessage(id: string, sessionID: string, created = 1): Message {
  return {
    id,
    sessionID,
    role: 'assistant',
    time: { created, completed: created }
  } as unknown as Message
}

function makeTextPart(id: string, messageID: string, sessionID: string, text: string): Part {
  return { id, messageID, sessionID, type: 'text', text } as unknown as Part
}

/** The standard state: parent session active, one child and one unrelated session known. */
function routedState(): Partial<AppState> {
  return {
    directory: '/proj',
    activeSessionID: 'parent',
    sessions: [makeSession('parent'), makeSession('child', 'parent'), makeSession('unrelated')]
  }
}

describe('applySubagentEvent', () => {
  beforeEach(() => {
    mockApi.mockReset()
  })

  it('routes a child message.updated into subagentMessages and consumes it', () => {
    const { get, set } = setup(routedState())
    const event: OcEvent = {
      type: 'message.updated',
      properties: { info: makeMessage('m1', 'child') }
    }

    expect(applySubagentEvent(event, set, get)).toBe(true)
    expect(get().subagentMessages.child?.map((m) => m.info.id)).toEqual(['m1'])
  })

  it('accumulates streamed part snapshots (delta field present) into the child transcript', () => {
    const { get, set } = setup(routedState())
    applySubagentEvent(
      { type: 'message.updated', properties: { info: makeMessage('m1', 'child') } },
      set,
      get
    )

    // Two streaming updates for the same part: each carries the FULL text so far plus a
    // delta. The upsert must leave the latest snapshot, not duplicated or stale text.
    const first: OcEvent = {
      type: 'message.part.updated',
      properties: { part: makeTextPart('p1', 'm1', 'child', 'Hello'), delta: 'Hello' }
    }
    const second: OcEvent = {
      type: 'message.part.updated',
      properties: { part: makeTextPart('p1', 'm1', 'child', 'Hello world'), delta: ' world' }
    }
    expect(applySubagentEvent(first, set, get)).toBe(true)
    expect(applySubagentEvent(second, set, get)).toBe(true)

    const messages = get().subagentMessages.child
    expect(messages).toHaveLength(1)
    expect(messages?.[0]?.parts).toHaveLength(1)
    expect((messages?.[0]?.parts[0] as { text: string }).text).toBe('Hello world')
  })

  it('drops parts whose message is not known yet (same rule as the main reducer)', () => {
    const { get, set } = setup(routedState())
    const event: OcEvent = {
      type: 'message.part.updated',
      properties: { part: makeTextPart('p1', 'm-missing', 'child', 'orphan') }
    }
    expect(applySubagentEvent(event, set, get)).toBe(true)
    expect(get().subagentMessages.child).toBeUndefined()
  })

  it('handles message.removed and message.part.removed for a child', () => {
    const { get, set } = setup({
      ...routedState(),
      subagentMessages: {
        child: [
          { info: makeMessage('m1', 'child'), parts: [makeTextPart('p1', 'm1', 'child', 'x')] },
          { info: makeMessage('m2', 'child', 2), parts: [] }
        ]
      }
    })

    expect(
      applySubagentEvent(
        { type: 'message.part.removed', properties: { sessionID: 'child', messageID: 'm1', partID: 'p1' } },
        set,
        get
      )
    ).toBe(true)
    expect(get().subagentMessages.child?.[0]?.parts).toHaveLength(0)

    expect(
      applySubagentEvent(
        { type: 'message.removed', properties: { sessionID: 'child', messageID: 'm2' } },
        set,
        get
      )
    ).toBe(true)
    expect(get().subagentMessages.child?.map((m) => m.info.id)).toEqual(['m1'])
  })

  it('leaves events for the ACTIVE session completely untouched', () => {
    const { get, set } = setup(routedState())
    const cases: OcEvent[] = [
      { type: 'message.updated', properties: { info: makeMessage('m1', 'parent') } },
      { type: 'message.part.updated', properties: { part: makeTextPart('p1', 'm1', 'parent', 'hi') } },
      { type: 'session.status', properties: { sessionID: 'parent', status: { type: 'busy' } } },
      { type: 'session.idle', properties: { sessionID: 'parent' } },
      { type: 'session.error', properties: { sessionID: 'parent', error: { name: 'Boom' } } }
    ]
    for (const event of cases) {
      expect(applySubagentEvent(event, set, get)).toBe(false)
    }
    expect(get().subagentMessages).toEqual({})
    expect(get().subagentBusy).toEqual({})
    expect(get().subagentError).toEqual({})
  })

  it('ignores events for unrelated (non-descendant) sessions', () => {
    const { get, set } = setup(routedState())
    const cases: OcEvent[] = [
      { type: 'message.updated', properties: { info: makeMessage('m1', 'unrelated') } },
      { type: 'session.status', properties: { sessionID: 'unrelated', status: { type: 'busy' } } },
      { type: 'session.idle', properties: { sessionID: 'unrelated' } }
    ]
    for (const event of cases) {
      expect(applySubagentEvent(event, set, get)).toBe(false)
    }
    expect(get().subagentMessages).toEqual({})
    expect(get().subagentBusy).toEqual({})
  })

  it('ignores descendant traffic when no session is active', () => {
    const { get, set } = setup({ ...routedState(), activeSessionID: null })
    expect(
      applySubagentEvent(
        { type: 'message.updated', properties: { info: makeMessage('m1', 'child') } },
        set,
        get
      )
    ).toBe(false)
    expect(get().subagentMessages).toEqual({})
  })

  it('routes grandchild (transitive descendant) traffic too', () => {
    const { get, set } = setup({
      ...routedState(),
      sessions: [...(routedState().sessions ?? []), makeSession('grandchild', 'child')]
    })
    expect(
      applySubagentEvent(
        { type: 'message.updated', properties: { info: makeMessage('m1', 'grandchild') } },
        set,
        get
      )
    ).toBe(true)
    expect(get().subagentMessages.grandchild?.map((m) => m.info.id)).toEqual(['m1'])
  })

  it('toggles busy on session.status and clears it on session.idle', () => {
    const { get, set } = setup(routedState())
    expect(
      applySubagentEvent(
        { type: 'session.status', properties: { sessionID: 'child', status: { type: 'busy' } } },
        set,
        get
      )
    ).toBe(true)
    expect(get().subagentBusy.child).toBe(true)

    applySubagentEvent(
      { type: 'session.status', properties: { sessionID: 'child', status: { type: 'retry' } } },
      set,
      get
    )
    expect(get().subagentBusy.child).toBe(true)

    applySubagentEvent({ type: 'session.idle', properties: { sessionID: 'child' } }, set, get)
    expect(get().subagentBusy.child).toBe(false)
  })

  it('records session.error detail and clears busy, except aborts', () => {
    const { get, set } = setup({ ...routedState(), subagentBusy: { child: true } })

    applySubagentEvent(
      {
        type: 'session.error',
        properties: { sessionID: 'child', error: { name: 'ProviderError', data: { message: 'rate limited' } } }
      },
      set,
      get
    )
    expect(get().subagentBusy.child).toBe(false)
    expect(get().subagentError.child).toBe('rate limited')

    // A user-initiated stop surfaces as MessageAbortedError — busy clears, no error text.
    applySubagentEvent(
      {
        type: 'session.error',
        properties: { sessionID: 'child', error: { name: 'MessageAbortedError', data: { message: 'aborted' } } }
      },
      set,
      get
    )
    expect(get().subagentBusy.child).toBe(false)
    expect(get().subagentError.child).toBe('rate limited') // unchanged
  })

  it('auto-adds a tab (without stealing focus) when a child session is created', () => {
    const { get, set } = setup(routedState())
    const event: OcEvent = {
      type: 'session.created',
      properties: { info: makeSession('child2', 'parent') }
    }

    // NOT consumed — the main reducer must still fold it into state.sessions.
    expect(applySubagentEvent(event, set, get)).toBe(false)
    expect(get().subagentTabs).toEqual(['child2'])
    expect(get().activeSubagentTab).toBeNull()
    expect(get().subagentBusy.child2).toBe(true)
  })

  it('does not auto-add a tab for sessions without the active parent', () => {
    const { get, set } = setup(routedState())
    expect(
      applySubagentEvent(
        { type: 'session.created', properties: { info: makeSession('fresh') } },
        set,
        get
      )
    ).toBe(false)
    expect(
      applySubagentEvent(
        { type: 'session.created', properties: { info: makeSession('grandchild', 'child') } },
        set,
        get
      )
    ).toBe(false)
    expect(get().subagentTabs).toEqual([])
  })

  it('drops the tab when a child session is deleted, but lets the event through', () => {
    const { get, set } = setup({
      ...routedState(),
      subagentTabs: ['child'],
      activeSubagentTab: 'child',
      subagentMessages: { child: [] },
      subagentBusy: { child: false },
      subagentError: { child: 'boom' }
    })

    expect(
      applySubagentEvent(
        { type: 'session.deleted', properties: { info: { id: 'child' } } },
        set,
        get
      )
    ).toBe(false)
    expect(get().subagentTabs).toEqual([])
    expect(get().activeSubagentTab).toBeNull()
    expect(get().subagentMessages).toEqual({})
    expect(get().subagentBusy).toEqual({})
    expect(get().subagentError).toEqual({})
  })

  it('clears all subagent state when the ACTIVE session is deleted', () => {
    const { get, set } = setup({
      ...routedState(),
      subagentTabs: ['child'],
      activeSubagentTab: 'child',
      subagentMessages: { child: [] }
    })
    expect(
      applySubagentEvent(
        { type: 'session.deleted', properties: { info: { id: 'parent' } } },
        set,
        get
      )
    ).toBe(false)
    expect(get().subagentTabs).toEqual([])
    expect(get().activeSubagentTab).toBeNull()
    expect(get().subagentMessages).toEqual({})
  })

  it('ignores unrelated event types', () => {
    const { get, set } = setup(routedState())
    expect(
      applySubagentEvent({ type: 'permission.updated', properties: { sessionID: 'child' } }, set, get)
    ).toBe(false)
    expect(applySubagentEvent({ type: 'todo.updated', properties: { sessionID: 'child' } }, set, get)).toBe(false)
    expect(applySubagentEvent({ type: 'server.connected', properties: {} }, set, get)).toBe(false)
  })
})

describe('subagentSlice actions', () => {
  beforeEach(() => {
    mockApi.mockReset()
  })

  function fakeApi(overrides: Partial<OpencodeApi>): OpencodeApi {
    return overrides as unknown as OpencodeApi
  }

  describe('openSubagentTab', () => {
    it('adds the tab, activates it, and backfills history once', async () => {
      const messagesFn = vi.fn(async (): Promise<MessageWithParts[]> => [
        { info: makeMessage('m1', 'child'), parts: [makeTextPart('p1', 'm1', 'child', 'done')] }
      ])
      mockApi.mockReturnValue(fakeApi({ messages: messagesFn }))

      const { get, slice } = setup(routedState())
      await slice.openSubagentTab('child')

      expect(get().subagentTabs).toEqual(['child'])
      expect(get().activeSubagentTab).toBe('child')
      expect(messagesFn).toHaveBeenCalledWith('/proj', 'child')
      expect(get().subagentMessages.child?.map((m) => m.info.id)).toEqual(['m1'])
      // Completed assistant message -> not busy.
      expect(get().subagentBusy.child).toBe(false)

      await slice.openSubagentTab('child')
      expect(messagesFn).toHaveBeenCalledTimes(1) // already loaded — no refetch
    })

    it('does not clobber a busy flag a live event already set', async () => {
      mockApi.mockReturnValue(fakeApi({ messages: vi.fn(async () => []) }))
      const { get, slice } = setup({ ...routedState(), subagentBusy: { child: true } })
      await slice.openSubagentTab('child')
      expect(get().subagentBusy.child).toBe(true)
    })

    it('merges events that streamed in while the backfill was in flight', async () => {
      let resolveFetch: (messages: MessageWithParts[]) => void = () => {}
      const messagesFn = vi.fn(
        () => new Promise<MessageWithParts[]>((resolve) => {
          resolveFetch = resolve
        })
      )
      mockApi.mockReturnValue(fakeApi({ messages: messagesFn }))

      const { get, set, slice } = setup(routedState())
      const opening = slice.openSubagentTab('child')

      // Live traffic lands before the fetch resolves.
      applySubagentEvent(
        { type: 'message.updated', properties: { info: makeMessage('m2', 'child', 2) } },
        set,
        get
      )
      resolveFetch([{ info: makeMessage('m1', 'child'), parts: [] }])
      await opening

      expect(get().subagentMessages.child?.map((m) => m.info.id)).toEqual(['m1', 'm2'])
    })

    it('discards a backfill that resolves after the tab was closed', async () => {
      let resolveFetch: (messages: MessageWithParts[]) => void = () => {}
      mockApi.mockReturnValue(
        fakeApi({
          messages: vi.fn(() => new Promise<MessageWithParts[]>((resolve) => {
            resolveFetch = resolve
          }))
        })
      )

      const { get, slice } = setup(routedState())
      const opening = slice.openSubagentTab('child')
      slice.closeSubagentTab('child')
      resolveFetch([{ info: makeMessage('m1', 'child'), parts: [] }])
      await opening

      expect(get().subagentTabs).toEqual([])
      expect(get().subagentMessages.child).toBeUndefined()
    })

    it('records a backfill failure as the tab error', async () => {
      mockApi.mockReturnValue(
        fakeApi({
          messages: vi.fn(async () => {
            throw new Error('history unavailable')
          })
        })
      )
      const { get, slice } = setup(routedState())
      await slice.openSubagentTab('child')
      expect(get().subagentTabs).toEqual(['child'])
      expect(get().subagentError.child).toBe('history unavailable')
    })
  })

  describe('closeSubagentTab', () => {
    it('drops the tab and cached records, falling back to main when it was active', () => {
      const { get, slice } = setup({
        ...routedState(),
        subagentTabs: ['child', 'child2'],
        activeSubagentTab: 'child',
        subagentMessages: { child: [], child2: [] },
        subagentBusy: { child: true },
        subagentError: { child: 'boom' }
      })

      slice.closeSubagentTab('child')
      expect(get().subagentTabs).toEqual(['child2'])
      expect(get().activeSubagentTab).toBeNull()
      expect(get().subagentMessages.child).toBeUndefined()
      expect(get().subagentMessages.child2).toEqual([])
      expect(get().subagentBusy.child).toBeUndefined()
      expect(get().subagentError.child).toBeUndefined()
    })

    it('keeps the active tab when closing a different one', () => {
      const { get, slice } = setup({
        ...routedState(),
        subagentTabs: ['child', 'child2'],
        activeSubagentTab: 'child2'
      })
      slice.closeSubagentTab('child')
      expect(get().activeSubagentTab).toBe('child2')
    })

    it('ignores ids that are not open tabs', () => {
      const { get, slice } = setup({ ...routedState(), subagentTabs: ['child'], activeSubagentTab: 'child' })
      slice.closeSubagentTab('nope')
      expect(get().subagentTabs).toEqual(['child'])
      expect(get().activeSubagentTab).toBe('child')
    })
  })

  describe('setActiveSubagentTab', () => {
    it('switches between open tabs and back to main (null)', () => {
      const { get, slice } = setup({ ...routedState(), subagentTabs: ['child'] })
      slice.setActiveSubagentTab('child')
      expect(get().activeSubagentTab).toBe('child')
      slice.setActiveSubagentTab(null)
      expect(get().activeSubagentTab).toBeNull()
    })

    it('ignores ids that are not open tabs', () => {
      const { get, slice } = setup({ ...routedState(), subagentTabs: ['child'], activeSubagentTab: null })
      slice.setActiveSubagentTab('stale')
      expect(get().activeSubagentTab).toBeNull()
    })
  })

  describe('stopSubagent', () => {
    it('aborts the child session through the bridge', async () => {
      const abortFn = vi.fn(async () => {})
      mockApi.mockReturnValue(fakeApi({ abort: abortFn }))
      const { slice } = setup(routedState())
      await slice.stopSubagent('child')
      expect(abortFn).toHaveBeenCalledWith('/proj', 'child')
    })

    it('records a failed abort as the tab error', async () => {
      mockApi.mockReturnValue(
        fakeApi({
          abort: vi.fn(async () => {
            throw new Error('abort failed')
          })
        })
      )
      const { get, slice } = setup(routedState())
      await slice.stopSubagent('child')
      expect(get().subagentError.child).toBe('abort failed')
    })
  })

  describe('clearSubagents', () => {
    it('resets every record', () => {
      const { get, slice } = setup({
        ...routedState(),
        subagentTabs: ['child'],
        activeSubagentTab: 'child',
        subagentMessages: { child: [] },
        subagentBusy: { child: true },
        subagentError: { child: 'boom' }
      })
      slice.clearSubagents()
      expect(get().subagentTabs).toEqual([])
      expect(get().activeSubagentTab).toBeNull()
      expect(get().subagentMessages).toEqual({})
      expect(get().subagentBusy).toEqual({})
      expect(get().subagentError).toEqual({})
    })
  })
})
