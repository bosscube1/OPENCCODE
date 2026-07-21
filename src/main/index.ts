/**
 * Electron app lifecycle: window creation, OpenCode server supervision, event fan-out.
 */
import { app, BrowserWindow, shell } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerIpc, unregisterIpc } from './ipc'
import { getStatus, onEvent, onStatus, startServer, stopServer, type ServerStatus } from './server'

const moduleDir = dirname(fileURLToPath(import.meta.url))
const rendererDevUrl = process.env.ELECTRON_RENDERER_URL

let mainWindow: BrowserWindow | null = null
let shuttingDown = false

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

function isInternalUrl(target: string): boolean {
  if (target.startsWith('file://')) return true
  if (rendererDevUrl && target.startsWith(rendererDevUrl)) return true
  return false
}

function openExternal(target: string): void {
  try {
    const parsed = new URL(target)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      void shell.openExternal(parsed.toString())
    }
  } catch {
    /* not a URL we are willing to hand to the OS */
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

/* ------------------------------------------------------------------ */
/* window                                                              */
/* ------------------------------------------------------------------ */

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 780,
    minHeight: 500,
    show: false,
    backgroundColor: '#14161a',
    autoHideMenuBar: true,
    title: 'opencode desktop',
    webPreferences: {
      preload: resolvePreload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.on('ready-to-show', () => {
    win.show()
    if (!win.webContents.isDestroyed()) {
      win.webContents.send('oc:server', getStatus())
    }
  })

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    if (isInternalUrl(url)) return
    event.preventDefault()
    openExternal(url)
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
  const [existing] = BrowserWindow.getAllWindows()
  if (!existing) return
  if (existing.isMinimized()) existing.restore()
  existing.focus()
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

  app.whenReady().then(() => {
    app.setAppUserModelId('dev.opencode.desktop')

    registerIpc()
    createWindow()

    void startServer().then((serverStatus) => {
      broadcast('oc:server', serverStatus)
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    if (shuttingDown) return
    shuttingDown = true
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
