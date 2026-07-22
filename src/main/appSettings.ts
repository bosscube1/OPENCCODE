import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, globalShortcut } from 'electron'

export const APP_SETTINGS_VERSION = 1
export const DEFAULT_APP_SETTINGS: Readonly<AppSettings> = Object.freeze({
  closeToTray: true,
  globalShortcut: 'Ctrl+Alt+Space'
})

export type AppSettings = {
  closeToTray: boolean
  globalShortcut: string
}

export type AppSettingsResult = {
  settings: AppSettings
  shortcutRegistered: boolean
  shortcutError?: string
}

type AppSettingsFile = {
  version: typeof APP_SETTINGS_VERSION
  settings: AppSettings
}

export type GlobalShortcutAdapter = {
  register(accelerator: string, callback: () => void): boolean
  unregister(accelerator: string): void
}

export type AppSettingsController = {
  get(): AppSettingsResult
  set(patch: unknown): AppSettingsResult
  dispose(): void
}

export type AppSettingsOptions = {
  /** Defaults to Electron's userData directory. Primarily injectable for tests. */
  userDataPath?: string
  shortcut?: GlobalShortcutAdapter
  onShortcut: () => void
}

function cloneSettings(settings: AppSettings): AppSettings {
  return { ...settings }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateSettings(value: unknown): AppSettings | null {
  if (!isRecord(value)) return null
  if (typeof value.closeToTray !== 'boolean') return null
  if (typeof value.globalShortcut !== 'string') return null
  const accelerator = value.globalShortcut.trim()
  if (accelerator.length === 0 || accelerator.length > 128) return null
  return { closeToTray: value.closeToTray, globalShortcut: accelerator }
}

function validatePatch(value: unknown): Partial<AppSettings> {
  if (!isRecord(value)) throw new Error('Invalid app settings patch: expected an object.')

  const allowed = new Set<keyof AppSettings>(['closeToTray', 'globalShortcut'])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key as keyof AppSettings)) {
      throw new Error(`Invalid app settings patch: unknown setting "${key}".`)
    }
  }

  const patch: Partial<AppSettings> = {}
  if ('closeToTray' in value) {
    if (typeof value.closeToTray !== 'boolean') {
      throw new Error('Invalid app settings patch: closeToTray must be a boolean.')
    }
    patch.closeToTray = value.closeToTray
  }
  if ('globalShortcut' in value) {
    if (typeof value.globalShortcut !== 'string') {
      throw new Error('Invalid app settings patch: globalShortcut must be a string.')
    }
    const accelerator = value.globalShortcut.trim()
    if (accelerator.length === 0 || accelerator.length > 128) {
      throw new Error('Invalid app settings patch: globalShortcut must be 1-128 characters.')
    }
    patch.globalShortcut = accelerator
  }
  return patch
}

function loadSettings(path: string): AppSettings | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!isRecord(parsed) || parsed.version !== APP_SETTINGS_VERSION) return null
    return validateSettings(parsed.settings)
  } catch {
    return null
  }
}

function saveSettings(path: string, settings: AppSettings): void {
  const document: AppSettingsFile = {
    version: APP_SETTINGS_VERSION,
    settings
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
}

function shortcutFailure(accelerator: string, error?: unknown): string {
  const detail = error instanceof Error && error.message.trim() ? ` ${error.message.trim()}` : ''
  return `Unable to register global shortcut "${accelerator}"; it may be invalid or already in use.${detail}`
}

/**
 * Owns persisted settings and exactly one registered accelerator.
 * Create this only after `app.whenReady()` has resolved.
 */
export function createAppSettingsController(options: AppSettingsOptions): AppSettingsController {
  const storagePath = join(options.userDataPath ?? app.getPath('userData'), 'app-settings.json')
  const shortcut = options.shortcut ?? globalShortcut
  let settings = loadSettings(storagePath) ?? cloneSettings(DEFAULT_APP_SETTINGS)
  let registeredAccelerator: string | null = null
  let shortcutError: string | undefined

  // Ensure a missing, corrupt, or old-version file is replaced with the current schema.
  try {
    saveSettings(storagePath, settings)
  } catch {
    // Settings remain usable for this run even if persistence is temporarily unavailable.
  }

  const registerConfiguredShortcut = (): void => {
    shortcutError = undefined
    try {
      const registered = shortcut.register(settings.globalShortcut, options.onShortcut)
      if (registered) {
        registeredAccelerator = settings.globalShortcut
      } else {
        registeredAccelerator = null
        shortcutError = shortcutFailure(settings.globalShortcut)
      }
    } catch (error) {
      registeredAccelerator = null
      shortcutError = shortcutFailure(settings.globalShortcut, error)
    }
  }

  const result = (): AppSettingsResult => ({
    settings: cloneSettings(settings),
    shortcutRegistered: registeredAccelerator === settings.globalShortcut,
    ...(shortcutError ? { shortcutError } : {})
  })

  registerConfiguredShortcut()

  return {
    get: result,
    set(value: unknown): AppSettingsResult {
      const patch = validatePatch(value)
      const next = { ...settings, ...patch }
      saveSettings(storagePath, next)

      const shortcutChanged = next.globalShortcut !== settings.globalShortcut
      settings = next
      if (shortcutChanged) {
        if (registeredAccelerator) shortcut.unregister(registeredAccelerator)
        registeredAccelerator = null
        registerConfiguredShortcut()
      }
      return result()
    },
    dispose(): void {
      if (registeredAccelerator) shortcut.unregister(registeredAccelerator)
      registeredAccelerator = null
      shortcutError = undefined
    }
  }
}
