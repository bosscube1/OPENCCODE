import { beforeEach, describe, expect, it } from 'vitest'
import { expectRejectsAll, HOSTILE_STRINGS, loadIpc, type IpcHarness } from './ipcHarness'

const HARNESS_CHANNELS = [
  'oc:harness:profiles:list',
  'oc:harness:profiles:get',
  'oc:harness:profiles:save',
  'oc:harness:profiles:delete',
  'oc:harness:profiles:test',
  'oc:harness:run:start',
  'oc:harness:run:stop',
  'oc:harness:run:status',
  'oc:harness:run:list',
  'oc:harness:tools:list'
]

describe('ipc harness channels', () => {
  let h: IpcHarness

  beforeEach(async () => {
    h = await loadIpc()
  })

  it('registers every oc:harness:* channel exactly once', () => {
    for (const channel of HARNESS_CHANNELS) {
      expect(h.has(channel), `expected handler for ${channel}`).toBe(true)
    }
  })

  it('unregisters every harness channel via unregisterIpc', () => {
    h.ipc.unregisterIpc()
    for (const channel of HARNESS_CHANNELS) {
      expect(h.has(channel)).toBe(false)
    }
  })

  it('delegates profiles:list and tools:list to the controller', async () => {
    await h.invoke('oc:harness:profiles:list')
    expect(h.mocks.harnessController.listProfiles).toHaveBeenCalledTimes(1)

    await h.invoke('oc:harness:tools:list')
    expect(h.mocks.harnessController.listTools).toHaveBeenCalledTimes(1)
  })

  it('profiles:get maps a missing profile to null and validates the id', async () => {
    h.mocks.harnessController.getProfile.mockReturnValueOnce(undefined)
    await expect(h.invoke('oc:harness:profiles:get', 'coder')).resolves.toBeNull()
    expect(h.mocks.harnessController.getProfile).toHaveBeenCalledWith('coder')

    await expectRejectsAll(
      (value) => h.invoke('oc:harness:profiles:get', value),
      HOSTILE_STRINGS
    )
  })

  it('profiles:save forwards the raw profile for validation in the store', async () => {
    const raw = { id: 'x', name: 'X', provider: 'nanogpt', model: 'm' }
    await h.invoke('oc:harness:profiles:save', raw)
    expect(h.mocks.harnessController.saveProfile).toHaveBeenCalledWith(raw)
  })

  it('profiles:delete and profiles:test require a string id', async () => {
    await h.invoke('oc:harness:profiles:delete', 'x')
    expect(h.mocks.harnessController.deleteProfile).toHaveBeenCalledWith('x')
    await h.invoke('oc:harness:profiles:test', 'x')
    expect(h.mocks.harnessController.testProfile).toHaveBeenCalledWith('x')

    await expectRejectsAll((v) => h.invoke('oc:harness:profiles:delete', v), HOSTILE_STRINGS)
    await expectRejectsAll((v) => h.invoke('oc:harness:profiles:test', v), HOSTILE_STRINGS)
  })

  it('run:start validates its arguments and passes the resolved directory through', async () => {
    h.mocks.requireDirectory.mockReturnValueOnce('C:/resolved/project')
    const runId = await h.invoke('oc:harness:run:start', {
      profileId: 'coder', task: 'do it', directory: 'C:/project'
    })
    expect(runId).toBe('run-1')
    expect(h.mocks.requireDirectory).toHaveBeenCalledWith('C:/project', 'directory')
    expect(h.mocks.harnessController.startRun).toHaveBeenCalledWith({
      profileId: 'coder', task: 'do it', directory: 'C:/resolved/project'
    })
  })

  it('run:start rejects hostile arguments before touching the controller', async () => {
    const good = { profileId: 'coder', task: 'do it', directory: 'C:/project' }
    await expectRejectsAll((v) => h.invoke('oc:harness:run:start', v), [undefined, null, 'x', 42, true])
    for (const key of ['profileId', 'task', 'directory'] as const) {
      for (const bad of HOSTILE_STRINGS) {
        await expect(
          h.invoke('oc:harness:run:start', { ...good, [key]: bad }),
          `expected rejection for ${key}=${String(bad)}`
        ).rejects.toThrow()
      }
    }
    expect(h.mocks.harnessController.startRun).not.toHaveBeenCalled()
  })

  it('run:start propagates a rejected directory from the fs guard', async () => {
    h.mocks.requireDirectory.mockImplementationOnce(() => {
      throw new Error('Directory does not exist: C:/nope')
    })
    await expect(
      h.invoke('oc:harness:run:start', { profileId: 'coder', task: 't', directory: 'C:/nope' })
    ).rejects.toThrow(/does not exist/)
    expect(h.mocks.harnessController.startRun).not.toHaveBeenCalled()
  })

  it('run:stop, run:status and run:list delegate to the controller', async () => {
    await h.invoke('oc:harness:run:stop', 'run-1')
    expect(h.mocks.harnessController.stopRun).toHaveBeenCalledWith('run-1')

    h.mocks.harnessController.getRunStatus.mockReturnValueOnce(undefined)
    await expect(h.invoke('oc:harness:run:status', 'run-1')).resolves.toBeNull()
    expect(h.mocks.harnessController.getRunStatus).toHaveBeenCalledWith('run-1')

    await h.invoke('oc:harness:run:list')
    expect(h.mocks.harnessController.listRuns).toHaveBeenCalledTimes(1)

    await expectRejectsAll((v) => h.invoke('oc:harness:run:stop', v), HOSTILE_STRINGS)
    await expectRejectsAll((v) => h.invoke('oc:harness:run:status', v), HOSTILE_STRINGS)
  })
})
