import { app, BrowserWindow, dialog } from 'electron'
import updaterPackage, {
  type ProgressInfo,
  type UpdateDownloadedEvent,
  type UpdateInfo
} from 'electron-updater'

// electron-updater is CommonJS at runtime; its named ESM import crashes Electron.
const { autoUpdater } = updaterPackage

export type UpdateStatus =
  | { state: 'idle' | 'checking' | 'not-available' | 'downloaded' }
  | { state: 'available'; version: string }
  | { state: 'progress'; percent: number }
  | { state: 'error'; message: string }

export type UpdaterOptions = {
  /** Called immediately before a confirmed install so close-to-tray logic can allow shutdown. */
  beforeInstall?: () => void
}

type StatusSink = (status: UpdateStatus) => void
type UpdaterEvent = Parameters<typeof autoUpdater.on>[0]

const CHECK_ERROR_MESSAGE = 'Unable to check for updates. Check your connection and try again.'
const DEV_ERROR_MESSAGE = 'Update checks are available only in installed builds.'
const PORTABLE_ERROR_MESSAGE = 'Automatic updates are unavailable in portable builds.'

let statusSink: StatusSink | null = null
let beforeInstall: (() => void) | null = null
let listeners: Array<{ event: UpdaterEvent; listener: (...args: never[]) => void }> = []
let checkPromise: Promise<void> | null = null
let installPromptOpen = false

function emit(status: UpdateStatus): void {
  statusSink?.(status)
}

function safeVersion(version: unknown): string {
  if (typeof version !== 'string') return 'unknown'
  const trimmed = version.trim()
  return /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(trimmed) ? trimmed : 'unknown'
}

function safePercent(percent: unknown): number {
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return 0
  return Math.round(Math.min(100, Math.max(0, percent)) * 10) / 10
}

function isPortableBuild(): boolean {
  return Boolean(process.env.PORTABLE_EXECUTABLE_FILE || process.env.PORTABLE_EXECUTABLE_DIR)
}

async function confirmDownloadedUpdate(version: string): Promise<void> {
  if (installPromptOpen) return
  installPromptOpen = true

  try {
    const options = {
      type: 'info' as const,
      title: 'Update ready',
      message: `OpenCode Desktop ${safeVersion(version)} is ready to install.`,
      detail: 'Install the update and restart OpenCode Desktop now?',
      buttons: ['Install and Restart', 'Later'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    }
    const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const result = parent
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options)

    if (result.response === 0) {
      beforeInstall?.()
      autoUpdater.quitAndInstall(false, true)
    }
  } catch {
    emit({ state: 'error', message: 'The update was downloaded, but the install prompt failed.' })
  } finally {
    installPromptOpen = false
  }
}

function addListener(event: UpdaterEvent, listener: (...args: never[]) => void): void {
  autoUpdater.on(event, listener)
  listeners.push({ event, listener })
}

/** Configure updater events. Call once after Electron is ready. */
export function setupUpdater(sink: StatusSink, options: UpdaterOptions = {}): void {
  cleanupUpdater()
  statusSink = sink
  beforeInstall = options.beforeInstall ?? null

  // Download may be automatic, but installation is always a separate user decision.
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.logger = null

  addListener('checking-for-update', () => emit({ state: 'checking' }))
  addListener('update-not-available', () => emit({ state: 'not-available' }))
  addListener('update-available', (info: UpdateInfo) => {
    emit({ state: 'available', version: safeVersion(info.version) })
  })
  addListener('download-progress', (info: ProgressInfo) => {
    emit({ state: 'progress', percent: safePercent(info.percent) })
  })
  addListener('update-downloaded', (info: UpdateDownloadedEvent) => {
    emit({ state: 'downloaded' })
    void confirmDownloadedUpdate(info.version)
  })
  addListener('update-cancelled', () => emit({ state: 'idle' }))
  addListener('error', () => emit({ state: 'error', message: CHECK_ERROR_MESSAGE }))
  emit({ state: 'idle' })
}

/** Check GitHub Releases for an update. Errors are reported as sanitized status events. */
export function checkForUpdates(): Promise<void> {
  if (!statusSink) return Promise.resolve()
  if (!app.isPackaged) {
    emit({ state: 'error', message: DEV_ERROR_MESSAGE })
    return Promise.resolve()
  }
  if (isPortableBuild()) {
    emit({ state: 'error', message: PORTABLE_ERROR_MESSAGE })
    return Promise.resolve()
  }
  if (checkPromise) return checkPromise

  emit({ state: 'checking' })
  checkPromise = autoUpdater
    .checkForUpdates()
    .then(() => undefined)
    .catch(() => {
      emit({ state: 'error', message: CHECK_ERROR_MESSAGE })
    })
    .finally(() => {
      checkPromise = null
    })
  return checkPromise
}

/** Remove updater listeners during app shutdown or before reconfiguration. */
export function cleanupUpdater(): void {
  for (const { event, listener } of listeners) autoUpdater.removeListener(event, listener)
  listeners = []
  checkPromise = null
  statusSink = null
  beforeInstall = null
  installPromptOpen = false
}
