import { BrowserWindow } from 'electron'
import { isTrustedRendererUrl } from './trustedUrl'
import { createBoundsStore } from './windowBounds'

export type LiveWindowOptions = {
  preloadPath: string
  /** Dev-server URL when running electron-vite dev; undefined in a packaged build. */
  rendererUrl?: string
  rendererHtmlPath: string
}

export type LiveWindowController = {
  getWindow(): BrowserWindow | null
  /** Create if needed, restore if minimized, show and focus. */
  show(): BrowserWindow
  toggle(): void
  setAlwaysOnTop(on: boolean): void
  isAlwaysOnTop(): boolean
  destroy(): void
}

/** Shared by the bounds store's clamping and the window's own constraints. */
const MIN_WIDTH = 360
const MIN_HEIGHT = 420

function liveRoute(rendererUrl: string): string {
  const url = new URL(rendererUrl)
  url.hash = '/live'
  return url.toString()
}

/** Build a lazy, reusable floating always-on-top window loading the renderer's
 * `#/live` route (the Gemini Live screen copilot). Unlike the main window,
 * this is a persistent workspace that must keep running while the user works
 * in other windows, so it stays visible and focused instead of hiding on blur. */
export function setupLiveWindow(options: LiveWindowOptions): LiveWindowController {
  let liveWindow: BrowserWindow | null = null

  // Per-controller, not module scope: `app.getPath` must not be reached at
  // import time, and a second controller must get its own store.
  const boundsStore = createBoundsStore({
    fileName: 'live-window-state.json',
    defaults: { x: -1, y: -1, width: 460, height: 720, maximized: false },
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT
  })

  const createWindow = (): BrowserWindow => {
    const saved = boundsStore.load()
    const usePosition = saved.x !== -1 && saved.y !== -1

    const win = new BrowserWindow({
      width: saved.width,
      height: saved.height,
      ...(usePosition ? { x: saved.x, y: saved.y } : {}),
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      show: false,
      // Persistent workspace, not a transient prompt: keep the frame and let
      // the user resize it, unlike Quick Entry's borderless fixed-size popup.
      frame: true,
      resizable: true,
      alwaysOnTop: true,
      // Must stay Alt-Tab reachable — this is a working surface the user
      // switches back to, unlike Quick Entry which is meant to vanish.
      skipTaskbar: false,
      backgroundColor: '#1f1e1d',
      // A full menu bar eats scarce vertical space in a narrow floating panel;
      // the main window hides it the same way. Alt still reveals it.
      autoHideMenuBar: true,
      title: 'Gemini Live',
      webPreferences: {
        preload: options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false
      }
    })

    boundsStore.attach(win)

    // 'floating' keeps the window above normal windows without escalating to
    // the screen-saver level, which would fight the OS window switcher.
    win.setAlwaysOnTop(true, 'floating')

    // The renderer entry is one index.html shared by every route, and its
    // <title> would otherwise overwrite the `title` option above the moment the
    // page loads — leaving this window labelled "OpenCode Desktop" in the
    // taskbar and Alt-Tab, indistinguishable from the main window.
    win.on('page-title-updated', (event) => event.preventDefault())

    win.on('closed', () => {
      if (liveWindow === win) liveWindow = null
    })
    // Deliberately no 'blur' handler: Quick Entry hides on blur, but this
    // window must survive losing focus so Gemini Live keeps running behind
    // whatever the user clicks into. That persistence is the entire feature.
    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) {
        win.show()
        win.focus()
      }
    })

    // Same navigation hardening as Quick Entry: this window only ever loads
    // its own local renderer route, so any other navigation, frame
    // navigation, popup, or webview attach is denied outright.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (event, url) => {
      if (!isTrustedRendererUrl(url, options.rendererUrl, options.rendererHtmlPath)) event.preventDefault()
    })
    win.webContents.on('will-frame-navigate', (event) => event.preventDefault())
    win.webContents.on('will-attach-webview', (event) => event.preventDefault())

    if (options.rendererUrl) void win.loadURL(liveRoute(options.rendererUrl))
    else void win.loadFile(options.rendererHtmlPath, { hash: '/live' })

    // Closing this window tears down its Gemini Live session for free:
    // geminiLive.ts keys connections by webContents.id and cleans up via
    // contents.once('destroyed'), so there is nothing to stop here.

    liveWindow = win
    return win
  }

  const getOrCreateWindow = (): BrowserWindow => {
    if (liveWindow && !liveWindow.isDestroyed()) return liveWindow
    return createWindow()
  }

  const show = (): BrowserWindow => {
    const win = getOrCreateWindow()
    if (win.isMinimized()) win.restore()
    if (!win.isVisible()) win.show()
    win.focus()
    return win
  }

  return {
    getWindow: () => liveWindow,
    show,
    toggle(): void {
      if (liveWindow && !liveWindow.isDestroyed() && liveWindow.isVisible()) liveWindow.hide()
      else show()
    },
    setAlwaysOnTop(on: boolean): void {
      if (!liveWindow || liveWindow.isDestroyed()) return
      if (on) liveWindow.setAlwaysOnTop(true, 'floating')
      else liveWindow.setAlwaysOnTop(false)
    },
    isAlwaysOnTop(): boolean {
      if (!liveWindow || liveWindow.isDestroyed()) return false
      return liveWindow.isAlwaysOnTop()
    },
    destroy(): void {
      if (!liveWindow || liveWindow.isDestroyed()) {
        liveWindow = null
        return
      }
      const win = liveWindow
      liveWindow = null
      win.removeAllListeners()
      win.destroy()
    }
  }
}
