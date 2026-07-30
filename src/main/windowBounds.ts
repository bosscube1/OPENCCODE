/**
 * Per-window bounds persistence: position, size, and maximized state.
 *
 * Extracted from index.ts, which owned this inline for the main window only.
 * Each window gets its own store keyed by `fileName`, so a second window
 * cannot overwrite the main window's saved geometry.
 */
import { app, screen, type BrowserWindow } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type WindowBounds = {
  x: number
  y: number
  width: number
  height: number
  maximized: boolean
}

export type BoundsStoreOptions = {
  /** File name under userData, e.g. 'window-state.json' or 'live-window-state.json'. */
  fileName: string
  defaults: WindowBounds
  minWidth: number
  minHeight: number
  /** Defaults to Electron's userData directory. Primarily injectable for tests. */
  userDataPath?: string
  /** Defaults to `screen.getAllDisplays()`. Injectable for tests; called lazily. */
  displays?: () => Array<{ bounds: { x: number; y: number; width: number; height: number } }>
}

export type BoundsStore = {
  /** Read from disk, clamp to the minimums, and drop an off-screen position. */
  load(): WindowBounds
  save(bounds: WindowBounds): void
  /** Register debounced resize/move persistence plus an immediate save on close. */
  attach(win: BrowserWindow): void
}

/** Validate that the saved position is visible on at least one connected display. */
function validateBounds(
  bounds: WindowBounds,
  displays: () => Array<{ bounds: { x: number; y: number; width: number; height: number } }>
): WindowBounds {
  if (bounds.x === -1 && bounds.y === -1) return bounds // use default placement
  const visible = displays().some((display) => {
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

export function createBoundsStore(options: BoundsStoreOptions): BoundsStore {
  const displays = options.displays ?? (() => screen.getAllDisplays())

  const boundsPath = (): string =>
    join(options.userDataPath ?? app.getPath('userData'), options.fileName)

  const load = (): WindowBounds => {
    try {
      const raw = readFileSync(boundsPath(), 'utf8')
      const parsed = JSON.parse(raw) as Partial<WindowBounds>
      const loaded: WindowBounds = {
        x: typeof parsed.x === 'number' ? parsed.x : options.defaults.x,
        y: typeof parsed.y === 'number' ? parsed.y : options.defaults.y,
        width: typeof parsed.width === 'number' ? Math.max(options.minWidth, parsed.width) : options.defaults.width,
        height: typeof parsed.height === 'number' ? Math.max(options.minHeight, parsed.height) : options.defaults.height,
        maximized: typeof parsed.maximized === 'boolean' ? parsed.maximized : options.defaults.maximized
      }
      return validateBounds(loaded, displays)
    } catch {
      return { ...options.defaults }
    }
  }

  const save = (bounds: WindowBounds): void => {
    try {
      const path = boundsPath()
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify(bounds), 'utf8')
    } catch {
      /* best-effort persistence */
    }
  }

  const attach = (win: BrowserWindow): void => {
    let saveBoundsTimer: ReturnType<typeof setTimeout> | null = null

    const currentBounds = (): WindowBounds => {
      const maximized = win.isMaximized()
      // When maximized, save the restored bounds (not the maximized ones)
      const bounds = maximized ? win.getNormalBounds() : win.getBounds()
      return {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        maximized
      }
    }

    const debouncedSave = (): void => {
      if (saveBoundsTimer !== null) clearTimeout(saveBoundsTimer)
      saveBoundsTimer = setTimeout(() => {
        saveBoundsTimer = null
        if (win.isDestroyed()) return
        save(currentBounds())
      }, 300)
    }

    win.on('resize', debouncedSave)
    win.on('move', debouncedSave)
    win.on('close', () => {
      if (win.isDestroyed()) return
      save(currentBounds())
    })
  }

  return { load, save, attach }
}
