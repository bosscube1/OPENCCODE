import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpencodeApi } from '../slices/api'
import type { AppState, SetState, GetState } from '../slices/types'
import type { AgentProfile, HarnessToolDefinition, RunnerResult } from '../types'

vi.mock('../slices/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../slices/api')>()
  return { ...actual, api: vi.fn() }
})

import { api } from '../slices/api'
import { createHarnessSlice, type HarnessSlice } from '../slices/harnessSlice'

const mockApi = vi.mocked(api)

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

/** Slice defaults first, then overrides — same ordering as agentSlice.test.ts. */
function setup(overrides: Partial<AppState> = {}): { get: GetState; slice: HarnessSlice } {
  const { get, set } = createStore()
  const slice = createHarnessSlice(set, get)
  set(slice)
  set(overrides)
  return { get, slice }
}

function makeProfile(id: string, overrides: Partial<AgentProfile> = {}): AgentProfile {
  return { id, name: id, provider: 'nanogpt', model: 'google/gemini-2.5-flash', ...overrides }
}

function makeResult(overrides: Partial<RunnerResult> = {}): RunnerResult {
  return {
    content: 'done',
    toolCallCount: 0,
    usage: { input: 10, output: 5 },
    turns: 1,
    finishReason: 'complete',
    ...overrides
  }
}

type HarnessApi = {
  listProfiles: ReturnType<typeof vi.fn>
  saveProfile: ReturnType<typeof vi.fn>
  removeProfile: ReturnType<typeof vi.fn>
  testProfile: ReturnType<typeof vi.fn>
  listTools: ReturnType<typeof vi.fn>
  startRun: ReturnType<typeof vi.fn>
  stopRun: ReturnType<typeof vi.fn>
}

function fakeApi(parts: Partial<HarnessApi> = {}): { api: OpencodeApi; calls: HarnessApi } {
  const calls: HarnessApi = {
    listProfiles: parts.listProfiles ?? vi.fn(async () => []),
    saveProfile: parts.saveProfile ?? vi.fn(async (profile: unknown) => profile),
    removeProfile: parts.removeProfile ?? vi.fn(async () => true),
    testProfile: parts.testProfile ?? vi.fn(async () => true),
    listTools: parts.listTools ?? vi.fn(async () => []),
    startRun: parts.startRun ?? vi.fn(async () => 'run-1'),
    stopRun: parts.stopRun ?? vi.fn(async () => undefined)
  }
  return {
    api: {
      harness: {
        profiles: {
          list: calls.listProfiles,
          get: vi.fn(async () => null),
          save: calls.saveProfile,
          remove: calls.removeProfile,
          test: calls.testProfile
        },
        run: {
          start: calls.startRun,
          stop: calls.stopRun,
          status: vi.fn(async () => null),
          list: vi.fn(async () => [])
        },
        tools: { list: calls.listTools },
        onEvent: vi.fn(() => () => {})
      }
    } as unknown as OpencodeApi,
    calls
  }
}

describe('harnessSlice', () => {
  beforeEach(() => {
    mockApi.mockReset()
  })

  describe('loadHarnessProfiles', () => {
    it('populates the profile list and clears loading', async () => {
      const profiles = [makeProfile('a'), makeProfile('b')]
      mockApi.mockReturnValue(fakeApi({ listProfiles: vi.fn(async () => profiles) }).api)
      const { get, slice } = setup()

      await slice.loadHarnessProfiles()

      expect(get().harnessProfiles).toEqual(profiles)
      expect(get().harnessLoading).toBe(false)
      expect(get().harnessError).toBeNull()
    })

    it('surfaces a failure as harnessError, not the global banner', async () => {
      mockApi.mockReturnValue(
        fakeApi({ listProfiles: vi.fn(async () => Promise.reject(new Error('ipc down'))) }).api
      )
      const { get, slice } = setup()

      await slice.loadHarnessProfiles()

      expect(get().harnessError).toContain('ipc down')
      expect(get().harnessLoading).toBe(false)
      expect(get().error).toBeUndefined()
    })
  })

  describe('saveHarnessProfile', () => {
    it('round-trips through the bridge and refreshes the list', async () => {
      const saved = makeProfile('new-agent')
      const listProfiles = vi.fn(async () => [saved])
      const { api: fake, calls } = fakeApi({ listProfiles })
      mockApi.mockReturnValue(fake)
      const { get, slice } = setup()

      const ok = await slice.saveHarnessProfile({ id: 'new-agent', name: 'new-agent', provider: 'nanogpt', model: 'm' })

      expect(ok).toBe(true)
      expect(calls.saveProfile).toHaveBeenCalledTimes(1)
      expect(listProfiles).toHaveBeenCalledTimes(1)
      expect(get().harnessProfiles).toEqual([saved])
    })

    it('returns false and keeps the error when main rejects the profile', async () => {
      mockApi.mockReturnValue(
        fakeApi({ saveProfile: vi.fn(async () => Promise.reject(new Error('bad id'))) }).api
      )
      const { get, slice } = setup()

      const ok = await slice.saveHarnessProfile({ id: 'BAD ID' })

      expect(ok).toBe(false)
      expect(get().harnessError).toContain('bad id')
    })
  })

  describe('startHarnessRun', () => {
    it('refuses without a project directory', async () => {
      const { api: fake, calls } = fakeApi()
      mockApi.mockReturnValue(fake)
      const { get, slice } = setup({ directory: null })

      await slice.startHarnessRun('a', 'do the thing')

      expect(calls.startRun).not.toHaveBeenCalled()
      expect(get().harnessError).toContain('project folder')
      expect(get().harnessActiveRunId).toBeNull()
    })

    it('sets activeRunId and prepends a running status using the active directory', async () => {
      const { api: fake, calls } = fakeApi()
      mockApi.mockReturnValue(fake)
      const { get, slice } = setup({ directory: '/proj' })

      await slice.startHarnessRun('a', 'do the thing')

      expect(calls.startRun).toHaveBeenCalledWith({ profileId: 'a', task: 'do the thing', directory: '/proj' })
      expect(get().harnessActiveRunId).toBe('run-1')
      expect(get().harnessRuns[0]).toMatchObject({ id: 'run-1', profileId: 'a', status: 'running' })
    })

    it('reports a start failure without touching run state', async () => {
      mockApi.mockReturnValue(
        fakeApi({ startRun: vi.fn(async () => Promise.reject(new Error('no provider'))) }).api
      )
      const { get, slice } = setup({ directory: '/proj' })

      await slice.startHarnessRun('a', 'task')

      expect(get().harnessError).toContain('no provider')
      expect(get().harnessActiveRunId).toBeNull()
      expect(get().harnessRuns).toHaveLength(0)
    })
  })

  describe('stopHarnessRun', () => {
    it('stops the active run only', async () => {
      const { api: fake, calls } = fakeApi()
      mockApi.mockReturnValue(fake)
      const { slice } = setup({ harnessActiveRunId: 'run-9' })

      await slice.stopHarnessRun()

      expect(calls.stopRun).toHaveBeenCalledWith('run-9')
    })
  })

  describe('loadHarnessTools', () => {
    it('populates the tool catalogue', async () => {
      const tools: HarnessToolDefinition[] = [
        { name: 'fs_read', description: 'Read a file', parameters: {}, category: 'read' }
      ]
      mockApi.mockReturnValue(fakeApi({ listTools: vi.fn(async () => tools) }).api)
      const { get, slice } = setup()

      await slice.loadHarnessTools()

      expect(get().harnessTools).toEqual(tools)
    })
  })

  describe('testHarnessProfile', () => {
    it('maps a thrown probe to false', async () => {
      mockApi.mockReturnValue(
        fakeApi({ testProfile: vi.fn(async () => Promise.reject(new Error('no key'))) }).api
      )
      const { slice } = setup()

      expect(await slice.testHarnessProfile('a')).toBe(false)
    })
  })

  describe('handleHarnessEvent', () => {
    it('appends events to the log', () => {
      const { get, slice } = setup()

      slice.handleHarnessEvent({ runId: 'run-1', event: { type: 'text', delta: 'he' } })
      slice.handleHarnessEvent({ runId: 'run-1', event: { type: 'text', delta: 'llo' } })

      expect(get().harnessRunEvents).toHaveLength(2)
      expect(get().harnessRunEvents[1]).toEqual({ runId: 'run-1', event: { type: 'text', delta: 'llo' } })
    })

    it('caps the log at 500 entries, dropping the oldest', () => {
      const { get, slice } = setup()

      for (let i = 0; i < 510; i++) {
        slice.handleHarnessEvent({ runId: 'run-1', event: { type: 'text', delta: `d${i}` } })
      }

      const events = get().harnessRunEvents
      expect(events).toHaveLength(500)
      // The first ten deltas were dropped; the log ends with the newest.
      expect(events[0].event).toEqual({ type: 'text', delta: 'd10' })
      expect(events.at(-1)?.event).toEqual({ type: 'text', delta: 'd509' })
    })

    it('folds a done event into the run status and usage', () => {
      const { get, slice } = setup({
        harnessRuns: [
          {
            id: 'run-1',
            profileId: 'a',
            status: 'running',
            turns: 0,
            usage: { input: 0, output: 0 },
            startedAt: 1
          }
        ]
      })

      slice.handleHarnessEvent({
        runId: 'run-1',
        event: { type: 'done', result: makeResult({ turns: 3, usage: { input: 100, output: 50 } }) }
      })

      const run = get().harnessRuns[0]
      expect(run.status).toBe('completed')
      expect(run.turns).toBe(3)
      expect(run.usage).toEqual({ input: 100, output: 50 })
      expect(run.completedAt).toBeDefined()
    })

    it('maps an aborted finish to cancelled', () => {
      const { get, slice } = setup({
        harnessRuns: [
          { id: 'run-1', profileId: 'a', status: 'running', turns: 0, usage: { input: 0, output: 0 }, startedAt: 1 }
        ]
      })

      slice.handleHarnessEvent({
        runId: 'run-1',
        event: { type: 'done', result: makeResult({ finishReason: 'aborted' }) }
      })

      expect(get().harnessRuns[0].status).toBe('cancelled')
    })

    it('marks the run failed on an error event', () => {
      const { get, slice } = setup({
        harnessRuns: [
          { id: 'run-1', profileId: 'a', status: 'running', turns: 0, usage: { input: 0, output: 0 }, startedAt: 1 }
        ]
      })

      slice.handleHarnessEvent({ runId: 'run-1', event: { type: 'error', message: 'boom' } })

      const run = get().harnessRuns[0]
      expect(run.status).toBe('failed')
      expect(run.error).toBe('boom')
    })

    it('ignores terminal events for unknown or finished runs', () => {
      const { get, slice } = setup({
        harnessRuns: [
          { id: 'run-1', profileId: 'a', status: 'completed', turns: 2, usage: { input: 1, output: 1 }, startedAt: 1 }
        ]
      })

      slice.handleHarnessEvent({ runId: 'run-1', event: { type: 'error', message: 'late' } })
      slice.handleHarnessEvent({ runId: 'run-2', event: { type: 'error', message: 'unknown' } })

      expect(get().harnessRuns[0].status).toBe('completed')
      expect(get().harnessRuns).toHaveLength(1)
    })
  })
})
