import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Provider } from '@opencode-ai/sdk'
import type { AppState, SetState, GetState } from '../slices/types'
import type { OpencodeApi } from '../slices/api'
import type { CompareRun } from '../compare'
import type { Message, OcEvent, Part } from '../types'

vi.mock('../slices/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../slices/api')>()
  return { ...actual, api: vi.fn() }
})
vi.mock('../prefs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../prefs')>()
  return { ...actual, savePrefs: vi.fn() }
})

import { api } from '../slices/api'
import { savePrefs } from '../prefs'
import { createCompareSlice, applyCompareEvent, type CompareSlice } from '../slices/compareSlice'

const mockApi = vi.mocked(api)
const mockSavePrefs = vi.mocked(savePrefs)

function createStore(): { get: GetState; set: SetState } {
  let state = {} as AppState
  const set = ((partial: unknown) => {
    const patch =
      typeof partial === 'function' ? (partial as (s: AppState) => Partial<AppState>)(state) : partial
    state = { ...state, ...(patch as Partial<AppState>) }
  }) as SetState
  const get: GetState = () => state
  return { get, set }
}

const notices: string[] = []

/** Slice defaults first, then test overrides — the reverse order clobbers the overrides. */
function setup(overrides: Partial<AppState> = {}): {
  get: GetState
  set: SetState
  slice: CompareSlice
} {
  const { get, set } = createStore()
  const slice = createCompareSlice(set, get)
  set(slice)
  set({
    error: null,
    directory: '/project',
    sessions: [],
    messages: [],
    providers: [],
    linkedProviderIDs: [],
    addSystemNotice: (text: string) => {
      notices.push(text)
    },
    setModel: vi.fn(),
    selectSession: vi.fn(async () => {}),
    ...overrides
  } as Partial<AppState>)
  return { get, set, slice }
}

function provider(id: string, modelIDs: string[]): Provider {
  return {
    id,
    name: id,
    models: Object.fromEntries(modelIDs.map((m) => [m, { id: m, name: m }]))
  } as unknown as Provider
}

/** Two linked providers with one model each — the minimum a compare run will accept. */
function twoUsableTargets(): Partial<AppState> {
  return {
    compareTargets: ['openai/gpt-4', 'anthropic/claude'],
    providers: [provider('openai', ['gpt-4']), provider('anthropic', ['claude'])],
    linkedProviderIDs: ['openai', 'anthropic']
  } as Partial<AppState>
}

type CompareApi = {
  create: ReturnType<typeof vi.fn>
  prompt: ReturnType<typeof vi.fn>
  abort: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
  replyPermission: ReturnType<typeof vi.fn>
}

/** `sortSessions` dereferences `time.updated`, so a session fixture must carry it. */
function session(id: string, updated = 100): { id: string; title: string; time: { created: number; updated: number } } {
  return { id, title: 't', time: { created: updated, updated } }
}

function fakeApi(parts: Partial<CompareApi> = {}): { api: OpencodeApi; calls: CompareApi } {
  let n = 0
  const calls: CompareApi = {
    create: parts.create ?? vi.fn(async () => session(`sess-${++n}`)),
    prompt: parts.prompt ?? vi.fn(async () => undefined),
    abort: parts.abort ?? vi.fn(async () => undefined),
    remove: parts.remove ?? vi.fn(async () => undefined),
    replyPermission: parts.replyPermission ?? vi.fn(async () => undefined)
  }
  return {
    api: {
      sessions: { create: calls.create, remove: calls.remove },
      prompt: calls.prompt,
      abort: calls.abort,
      replyPermission: calls.replyPermission
    } as unknown as OpencodeApi,
    calls
  }
}

function run(overrides: Partial<CompareRun> = {}): CompareRun {
  return {
    id: 'cmp-1',
    prompt: 'compare this',
    startedAt: 100,
    columns: [
      {
        providerID: 'openai',
        modelID: 'gpt-4',
        sessionID: 'sess-1',
        messages: [],
        busy: true,
        error: null
      },
      {
        providerID: 'anthropic',
        modelID: 'claude',
        sessionID: 'sess-2',
        messages: [],
        busy: true,
        error: null
      }
    ],
    ...overrides
  }
}

function message(id: string, overrides: Partial<Message> = {}): Message {
  return { id, sessionID: 'sess-1', role: 'assistant', ...overrides } as unknown as Message
}

function part(id: string, messageID: string, overrides: Partial<Part> = {}): Part {
  return { id, messageID, sessionID: 'sess-1', type: 'text', text: 'hi', ...overrides } as unknown as Part
}

/** `applyCompareEvent` takes the functional setter only, so narrow the harness setter for it. */
function functionalSet(set: SetState): (fn: (state: AppState) => Partial<AppState>) => void {
  return (fn) => set(fn as never)
}

function apply(e: OcEvent, get: GetState, set: SetState): boolean {
  return applyCompareEvent(e, functionalSet(set), get)
}

describe('compareSlice', () => {
  beforeEach(() => {
    mockApi.mockReset()
    mockSavePrefs.mockReset()
    notices.length = 0
  })

  describe('initial state', () => {
    it('starts with no run and no targets', () => {
      const { get } = setup()
      expect(get().compare).toBeNull()
      expect(get().compareTargets).toEqual([])
    })
  })

  describe('setCompareTargets', () => {
    it('dedupes, caps at MAX_COMPARE_TARGETS, and persists', () => {
      const { get, slice } = setup({
        directory: '/project',
        providerID: 'openai',
        modelID: 'gpt-4',
        theme: 'dark',
        modelPool: [],
        routingMode: 'auto',
        showPaidModels: true
      } as Partial<AppState>)

      slice.setCompareTargets(['a/1', 'a/1', 'b/2', 'c/3', 'd/4', 'e/5'])

      expect(get().compareTargets).toEqual(['a/1', 'b/2', 'c/3', 'd/4'])
      expect(mockSavePrefs).toHaveBeenCalledWith(
        expect.objectContaining({ compareTargets: ['a/1', 'b/2', 'c/3', 'd/4'], theme: 'dark' })
      )
    })

    it('persists an empty selection so clearing survives a restart', () => {
      const { get, slice } = setup()
      slice.setCompareTargets([])
      expect(get().compareTargets).toEqual([])
      expect(mockSavePrefs).toHaveBeenCalledTimes(1)
    })
  })

  describe('sendToMany', () => {
    it('ignores a blank prompt without touching state', async () => {
      const { get, slice } = setup(twoUsableTargets())
      await slice.sendToMany('   ')
      expect(get().compare).toBeNull()
      expect(mockApi).not.toHaveBeenCalled()
    })

    it('refuses without a project directory', async () => {
      const { get, slice } = setup({ ...twoUsableTargets(), directory: '' })
      await slice.sendToMany('hello')
      expect(get().error).toBe('Pick a project folder first.')
      expect(get().compare).toBeNull()
    })

    it('refuses with fewer than two targets selected', async () => {
      const { get, slice } = setup({ compareTargets: ['openai/gpt-4'] } as Partial<AppState>)
      await slice.sendToMany('hello')
      expect(get().error).toBe('Pick at least two models to compare.')
    })

    it('refuses to start a second run while one is still busy', async () => {
      const { get, slice } = setup({ ...twoUsableTargets(), compare: run() })
      await slice.sendToMany('hello')
      expect(get().error).toContain('A comparison is still running')
      expect(mockApi).not.toHaveBeenCalled()
    })

    it('allows a new run once every column has gone idle', async () => {
      const idle = run({
        columns: run().columns.map((c) => ({ ...c, busy: false }))
      })
      const { api: fake } = fakeApi()
      mockApi.mockReturnValue(fake)
      const { get, slice } = setup({ ...twoUsableTargets(), compare: idle })

      await slice.sendToMany('hello')

      expect(get().compare?.id).not.toBe('cmp-1')
      expect(get().error).toBeNull()
    })

    it('reports which models were dropped for want of a key', async () => {
      const { get, slice } = setup({
        compareTargets: ['openai/gpt-4', 'anthropic/claude'],
        providers: [provider('openai', ['gpt-4']), provider('anthropic', ['claude'])],
        linkedProviderIDs: ['openai']
      } as Partial<AppState>)

      await slice.sendToMany('hello')

      expect(get().error).toContain('no API key or model for: anthropic/claude')
      expect(get().compare).toBeNull()
    })

    it('falls back to a generic message when nothing was skipped either', async () => {
      // Unparseable keys are dropped silently rather than being listed as "no API key",
      // which would be a misleading explanation.
      const { get, slice } = setup({
        compareTargets: ['garbage', 'alsogarbage'],
        providers: [],
        linkedProviderIDs: []
      } as Partial<AppState>)

      await slice.sendToMany('hello')

      expect(get().error).toBe('Not enough usable models to compare.')
    })

    it('drops unusable targets but runs when two survive, and says so', async () => {
      const { api: fake, calls } = fakeApi()
      mockApi.mockReturnValue(fake)
      const { get, slice } = setup({
        compareTargets: ['openai/gpt-4', 'anthropic/claude', 'ghost/model'],
        providers: [provider('openai', ['gpt-4']), provider('anthropic', ['claude'])],
        linkedProviderIDs: ['openai', 'anthropic']
      } as Partial<AppState>)

      await slice.sendToMany('hello')

      expect(get().compare?.columns).toHaveLength(2)
      expect(notices[0]).toContain('ghost/model')
      expect(calls.create).toHaveBeenCalledTimes(2)
    })

    it('treats a provider that advertises no models as unusable', async () => {
      const { get, slice } = setup({
        compareTargets: ['openai/gpt-4', 'anthropic/claude'],
        providers: [{ id: 'openai', name: 'openai' } as unknown as Provider, provider('anthropic', ['claude'])],
        linkedProviderIDs: ['openai', 'anthropic']
      } as Partial<AppState>)

      await slice.sendToMany('hello')

      expect(get().error).toContain('openai/gpt-4')
      expect(get().compare).toBeNull()
    })

    it('forwards attachment parts to every column', async () => {
      const { api: fake, calls } = fakeApi()
      mockApi.mockReturnValue(fake)
      const { slice } = setup(twoUsableTargets())
      const parts = [{ type: 'file' as const, mime: 'image/png', filename: 'a.png', url: 'data:,' }]

      await slice.sendToMany('look at this', parts)

      expect(calls.prompt).toHaveBeenCalledTimes(2)
      for (const [args] of calls.prompt.mock.calls) expect(args.parts).toEqual(parts)
    })

    it('sends every column read-only, because all columns share one working tree', async () => {
      const { api: fake, calls } = fakeApi()
      mockApi.mockReturnValue(fake)
      const { slice } = setup(twoUsableTargets())

      await slice.sendToMany('  hello  ')

      expect(calls.prompt).toHaveBeenCalledTimes(2)
      for (const [args] of calls.prompt.mock.calls) {
        // Without this, concurrent columns would race on writes and corrupt the repo.
        expect(args.tools).toBeDefined()
        expect(Object.values(args.tools as Record<string, boolean>).every((v) => v === false)).toBe(true)
        expect(args.text).toBe('hello')
      }
    })

    it('registers each column session so the sidebar still lists it', async () => {
      const { api: fake } = fakeApi()
      mockApi.mockReturnValue(fake)
      const { get, slice } = setup(twoUsableTargets())

      await slice.sendToMany('hello')

      expect(get().sessions.map((s) => s.id).sort()).toEqual(['sess-1', 'sess-2'])
      expect(get().compare?.columns.map((c) => c.sessionID).sort()).toEqual(['sess-1', 'sess-2'])
    })

    it('keeps the other columns running when one fails', async () => {
      const prompt = vi
        .fn<(args: { modelID: string }) => Promise<void>>()
        .mockImplementationOnce(async () => {
          throw new Error('model overloaded')
        })
        .mockResolvedValue(undefined)
      const { api: fake } = fakeApi({ prompt })
      mockApi.mockReturnValue(fake)
      const { get, slice } = setup(twoUsableTargets())

      await slice.sendToMany('hello')

      const failed = get().compare?.columns.filter((c) => c.error !== null) ?? []
      expect(failed).toHaveLength(1)
      expect(failed[0].error).toContain('model overloaded')
      expect(failed[0].busy).toBe(false)
      expect(get().compare?.columns.filter((c) => c.error === null)).toHaveLength(1)
    })

    it('discards a late failure that belongs to a superseded run', async () => {
      // Two runs cannot coexist; writing a stale column error into the current run would
      // mark a healthy column dead.
      const { get, set, slice } = setup(twoUsableTargets())
      const { api: fake } = fakeApi({
        prompt: vi.fn(async () => {
          set({ compare: run({ id: 'cmp-newer' }) })
          throw new Error('too late')
        })
      })
      mockApi.mockReturnValue(fake)

      await slice.sendToMany('hello')

      expect(get().compare?.id).toBe('cmp-newer')
      expect(get().compare?.columns.every((c) => c.error === null)).toBe(true)
    })

    it('discards a session created after the run was superseded', async () => {
      const { get, set, slice } = setup(twoUsableTargets())
      const { api: fake, calls } = fakeApi({
        create: vi.fn(async () => {
          set({ compare: run({ id: 'cmp-newer' }) })
          return session('sess-late')
        })
      })
      mockApi.mockReturnValue(fake)

      await slice.sendToMany('hello')

      expect(get().compare?.id).toBe('cmp-newer')
      expect(get().sessions).toHaveLength(0)
      expect(calls.prompt).not.toHaveBeenCalled()
    })
  })

  describe('abortCompare', () => {
    it('does nothing without a directory or a run', async () => {
      const { slice } = setup({ compare: null })
      await slice.abortCompare()
      expect(mockApi).not.toHaveBeenCalled()

      const noDir = setup({ directory: '', compare: run() })
      await noDir.slice.abortCompare()
      expect(mockApi).not.toHaveBeenCalled()
    })

    it('aborts only the busy columns that have a session', async () => {
      const { api: fake, calls } = fakeApi()
      mockApi.mockReturnValue(fake)
      const mixed = run({
        columns: [
          { ...run().columns[0], busy: true },
          { ...run().columns[1], busy: false },
          { ...run().columns[0], sessionID: null, busy: true }
        ]
      })
      const { get, slice } = setup({ compare: mixed })

      await slice.abortCompare()

      expect(calls.abort).toHaveBeenCalledTimes(1)
      expect(calls.abort).toHaveBeenCalledWith('/project', 'sess-1')
      expect(get().compare?.columns[0].busy).toBe(false)
    })

    it('still marks the column idle when the abort call fails', async () => {
      const { api: fake } = fakeApi({
        abort: vi.fn(async () => {
          throw new Error('already gone')
        })
      })
      mockApi.mockReturnValue(fake)
      const { get, slice } = setup({ compare: run() })

      await slice.abortCompare()

      // A stuck-busy column would block the next comparison entirely.
      expect(get().compare?.columns.every((c) => !c.busy)).toBe(true)
    })
  })

  describe('promoteCompareColumn', () => {
    it('adopts the column session, pins its model, and clears the run', async () => {
      const setModel = vi.fn()
      const selectSession = vi.fn(async () => {})
      const { get, slice } = setup({ compare: run(), setModel, selectSession } as Partial<AppState>)

      await slice.promoteCompareColumn(1)

      expect(get().compare).toBeNull()
      expect(setModel).toHaveBeenCalledWith('anthropic', 'claude')
      expect(selectSession).toHaveBeenCalledWith('sess-2')
    })

    it('ignores an out-of-range index and a column with no session', async () => {
      const setModel = vi.fn()
      const noSession = run({ columns: [{ ...run().columns[0], sessionID: null }] })
      const { get, slice } = setup({ compare: noSession, setModel } as Partial<AppState>)

      await slice.promoteCompareColumn(9)
      await slice.promoteCompareColumn(0)

      expect(get().compare).not.toBeNull()
      expect(setModel).not.toHaveBeenCalled()
    })

    it('does nothing when there is no run at all', async () => {
      const setModel = vi.fn()
      const { slice } = setup({ compare: null, setModel } as Partial<AppState>)
      await slice.promoteCompareColumn(0)
      expect(setModel).not.toHaveBeenCalled()
    })
  })

  describe('discardCompare', () => {
    it('does nothing when there is no run', async () => {
      const { slice } = setup({ compare: null })
      await slice.discardCompare()
      expect(mockApi).not.toHaveBeenCalled()
    })

    it('clears the run and deletes every column session', async () => {
      const { api: fake, calls } = fakeApi()
      mockApi.mockReturnValue(fake)
      const { get, slice } = setup({
        compare: run(),
        sessions: [session('sess-1'), session('sess-2'), session('keep')]
      } as Partial<AppState>)

      await slice.discardCompare()

      expect(get().compare).toBeNull()
      expect(calls.remove).toHaveBeenCalledTimes(2)
      expect(get().sessions.map((s) => s.id)).toEqual(['keep'])
    })

    it('clears the run without deleting anything when there is no directory', async () => {
      const { api: fake, calls } = fakeApi()
      mockApi.mockReturnValue(fake)
      const { get, slice } = setup({ compare: run(), directory: '' })

      await slice.discardCompare()

      expect(get().compare).toBeNull()
      expect(calls.remove).not.toHaveBeenCalled()
    })

    it('skips columns with no session and keeps a session that refuses to delete', async () => {
      const remove = vi
        .fn<(dir: string, id: string) => Promise<void>>()
        .mockRejectedValueOnce(new Error('locked'))
        .mockResolvedValue(undefined)
      const { api: fake } = fakeApi({ remove })
      mockApi.mockReturnValue(fake)
      const withNull = run({
        columns: [run().columns[0], { ...run().columns[1], sessionID: null }]
      })
      const { get, slice } = setup({
        compare: withNull,
        sessions: [session('sess-1')]
      } as Partial<AppState>)

      await slice.discardCompare()

      expect(remove).toHaveBeenCalledTimes(1)
      // Not worth failing the discard over — the stale session stays listed.
      expect(get().sessions.map((s) => s.id)).toEqual(['sess-1'])
    })
  })

  describe('clearCompare', () => {
    it('drops the run without touching the sessions', async () => {
      const { get, slice } = setup({ compare: run(), sessions: [session('sess-1')] } as Partial<AppState>)
      slice.clearCompare()
      expect(get().compare).toBeNull()
      expect(get().sessions).toHaveLength(1)
    })
  })
})

describe('applyCompareEvent', () => {
  beforeEach(() => {
    mockApi.mockReset()
    notices.length = 0
  })

  it('ignores everything when no comparison is running', () => {
    const { get, set } = setup({ compare: null })
    expect(apply({ type: 'session.idle', properties: { sessionID: 'sess-1' } }, get, set)).toBe(false)
  })

  it('leaves session lifecycle events for the main reducer', () => {
    // Compare columns are real sessions; consuming these would hide them from the sidebar.
    const { get, set } = setup({ compare: run() })
    for (const type of ['session.created', 'session.updated', 'session.deleted']) {
      expect(apply({ type, properties: { sessionID: 'sess-1' } }, get, set)).toBe(false)
    }
  })

  it('ignores an event whose session is not a column', () => {
    const { get, set } = setup({ compare: run() })
    expect(apply({ type: 'session.idle', properties: { sessionID: 'other' } }, get, set)).toBe(false)
  })

  it('returns false for an unrecognised event type on a column session', () => {
    const { get, set } = setup({ compare: run() })
    expect(apply({ type: 'file.edited', properties: { sessionID: 'sess-1' } }, get, set)).toBe(false)
  })

  it('tolerates an event with null properties', () => {
    const { get, set } = setup({ compare: run() })
    expect(apply({ type: 'session.idle', properties: null }, get, set)).toBe(false)
  })

  it('writes nothing if the run is torn down between the read and the write', () => {
    // Every writer re-checks `state.compare` inside the updater. `clearCompare` can land
    // between `applyCompareEvent` reading the run and its `set` callback executing, and a
    // write then would resurrect a discarded run.
    const { get } = setup({ compare: run() })
    const patches: Array<Partial<AppState>> = []
    const racingSet = (fn: (state: AppState) => Partial<AppState>): void => {
      patches.push(fn({ ...get(), compare: null } as AppState))
    }

    const events: OcEvent[] = [
      { type: 'message.updated', properties: { info: message('m1') } },
      { type: 'message.part.updated', properties: { part: part('p1', 'm1') } },
      { type: 'message.removed', properties: { sessionID: 'sess-1', messageID: 'm1' } },
      { type: 'message.part.removed', properties: { sessionID: 'sess-1', messageID: 'm1', partID: 'p1' } },
      { type: 'session.status', properties: { sessionID: 'sess-1', status: { type: 'idle' } } },
      { type: 'session.idle', properties: { sessionID: 'sess-1' } },
      { type: 'session.error', properties: { sessionID: 'sess-1' } },
      { type: 'permission.updated', properties: { id: 'perm-1', sessionID: 'sess-1' } }
    ]
    const seeded = run()
    seeded.columns[0].messages = [{ info: message('m1'), parts: [part('p1', 'm1')] }]
    const { api: fake } = fakeApi()
    mockApi.mockReturnValue(fake)

    for (const e of events) {
      applyCompareEvent(e, racingSet, () => ({ ...get(), compare: seeded }) as AppState)
    }

    expect(patches).toHaveLength(events.length)
    for (const patch of patches) expect(patch).toEqual({})
  })

  describe('message events', () => {
    it('upserts a message into the right column', () => {
      const { get, set } = setup({ compare: run() })
      const consumed = apply(
        { type: 'message.updated', properties: { info: message('m1', { sessionID: 'sess-2' }) } },
        get,
        set
      )
      expect(consumed).toBe(true)
      expect(get().compare?.columns[1].messages).toHaveLength(1)
      expect(get().compare?.columns[0].messages).toHaveLength(0)
    })

    it('consumes but ignores a message with no usable id', () => {
      const { get, set } = setup({ compare: run() })
      const consumed = apply(
        { type: 'message.updated', properties: { info: { sessionID: 'sess-1' } } },
        get,
        set
      )
      // Consumed so the malformed event never reaches the attempt machine.
      expect(consumed).toBe(true)
      expect(get().compare?.columns[0].messages).toHaveLength(0)
    })

    it('adds a part to an existing message', () => {
      const seeded = run()
      seeded.columns[0].messages = [{ info: message('m1'), parts: [] }]
      const { get, set } = setup({ compare: seeded })

      expect(apply({ type: 'message.part.updated', properties: { part: part('p1', 'm1') } }, get, set)).toBe(true)
      expect(get().compare?.columns[0].messages[0].parts).toHaveLength(1)
    })

    it('consumes a part event for an unknown message without changing state', () => {
      const { get, set } = setup({ compare: run() })
      const before = get().compare
      expect(apply({ type: 'message.part.updated', properties: { part: part('p1', 'nope') } }, get, set)).toBe(true)
      expect(get().compare).toBe(before)
    })

    it('consumes but ignores a malformed part', () => {
      const { get, set } = setup({ compare: run() })
      expect(
        apply({ type: 'message.part.updated', properties: { part: { sessionID: 'sess-1' } } }, get, set)
      ).toBe(true)
    })

    it('removes a message', () => {
      const seeded = run()
      seeded.columns[0].messages = [{ info: message('m1'), parts: [] }]
      const { get, set } = setup({ compare: seeded })

      expect(apply({ type: 'message.removed', properties: { sessionID: 'sess-1', messageID: 'm1' } }, get, set)).toBe(true)
      expect(get().compare?.columns[0].messages).toHaveLength(0)
    })

    it('consumes a removal with no messageID, and one that matches nothing', () => {
      const { get, set } = setup({ compare: run() })
      const before = get().compare
      expect(apply({ type: 'message.removed', properties: { sessionID: 'sess-1' } }, get, set)).toBe(true)
      expect(apply({ type: 'message.removed', properties: { sessionID: 'sess-1', messageID: 'ghost' } }, get, set)).toBe(true)
      expect(get().compare).toBe(before)
    })

    it('removes a part', () => {
      const seeded = run()
      seeded.columns[0].messages = [{ info: message('m1'), parts: [part('p1', 'm1')] }]
      const { get, set } = setup({ compare: seeded })

      expect(
        apply(
          { type: 'message.part.removed', properties: { sessionID: 'sess-1', messageID: 'm1', partID: 'p1' } },
          get,
          set
        )
      ).toBe(true)
      expect(get().compare?.columns[0].messages[0].parts).toHaveLength(0)
    })

    it('consumes a part removal missing either id, and one that matches nothing', () => {
      const { get, set } = setup({ compare: run() })
      const before = get().compare
      expect(apply({ type: 'message.part.removed', properties: { sessionID: 'sess-1', partID: 'p1' } }, get, set)).toBe(true)
      expect(apply({ type: 'message.part.removed', properties: { sessionID: 'sess-1', messageID: 'm1' } }, get, set)).toBe(true)
      expect(
        apply(
          { type: 'message.part.removed', properties: { sessionID: 'sess-1', messageID: 'ghost', partID: 'p1' } },
          get,
          set
        )
      ).toBe(true)
      expect(get().compare).toBe(before)
    })
  })

  describe('session status events', () => {
    it('treats busy and retry as still working, anything else as idle', () => {
      const idleRun = run({ columns: run().columns.map((c) => ({ ...c, busy: false })) })
      const { get, set } = setup({ compare: idleRun })

      apply({ type: 'session.status', properties: { sessionID: 'sess-1', status: { type: 'busy' } } }, get, set)
      expect(get().compare?.columns[0].busy).toBe(true)

      apply({ type: 'session.status', properties: { sessionID: 'sess-1', status: { type: 'idle' } } }, get, set)
      expect(get().compare?.columns[0].busy).toBe(false)

      apply({ type: 'session.status', properties: { sessionID: 'sess-1', status: { type: 'retry' } } }, get, set)
      expect(get().compare?.columns[0].busy).toBe(true)
    })

    it('does not rewrite state when the busy flag is unchanged', () => {
      const { get, set } = setup({ compare: run() })
      const before = get().compare
      apply({ type: 'session.status', properties: { sessionID: 'sess-1', status: { type: 'busy' } } }, get, set)
      expect(get().compare).toBe(before)
    })

    it('treats a missing status object as idle', () => {
      const { get, set } = setup({ compare: run() })
      apply({ type: 'session.status', properties: { sessionID: 'sess-1' } }, get, set)
      expect(get().compare?.columns[0].busy).toBe(false)
    })

    it('session.idle clears busy', () => {
      const { get, set } = setup({ compare: run() })
      expect(apply({ type: 'session.idle', properties: { sessionID: 'sess-2' } }, get, set)).toBe(true)
      expect(get().compare?.columns[1].busy).toBe(false)
    })
  })

  describe('session.error', () => {
    it('prefers the detailed message, then the name, then a generic fallback', () => {
      const { get, set } = setup({ compare: run() })

      apply(
        { type: 'session.error', properties: { sessionID: 'sess-1', error: { data: { message: 'context too long' }, name: 'BadRequest' } } },
        get,
        set
      )
      expect(get().compare?.columns[0].error).toBe('context too long')
      expect(get().compare?.columns[0].busy).toBe(false)

      apply({ type: 'session.error', properties: { sessionID: 'sess-2', error: { name: 'Overloaded' } } }, get, set)
      expect(get().compare?.columns[1].error).toBe('Overloaded')

      apply({ type: 'session.error', properties: { sessionID: 'sess-1' } }, get, set)
      expect(get().compare?.columns[0].error).toBe('Model returned an error.')
    })
  })

  describe('permission.updated', () => {
    it('auto-rejects and records why, never queueing it for the active session', () => {
      const { api: fake, calls } = fakeApi()
      mockApi.mockReturnValue(fake)
      const { get, set } = setup({ compare: run(), permissions: [] } as Partial<AppState>)

      const consumed = apply(
        {
          type: 'permission.updated',
          properties: { id: 'perm-1', sessionID: 'sess-1', title: 'bash', type: 'bash' }
        },
        get,
        set
      )

      expect(consumed).toBe(true)
      expect(calls.replyPermission).toHaveBeenCalledWith({
        directory: '/project',
        sessionID: 'sess-1',
        permissionID: 'perm-1',
        response: 'reject'
      })
      expect(get().compare?.columns[0].error).toContain('Rejected a tool permission request (bash)')
      // The main queue belongs to the active session, not to a compare column.
      expect(get().permissions).toEqual([])
    })

    it('names the tool as unknown when the request has no title', () => {
      const { api: fake } = fakeApi()
      mockApi.mockReturnValue(fake)
      const { get, set } = setup({ compare: run() })

      apply({ type: 'permission.updated', properties: { id: 'perm-1', sessionID: 'sess-1' } }, get, set)

      expect(get().compare?.columns[0].error).toContain('(unknown tool)')
    })

    it('swallows a failed rejection rather than surfacing a second error', async () => {
      const replyPermission = vi.fn(async () => {
        throw new Error('gone')
      })
      const { api: fake } = fakeApi({ replyPermission })
      mockApi.mockReturnValue(fake)
      const { get, set } = setup({ compare: run() })

      expect(() =>
        apply({ type: 'permission.updated', properties: { id: 'perm-1', sessionID: 'sess-1' } }, get, set)
      ).not.toThrow()
      await Promise.resolve()

      // The column reports the resulting failure via session.error instead.
      expect(get().compare?.columns[0].error).toContain('Rejected a tool permission request')
    })

    it('consumes the event without replying when there is no directory', () => {
      const { api: fake, calls } = fakeApi()
      mockApi.mockReturnValue(fake)
      const { get, set } = setup({ compare: run(), directory: '' })

      expect(
        apply({ type: 'permission.updated', properties: { id: 'perm-1', sessionID: 'sess-1' } }, get, set)
      ).toBe(true)
      expect(calls.replyPermission).not.toHaveBeenCalled()
      expect(get().compare?.columns[0].error).toBeNull()
    })

    it('consumes a permission with no usable id', () => {
      const { api: fake, calls } = fakeApi()
      mockApi.mockReturnValue(fake)
      const { get, set } = setup({ compare: run() })

      expect(apply({ type: 'permission.updated', properties: { sessionID: 'sess-1' } }, get, set)).toBe(true)
      expect(calls.replyPermission).not.toHaveBeenCalled()
    })
  })
})
