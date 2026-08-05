import { beforeEach, describe, expect, it } from 'vitest'
import { loadIpc, type IpcHarness } from './ipcHarness'

describe('ipc registration', () => {
  let h: IpcHarness

  beforeEach(async () => {
    h = await loadIpc()
  })

  it('registers every channel exactly once', () => {
    const channels = h.channels()
    expect(new Set(channels).size).toBe(channels.length)
    expect(channels.length).toBeGreaterThan(60)
  })

  it('delegates the fs, git, terminal and editor surfaces to their own registrars', () => {
    expect(h.mocks.registerFs).toHaveBeenCalledTimes(1)
    expect(h.mocks.registerGit).toHaveBeenCalledTimes(1)
    expect(h.mocks.registerTerminal).toHaveBeenCalledTimes(1)
    expect(h.mocks.registerOpenEditor).toHaveBeenCalledTimes(1)
  })

  it('re-registering is idempotent — the stub throws on a duplicate handle', () => {
    // registerIpc clears its own channels first; a second pass must not double-register.
    expect(() => h.ipc.registerIpc()).not.toThrow()
  })

  it('unregisterIpc removes every channel it registered', () => {
    h.ipc.unregisterIpc()
    expect(h.channels()).toHaveLength(0)
  })

  it('every registered channel name is namespaced under oc:', () => {
    expect(h.channels().filter((c) => !c.startsWith('oc:'))).toEqual([])
  })
})
