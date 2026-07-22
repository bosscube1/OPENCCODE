/**
 * Electron app lifecycle: window creation, OpenCode server supervision, event fan-out.
 */
import { app, BrowserWindow, dialog, screen } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initCrashLog, logCrash } from './crashlog'
import { registerIpc, unregisterIpc } from './ipc'
import { setupApplicationMenu } from './menu'
import { createAppSettingsController, type AppSettingsController } from './appSettings'
import { setupQuickEntry, type QuickEntryController } from './quickEntry'
import { setupTray, type TrayController } from './tray'
import { checkForUpdates, cleanupUpdater, setupUpdater, type UpdateStatus } from './updater'
import { getStatus, onEvent, onStatus, startServer, stopServer, type ServerStatus } from './server'

const moduleDir = dirname(fileURLToPath(import.meta.url))
const rendererDevUrl = process.env.ELECTRON_RENDERER_URL

let mainWindow: BrowserWindow | null = null
let shuttingDown = false
let quitRequested = false
let appSettings: AppSettingsController | null = null
let quickEntry: QuickEntryController | null = null
let tray: TrayController | null = null
const rendererReady = new WeakSet<BrowserWindow>()
const pendingQuickPrompts: string[] = []
let lastUpdateStatus: UpdateStatus = { state: 'idle' }

/* ------------------------------------------------------------------ */
/* window bounds persistence                                           */
/* ------------------------------------------------------------------ */

type WindowBounds = {
  x: number
  y: number
  width: number
  height: number
  maximized: boolean
}

const DEFAULT_BOUNDS: WindowBounds = {
  x: -1,
  y: -1,
  width: 1200,
  height: 800,
  maximized: false
}

function boundsPath(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

function loadBounds(): WindowBounds {
  try {
    const raw = readFileSync(boundsPath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<WindowBounds>
    return {
      x: typeof parsed.x === 'number' ? parsed.x : DEFAULT_BOUNDS.x,
      y: typeof parsed.y === 'number' ? parsed.y : DEFAULT_BOUNDS.y,
      width: typeof parsed.width === 'number' ? Math.max(780, parsed.width) : DEFAULT_BOUNDS.width,
      height: typeof parsed.height === 'number' ? Math.max(500, parsed.height) : DEFAULT_BOUNDS.height,
      maximized: typeof parsed.maximized === 'boolean' ? parsed.maximized : false
    }
  } catch {
    return { ...DEFAULT_BOUNDS }
  }
}

function saveBounds(bounds: WindowBounds): void {
  try {
    const dir = app.getPath('userData')
    mkdirSync(dir, { recursive: true })
    writeFileSync(boundsPath(), JSON.stringify(bounds), 'utf8')
  } catch {
    /* best-effort persistence */
  }
}

/** Validate that the saved position is visible on at least one connected display. */
function validateBounds(bounds: WindowBounds): WindowBounds {
  if (bounds.x === -1 && bounds.y === -1) return bounds // use default placement
  const displays = screen.getAllDisplays()
  const visible = displays.some((display) => {
    const { x, y, width, height } = display.bounds
    // At least 100px of the window should be visible on this display
    return (
      bounds.x < x + width - 100 &&
      bounds.x + bounds.width > x + 100 &&
      bounds.y < y + height - 100 &&
      bounds.y + bounds.height > y + 100
    )
  })
  return visible ? bounds : { ...bounds, x: -1, y: -1 }
}

let saveBoundsTimer: ReturnType<typeof setTimeout> | null = null

function debouncedSaveBounds(win: BrowserWindow): void {
  if (saveBoundsTimer !== null) clearTimeout(saveBoundsTimer)
  saveBoundsTimer = setTimeout(() => {
    saveBoundsTimer = null
    if (win.isDestroyed()) return
    const maximized = win.isMaximized()
    // When maximized, save the restored bounds (not the maximized ones)
    const bounds = maximized ? win.getNormalBounds() : win.getBounds()
    saveBounds({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      maximized
    })
  }, 300)
}

/* ------------------------------------------------------------------ */
/* paths                                                               */
/* ------------------------------------------------------------------ */

/**
 * Electron requires an ESM preload to be named `.mjs`; a CJS build emits `.js`.
 * Probe both so the app works whichever way electron-vite emits the bundle.
 */
function resolvePreload(): string {
  const candidates = [
    join(moduleDir, '../preload/index.mjs'),
    join(moduleDir, '../preload/index.js'),
    join(moduleDir, '../preload/index.cjs')
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return candidates[0]
}

function resolveResource(name: string): string {
  const candidates = [
    join(moduleDir, '../../resources', name),
    join(process.resourcesPath, 'app.asar.unpacked', 'resources', name),
    join(process.resourcesPath, 'resources', name)
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]
}

/**
 * Only the renderer we load is allowed to retain a privileged preload.  Do not
 * use string-prefix checks here: `http://127.0.0.1:5173@evil.example` starts
 * with a development URL but has an attacker-controlled origin.
 */
function isTrustedRendererUrl(target: string, rendererHtmlPath: string): boolean {
  try {
    const parsed = new URL(target)
    if (rendererDevUrl) {
      const trusted = new URL(rendererDevUrl)
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

/* ------------------------------------------------------------------ */
/* renderer messaging                                                  */
/* ------------------------------------------------------------------ */

function broadcast(channel: 'oc:event' | 'oc:server', payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    const contents = win.webContents
    if (contents.isDestroyed()) continue
    contents.send(channel, payload)
  }
}

function broadcastUpdateStatus(payload: UpdateStatus): void {
  lastUpdateStatus = payload
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('update:status', payload)
    }
  }
}

function flushQuickPrompts(win: BrowserWindow): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return
  while (pendingQuickPrompts.length > 0) {
    const text = pendingQuickPrompts.shift()
    if (text) win.webContents.send('quick-entry:prompt', text)
  }
}

/* ------------------------------------------------------------------ */
/* window                                                              */
/* ------------------------------------------------------------------ */

function createWindow(): BrowserWindow {
  const saved = validateBounds(loadBounds())
  const usePosition = saved.x !== -1 && saved.y !== -1

  const win = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    ...(usePosition ? { x: saved.x, y: saved.y } : {}),
    minWidth: 780,
    minHeight: 500,
    show: false,
    backgroundColor: '#1f1e1d',
    autoHideMenuBar: true,
    title: 'opencode desktop',
    webPreferences: {
      preload: resolvePreload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false
    }
  })

  // Restore maximized state after showing
  win.on('ready-to-show', () => {
    rendererReady.add(win)
    if (saved.maximized) win.maximize()
    win.show()
    if (!win.webContents.isDestroyed()) {
      win.webContents.send('oc:server', getStatus())
      win.webContents.send('update:status', lastUpdateStatus)
    }
    flushQuickPrompts(win)
    tray?.refresh()
  })

  // Persist bounds on resize/move
  win.on('resize', () => debouncedSaveBounds(win))
  win.on('move', () => debouncedSaveBounds(win))

  win.on('close', (event) => {
    // Save bounds immediately on close
    if (!win.isDestroyed()) {
      const maximized = win.isMaximized()
      const bounds = maximized ? win.getNormalBounds() : win.getBounds()
      saveBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, maximized })
    }
    if (!quitRequested && appSettings?.get().settings.closeToTray) {
      event.preventDefault()
      win.hide()
      tray?.refresh()
    }
  })

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
    tray?.refresh()
  })

  // Links must use the explicit, validated `oc:openExternal` IPC capability.
  // Never turn a renderer navigation or popup into an OS-level navigation.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  win.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url, join(moduleDir, '../renderer/index.html'))) event.preventDefault()
  })

  win.webContents.on('will-frame-navigate', (event) => {
    // The application has no legitimate subframe navigations.
    event.preventDefault()
  })

  win.webContents.on('will-attach-webview', (event) => event.preventDefault())

  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    console.log(`[Renderer Console] [level ${level}] ${message} (${sourceId}:${line})`)
  })

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[Renderer fail load] code=${errorCode} desc=${errorDescription} url=${validatedURL}`)
  })

  if (rendererDevUrl) {
    void win.loadURL(rendererDevUrl)
  } else {
    void win.loadFile(join(moduleDir, '../renderer/index.html'))
  }

  mainWindow = win
  return win
}

function focusExistingWindow(): void {
  const existing = mainWindow
  if (!existing || existing.isDestroyed()) return
  if (existing.isMinimized()) existing.restore()
  existing.show()
  existing.focus()
  tray?.refresh()
}

function showMainWindow(): BrowserWindow {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  tray?.refresh()
  return win
}

function hideMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide()
  tray?.refresh()
}

function sendMainWindowCommand(channel: 'main-menu:new-session'): void {
  const win = showMainWindow()
  const send = (): void => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel)
  }
  if (rendererReady.has(win)) send()
  else win.once('ready-to-show', send)
}

function requestQuit(): void {
  quitRequested = true
  app.quit()
}

/* ------------------------------------------------------------------ */
/* bootstrap                                                           */
/* ------------------------------------------------------------------ */

// A second instance would spawn a second server; keep exactly one.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    focusExistingWindow()
  })

  onEvent((event) => {
    broadcast('oc:event', event)
  })

  onStatus((serverStatus: ServerStatus) => {
    broadcast('oc:server', serverStatus)
  })

  process.on('uncaughtException', (err) => {
    logCrash('uncaughtException', err)
    try {
      dialog.showErrorBox(
        'OpenCode Desktop crashed',
        String(err instanceof Error ? err.stack ?? err.message : err)
      )
    } catch {
      /* dialog unavailable this early / this late in shutdown — crash log still has it */
    }
    app.exit(1)
  })
  process.on('unhandledRejection', (reason) => {
    logCrash('unhandledRejection', reason)
  })

  app.whenReady().then(() => {
    initCrashLog(app)
    app.setAppUserModelId('dev.opencode.desktop')

    quickEntry = setupQuickEntry({
      preloadPath: resolvePreload(),
      rendererUrl: rendererDevUrl,
      rendererHtmlPath: join(moduleDir, '../renderer/index.html'),
      getMainWindow: () => mainWindow,
      createMainWindow: createWindow,
      onSubmit: (text, win) => {
        if (rendererReady.has(win)) win.webContents.send('quick-entry:prompt', text)
        else pendingQuickPrompts.push(text)
      }
    })
    appSettings = createAppSettingsController({ onShortcut: () => quickEntry?.toggle() })
    tray = setupTray({
      iconPath: resolveResource('tray-icon.png'),
      isMainWindowVisible: () => Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()),
      onShow: () => { showMainWindow() },
      onHide: hideMainWindow,
      onNewChat: () => sendMainWindowCommand('main-menu:new-session'),
      onQuickEntry: () => quickEntry?.show(),
      onQuit: requestQuit
    })
    setupUpdater(broadcastUpdateStatus, { beforeInstall: () => { quitRequested = true } })
    setupApplicationMenu({ onCheckForUpdates: () => { void checkForUpdates() }, onQuit: requestQuit })
    registerIpc({ appSettings, onQuickSubmit: (text) => quickEntry?.submit(text) })
    createWindow()

    void startServer().then((serverStatus) => {
      broadcast('oc:server', serverStatus)
    })
    if (app.isPackaged) void checkForUpdates()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform === 'darwin') return
    if (!quitRequested && appSettings?.get().settings.closeToTray) return
    app.quit()
  })

  app.on('before-quit', () => {
    if (shuttingDown) return
    shuttingDown = true
    quitRequested = true
    cleanupUpdater()
    appSettings?.dispose()
    appSettings = null
    tray?.destroy()
    tray = null
    quickEntry?.destroy()
    quickEntry = null
    stopServer()
    unregisterIpc()
  })

  app.on('will-quit', () => {
    if (shuttingDown) return
    shuttingDown = true
    stopServer()
    unregisterIpc()
  })
}
