import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  globalShortcut: {
    register: () => true,
    unregister: () => undefined
  }
}))

import {
  APP_SETTINGS_VERSION,
  createAppSettingsController,
  type GlobalShortcutAdapter
} from '../appSettings'

describe('app settings', () => {
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'opencode-app-settings-'))
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  function shortcutAdapter(registerResult = true): GlobalShortcutAdapter & {
    register: ReturnType<typeof vi.fn<(accelerator: string, callback: () => void) => boolean>>
    unregister: ReturnType<typeof vi.fn<(accelerator: string) => void>>
  } {
    return {
      register: vi.fn<(accelerator: string, callback: () => void) => boolean>(() => registerResult),
      unregister: vi.fn<(accelerator: string) => void>()
    }
  }

  it('writes versioned defaults and registers Ctrl+Alt+Space', () => {
    const shortcut = shortcutAdapter()
    const onShortcut = vi.fn()
    const controller = createAppSettingsController({ userDataPath, shortcut, onShortcut })

    expect(controller.get()).toEqual({
      settings: { closeToTray: true, globalShortcut: 'Ctrl+Alt+Space', showPaidModels: false, ttftMs: 20000, stallMs: 90000, nanogptSubscriptionOnly: true },
      shortcutRegistered: true
    })
    expect(shortcut.register).toHaveBeenCalledWith('Ctrl+Alt+Space', onShortcut)
    expect(JSON.parse(readFileSync(join(userDataPath, 'app-settings.json'), 'utf8'))).toEqual({
      version: APP_SETTINGS_VERSION,
      settings: { closeToTray: true, globalShortcut: 'Ctrl+Alt+Space', showPaidModels: false, ttftMs: 20000, stallMs: 90000, nanogptSubscriptionOnly: true }
    })
  })

  it('persists validated patches and reloads them', () => {
    const firstShortcut = shortcutAdapter()
    const first = createAppSettingsController({
      userDataPath,
      shortcut: firstShortcut,
      onShortcut: vi.fn()
    })

    expect(first.set({ closeToTray: false, globalShortcut: ' Ctrl+Shift+K ' }).settings).toEqual({
      closeToTray: false,
      globalShortcut: 'Ctrl+Shift+K',
      showPaidModels: false,
      ttftMs: 20000,
      stallMs: 90000,
      nanogptSubscriptionOnly: true
    })
    expect(firstShortcut.unregister).toHaveBeenCalledWith('Ctrl+Alt+Space')
    first.dispose()

    const secondShortcut = shortcutAdapter()
    const second = createAppSettingsController({
      userDataPath,
      shortcut: secondShortcut,
      onShortcut: vi.fn()
    })
    expect(second.get().settings).toEqual({
      closeToTray: false,
      globalShortcut: 'Ctrl+Shift+K',
      showPaidModels: false,
      ttftMs: 20000,
      stallMs: 90000,
      nanogptSubscriptionOnly: true
    })
    expect(secondShortcut.register).toHaveBeenCalledWith('Ctrl+Shift+K', expect.any(Function))
  })

  it('rejects invalid values and unknown settings without mutating the file', () => {
    const controller = createAppSettingsController({
      userDataPath,
      shortcut: shortcutAdapter(),
      onShortcut: vi.fn()
    })
    const before = readFileSync(join(userDataPath, 'app-settings.json'), 'utf8')

    expect(() => controller.set({ closeToTray: 'yes' })).toThrow(/closeToTray must be a boolean/)
    expect(() => controller.set({ globalShortcut: '   ' })).toThrow(/1-128 characters/)
    expect(() => controller.set({ madeUp: true })).toThrow(/unknown setting/)
    expect(() => controller.set(null)).toThrow(/expected an object/)
    expect(readFileSync(join(userDataPath, 'app-settings.json'), 'utf8')).toBe(before)
  })

  it('reports shortcut conflicts without throwing or losing settings', () => {
    let conflict = false
    const shortcut: GlobalShortcutAdapter = {
      register: vi.fn(() => !conflict),
      unregister: vi.fn()
    }
    const controller = createAppSettingsController({ userDataPath, shortcut, onShortcut: vi.fn() })
    conflict = true

    const result = controller.set({ globalShortcut: 'Ctrl+Shift+Q' })

    expect(result.settings.globalShortcut).toBe('Ctrl+Shift+Q')
    expect(result.shortcutRegistered).toBe(false)
    expect(result.shortcutError).toMatch(/invalid or already in use/)
    expect(shortcut.unregister).toHaveBeenCalledWith('Ctrl+Alt+Space')
    expect(JSON.parse(readFileSync(join(userDataPath, 'app-settings.json'), 'utf8')).settings)
      .toMatchObject({ globalShortcut: 'Ctrl+Shift+Q' })
  })

  it('recovers corrupt and unsupported-version files to defaults', () => {
    const path = join(userDataPath, 'app-settings.json')
    writeFileSync(path, JSON.stringify({ version: 999, settings: { closeToTray: false } }))

    const controller = createAppSettingsController({
      userDataPath,
      shortcut: shortcutAdapter(),
      onShortcut: vi.fn()
    })

    expect(controller.get().settings).toEqual({
      closeToTray: true,
      globalShortcut: 'Ctrl+Alt+Space',
      showPaidModels: false,
      ttftMs: 20000,
      stallMs: 90000,
      nanogptSubscriptionOnly: true
    })
    expect(JSON.parse(readFileSync(path, 'utf8')).version).toBe(APP_SETTINGS_VERSION)
  })

  it('a registration failure leaves a usable, actionable state instead of a dead controller', () => {
    let conflict = false
    const shortcut = {
      register: vi.fn((_accelerator: string, _callback: () => void) => !conflict),
      unregister: vi.fn((_accelerator: string) => undefined)
    }
    const controller = createAppSettingsController({ userDataPath, shortcut, onShortcut: vi.fn() })
    conflict = true

    const result = controller.set({ globalShortcut: 'Ctrl+Shift+Q' })

    // The controller itself must stay usable: get()/set() keep working, settings are intact.
    expect(() => controller.get()).not.toThrow()
    expect(result.settings.globalShortcut).toBe('Ctrl+Shift+Q')
    // The error names concrete alternatives the user can type into the (already-visible) input.
    expect(result.shortcutError).toMatch(/Try ".+" or ".+" instead\./)

    // Clicking Apply again with the same (still-failing) value retries rather than no-op'ing.
    shortcut.register.mockClear()
    const retried = controller.set({ globalShortcut: 'Ctrl+Shift+Q' })
    expect(shortcut.register).toHaveBeenCalledWith('Ctrl+Shift+Q', expect.any(Function))
    expect(retried.shortcutRegistered).toBe(false)

    // And once the offending app releases the combo, the same Apply click recovers.
    conflict = false
    const recovered = controller.set({ globalShortcut: 'Ctrl+Shift+Q' })
    expect(recovered.shortcutRegistered).toBe(true)
    expect(recovered.shortcutError).toBeUndefined()
  })

  it('falls back to the last-good accelerator when a replacement fails, instead of leaving neither registered', () => {
    const working = new Set(['Ctrl+Alt+Space'])
    const shortcut: GlobalShortcutAdapter = {
      register: vi.fn((accelerator: string) => working.has(accelerator)),
      unregister: vi.fn()
    }
    const controller = createAppSettingsController({ userDataPath, shortcut, onShortcut: vi.fn() })
    expect(controller.get().shortcutRegistered).toBe(true)

    const result = controller.set({ globalShortcut: 'Ctrl+Alt+Q' })

    // The requested accelerator is what's persisted/shown, but it did not register...
    expect(result.settings.globalShortcut).toBe('Ctrl+Alt+Q')
    expect(result.shortcutRegistered).toBe(false)
    // ...because the previous, known-working accelerator was re-registered instead of nothing.
    expect(shortcut.register).toHaveBeenCalledWith('Ctrl+Alt+Space', expect.any(Function))
    expect(result.shortcutError).toMatch(/Kept the previous shortcut "Ctrl\+Alt\+Space" active/)
  })

  it('unregisters the active shortcut on disposal', () => {
    const shortcut = shortcutAdapter()
    const controller = createAppSettingsController({
      userDataPath,
      shortcut,
      onShortcut: vi.fn()
    })

    controller.dispose()

    expect(shortcut.unregister).toHaveBeenCalledWith('Ctrl+Alt+Space')
    expect(controller.get().shortcutRegistered).toBe(false)
  })
})
