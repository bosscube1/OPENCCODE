import { BrowserWindow } from 'electron'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export type QuickEntryOptions = {
  preloadPath: string
  rendererUrl?: string
  rendererHtmlPath: string
  getMainWindow: () => BrowserWindow | null
  createMainWindow: () => BrowserWindow
  onSubmit?: (text: string, mainWindow: BrowserWindow) => void | Promise<void>
}

export type QuickEntryController = {
  getWindow(): BrowserWindow | null
  show(): BrowserWindow
  hide(): void
  toggle(): void
  submit(text: string): Promise<void>
  destroy(): void
}

function quickRoute(rendererUrl: string): string {
  const url = new URL(rendererUrl)
  url.hash = '/quick'
  return url.toString()
}

/** Match the exact trusted renderer origin in development, or the exact
 * packaged renderer HTML file in production. */
function isTrustedQuickEntryUrl(target: string, rendererUrl: string | undefined, rendererHtmlPath: string): boolean {
  try {
    const parsed = new URL(target)
    if (rendererUrl) {
      const trusted = new URL(rendererUrl)
      return parsed.protocol === trusted.protocol && parsed.origin === trusted.origin
    }
    return (
      parsed.protocol === 'file:' &&
      parsed.hostname === '' &&
      fileURLToPath(parsed) === resolve(rendererHtmlPath)
    )
  } catch {
    return false
  }
}

/** Build a lazy, reusable quick-entry window loading the renderer's `#/quick` route. */
export function setupQuickEntry(options: QuickEntryOptions): QuickEntryController {
  let quickWindow: BrowserWindow | null = null

  const createWindow = (): BrowserWindow => {
    const win = new BrowserWindow({
      width: 560,
      height: 190,
      minWidth: 420,
      minHeight: 150,
      show: false,
      frame: false,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      backgroundColor: '#1f1e1d',
      title: 'OpenCode Quick Entry',
      webPreferences: {
        preload: options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false
      }
    })

    win.on('closed', () => {
      if (quickWindow === win) quickWindow = null
    })
    win.on('blur', () => {
      if (!win.isDestroyed()) win.hide()
    })
    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) {
        win.show()
        win.focus()
      }
    })

    // Quick Entry is intentionally not a browsing surface.  Its only route is
    // the local renderer route loaded below; any attempted navigation, frame,
    // popup, webview, or drag-and-drop navigation is denied.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (event, url) => {
      if (!isTrustedQuickEntryUrl(url, options.rendererUrl, options.rendererHtmlPath)) event.preventDefault()
    })
    win.webContents.on('will-frame-navigate', (event) => event.preventDefault())
    win.webContents.on('will-attach-webview', (event) => event.preventDefault())

    if (options.rendererUrl) void win.loadURL(quickRoute(options.rendererUrl))
    else void win.loadFile(options.rendererHtmlPath, { hash: '/quick' })

    quickWindow = win
    return win
  }

  const getOrCreateWindow = (): BrowserWindow => {
    if (quickWindow && !quickWindow.isDestroyed()) return quickWindow
    return createWindow()
  }

  const show = (): BrowserWindow => {
    const win = getOrCreateWindow()
    if (!win.isVisible()) win.show()
    win.focus()
    return win
  }

  return {
    getWindow: () => quickWindow,
    show,
    hide(): void {
      if (quickWindow && !quickWindow.isDestroyed()) quickWindow.hide()
    },
    toggle(): void {
      if (quickWindow?.isVisible()) quickWindow.hide()
      else show()
    },
    async submit(value: string): Promise<void> {
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error('Invalid quick entry: text must be a non-empty string.')
      }
      const text = value.trim()
      if (quickWindow && !quickWindow.isDestroyed()) quickWindow.hide()

      const mainWindow = options.getMainWindow() ?? options.createMainWindow()
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()

      const forward = async (): Promise<void> => {
        if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return
        if (options.onSubmit) await options.onSubmit(text, mainWindow)
        else mainWindow.webContents.send('quick-entry:prompt', text)
      }

      if (mainWindow.webContents.isLoadingMainFrame()) {
        await new Promise<void>((resolve, reject) => {
          const contents = mainWindow.webContents
          const cleanup = (): void => {
            contents.removeListener('did-finish-load', loaded)
            contents.removeListener('did-fail-load', failed)
            contents.removeListener('destroyed', destroyed)
          }
          const loaded = (): void => {
            cleanup()
            void forward().then(resolve, reject)
          }
          const failed = (): void => {
            cleanup()
            reject(new Error('Unable to forward Quick Entry because the main window failed to load.'))
          }
          const destroyed = (): void => {
            cleanup()
            reject(new Error('Unable to forward Quick Entry because the main window was closed.'))
          }
          contents.once('did-finish-load', loaded)
          contents.once('did-fail-load', failed)
          contents.once('destroyed', destroyed)
        })
      } else {
        await forward()
      }
    },
    destroy(): void {
      if (!quickWindow || quickWindow.isDestroyed()) {
        quickWindow = null
        return
      }
      const win = quickWindow
      quickWindow = null
      win.removeAllListeners()
      win.destroy()
    }
  }
}
