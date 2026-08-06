/**
 * The agentic-harness slice: profile CRUD, tool catalogue, single-agent runs,
 * and the live `oc:harness:event` stream.
 *
 * Runs execute in the main process (HarnessController); this slice only mirrors
 * what IPC reports. A run's status changes are folded in from its `done`/`error`
 * events — the renderer never polls `run:status` for live updates.
 */

import { api, errText } from './api'
import type { AppState, SetState, GetState } from './types'
import type { HarnessEventPayload, RunnerEvent, RunStatus } from '../types'

/** Terminal events are the only ones that change a run's status. */
type TerminalEvent = Extract<RunnerEvent, { type: 'done' | 'error' }>

/**
 * Cap on the live event log. Text arrives one event per streamed chunk, so a
 * long run would otherwise grow the store without bound — the monitor renders
 * only the active run anyway, so dropping the oldest entries loses nothing
 * actionable. (Same memory-bound rationale as the images gallery cap.)
 */
const MAX_RUN_EVENTS = 500

export type HarnessSlice = Pick<
  AppState,
  | 'harnessProfiles'
  | 'harnessTools'
  | 'harnessActiveRunId'
  | 'harnessRuns'
  | 'harnessRunEvents'
  | 'harnessLoading'
  | 'harnessError'
  | 'loadHarnessProfiles'
  | 'saveHarnessProfile'
  | 'deleteHarnessProfile'
  | 'testHarnessProfile'
  | 'loadHarnessTools'
  | 'startHarnessRun'
  | 'stopHarnessRun'
  | 'handleHarnessEvent'
>

/** Fold a terminal event into the matching run, mirroring the main-process controller. */
function applyTerminalEvent(run: RunStatus, event: TerminalEvent): RunStatus {
  if (run.status !== 'running') return run
  if (event.type === 'done') {
    const { result } = event
    const status: RunStatus['status'] =
      result.finishReason === 'complete'
        ? 'completed'
        : result.finishReason === 'aborted'
          ? 'cancelled'
          : 'failed'
    return {
      ...run,
      status,
      turns: result.turns,
      usage: { input: result.usage.input, output: result.usage.output },
      completedAt: Date.now(),
      result,
      ...(result.error ? { error: result.error } : {})
    }
  }
  return { ...run, status: 'failed', completedAt: Date.now(), error: event.message }
}

export function createHarnessSlice(set: SetState, get: GetState): HarnessSlice {
  return {
    harnessProfiles: [],
    harnessTools: [],
    harnessActiveRunId: null,
    harnessRuns: [],
    harnessRunEvents: [],
    harnessLoading: false,
    harnessError: null,

    async loadHarnessProfiles(): Promise<void> {
      set({ harnessLoading: true, harnessError: null })
      try {
        const profiles = await api().harness.profiles.list()
        set({ harnessProfiles: profiles ?? [], harnessLoading: false })
      } catch (e) {
        set({ harnessError: errText(e), harnessLoading: false })
      }
    },

    async saveHarnessProfile(profile: unknown): Promise<boolean> {
      try {
        await api().harness.profiles.save(profile)
        await get().loadHarnessProfiles()
        return true
      } catch (e) {
        set({ harnessError: errText(e) })
        return false
      }
    },

    async deleteHarnessProfile(id: string): Promise<void> {
      try {
        await api().harness.profiles.remove(id)
        await get().loadHarnessProfiles()
      } catch (e) {
        set({ harnessError: errText(e) })
      }
    },

    async testHarnessProfile(id: string): Promise<boolean> {
      try {
        return await api().harness.profiles.test(id)
      } catch {
        // A probe that throws (provider unconfigured, IPC down) is a failed test, not a banner.
        return false
      }
    },

    async loadHarnessTools(): Promise<void> {
      try {
        const tools = await api().harness.tools.list()
        set({ harnessTools: tools ?? [] })
      } catch (e) {
        set({ harnessError: errText(e) })
      }
    },

    async startHarnessRun(profileId: string, task: string): Promise<void> {
      const directory = get().directory
      if (!directory) {
        set({ harnessError: 'Pick a project folder first.' })
        return
      }
      set({ harnessError: null })
      try {
        const runId = await api().harness.run.start({ profileId, task, directory })
        set((state) => ({
          harnessActiveRunId: runId,
          harnessRuns: [
            {
              id: runId,
              profileId,
              status: 'running',
              turns: 0,
              usage: { input: 0, output: 0 },
              startedAt: Date.now()
            },
            ...state.harnessRuns
          ]
        }))
      } catch (e) {
        set({ harnessError: errText(e) })
      }
    },

    async stopHarnessRun(): Promise<void> {
      const runId = get().harnessActiveRunId
      if (!runId) return
      try {
        await api().harness.run.stop(runId)
      } catch (e) {
        set({ harnessError: errText(e) })
      }
    },

    handleHarnessEvent(payload: HarnessEventPayload): void {
      const { runId, event } = payload
      set((state) => {
        const harnessRunEvents = [...state.harnessRunEvents, { runId, event }]
        if (harnessRunEvents.length > MAX_RUN_EVENTS) {
          harnessRunEvents.splice(0, harnessRunEvents.length - MAX_RUN_EVENTS)
        }
        let harnessRuns = state.harnessRuns
        if (event.type === 'done' || event.type === 'error') {
          harnessRuns = state.harnessRuns.map((run) =>
            run.id === runId ? applyTerminalEvent(run, event) : run
          )
        }
        return { harnessRunEvents, harnessRuns }
      })
    }
  }
}
