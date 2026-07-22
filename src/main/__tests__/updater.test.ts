import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void
  const listeners = new Map<string, Set<Listener>>()

  const updater = {
    autoDownload: false,
    autoInstallOnAppQuit: true,
    logger: {} as object | null,
    on: vi.fn((event: string, listener: Listener) => {
      const eventListeners = listeners.get(event) ?? new Set<Listener>()
      eventListeners.add(listener)
      listeners.set(event, eventListeners)
      return updater
    }),
    removeListener: vi.fn((event: string, listener: Listener) => {
      listeners.get(event)?.delete(listener)
      return updater
    }),
    checkForUpdates: vi.fn<() => Promise<null>>(),
    quitAndInstall: vi.fn(),
    emit(event: string, ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    }
  }

  return {
    listeners,
    updater,
    app: { isPackaged: true },
    showMessageBox: vi.fn(),
    getFocusedWindow: vi.fn(() => null),
    getAllWindows: vi.fn(() => [])
  }
})

vi.mock('electron', () => ({
  app: mocks.app,
  BrowserWindow: {
    getFocusedWindow: mocks.getFocusedWindow,
    getAllWindows: mocks.getAllWindows
  },
  dialog: { showMessageBox: mocks.showMessageBox }
}))

vi.mock('electron-updater', () => ({ default: { autoUpdater: mocks.updater } }))

import { checkForUpdates, cleanupUpdater, setupUpdater, type UpdateStatus } from '../updater'

describe('updater', () => {
  beforeEach(() => {
    cleanupUpdater()
    mocks.listeners.clear()
    vi.clearAllMocks()
    mocks.app.isPackaged = true
    mocks.updater.checkForUpdates.mockResolvedValue(null)
    mocks.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false })
    delete process.env.PORTABLE_EXECUTABLE_FILE
    delete process.env.PORTABLE_EXECUTABLE_DIR
  })

  it('configures automatic downloads but never automatic installation', () => {
    const statuses: UpdateStatus[] = []
    setupUpdater((status) => statuses.push(status))

    expect(mocks.updater.autoDownload).toBe(true)
    expect(mocks.updater.autoInstallOnAppQuit).toBe(false)
    expect(mocks.updater.logger).toBeNull()
    expect(statuses).toEqual([{ state: 'idle' }])
  })

  it('does not invoke electron-updater in development or portable builds', async () => {
    const statuses: UpdateStatus[] = []
    setupUpdater((status) => statuses.push(status))

    mocks.app.isPackaged = false
    await checkForUpdates()
    mocks.app.isPackaged = true
    process.env.PORTABLE_EXECUTABLE_FILE = 'OpenCode-Portable.exe'
    await checkForUpdates()

    expect(mocks.updater.checkForUpdates).not.toHaveBeenCalled()
    expect(statuses.at(-2)).toEqual({
      state: 'error',
      message: 'Update checks are available only in installed builds.'
    })
    expect(statuses.at(-1)).toEqual({
      state: 'error',
      message: 'Automatic updates are unavailable in portable builds.'
    })
  })

  it('redacts update errors and normalizes remote event data', async () => {
    const statuses: UpdateStatus[] = []
    setupUpdater((status) => statuses.push(status))
    mocks.updater.checkForUpdates.mockRejectedValue(
      new Error('https://token@example.invalid/C:/Users/private')
    )

    mocks.updater.emit('update-available', { version: '<script>secret</script>' })
    mocks.updater.emit('download-progress', { percent: 123.456 })
    mocks.updater.emit('error', new Error('private path'))
    await checkForUpdates()

    expect(statuses).toContainEqual({ state: 'available', version: 'unknown' })
    expect(statuses).toContainEqual({ state: 'progress', percent: 100 })
    const messages = statuses
      .filter((status): status is Extract<UpdateStatus, { state: 'error' }> => status.state === 'error')
      .map((status) => status.message)
    expect(messages).not.toContain(expect.stringContaining('token'))
    expect(messages).not.toContain(expect.stringContaining('private'))
  })

  it('installs a downloaded update only after explicit confirmation', async () => {
    const beforeInstall = vi.fn()
    setupUpdater(() => undefined, { beforeInstall })

    mocks.updater.emit('update-downloaded', { version: '1.2.3' })
    await vi.waitFor(() => expect(mocks.showMessageBox).toHaveBeenCalledTimes(1))
    expect(beforeInstall).not.toHaveBeenCalled()
    expect(mocks.updater.quitAndInstall).not.toHaveBeenCalled()

    mocks.showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: false })
    mocks.updater.emit('update-downloaded', { version: '1.2.3' })
    await vi.waitFor(() => expect(mocks.updater.quitAndInstall).toHaveBeenCalledWith(false, true))
    expect(beforeInstall).toHaveBeenCalledOnce()
  })

  it('removes only the listeners it registered', () => {
    const statuses: UpdateStatus[] = []
    setupUpdater((status) => statuses.push(status))
    cleanupUpdater()
    mocks.updater.emit('checking-for-update')

    expect(statuses).toEqual([{ state: 'idle' }])
    expect(mocks.updater.removeListener).toHaveBeenCalledTimes(7)
  })
})
