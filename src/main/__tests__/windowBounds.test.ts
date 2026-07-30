import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// attach() is covered by manual smoke test and needs a real BrowserWindow event emitter.
const state = vi.hoisted(() => ({
  getPath: vi.fn((_type: string) => tmpdir()),
  getAllDisplays: vi.fn(() => [])
}))

vi.mock('electron', () => ({
  app: { getPath: state.getPath },
  screen: { getAllDisplays: state.getAllDisplays }
}))

import { createBoundsStore, type WindowBounds } from '../windowBounds'

describe('windowBounds', () => {
  let tempDir: string
  const defaults: WindowBounds = { x: 100, y: 100, width: 800, height: 600, maximized: false }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opencode-windowbounds-'))
    state.getPath.mockClear()
    state.getAllDisplays.mockClear()
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('round trip: save and load returns the same bounds', () => {
    const store = createBoundsStore({
      fileName: 'window-bounds.json',
      defaults,
      minWidth: 300,
      minHeight: 200,
      userDataPath: tempDir,
      // A real display is required for any assertion that a position SURVIVES
      // load(): visibility validation runs after the per-field fallback, and
      // an empty display list means nothing is on-screen, so every position
      // collapses to the -1/-1 sentinel.
      displays: () => [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }]
    })

    const bounds: WindowBounds = { x: 200, y: 150, width: 1000, height: 700, maximized: false }
    store.save(bounds)
    const loaded = store.load()

    expect(loaded).toEqual(bounds)
  })

  it('persists the bounds file at userDataPath/fileName', () => {
    const store = createBoundsStore({
      fileName: 'window-bounds.json',
      defaults,
      minWidth: 300,
      minHeight: 200,
      userDataPath: tempDir,
      displays: () => []
    })

    const bounds: WindowBounds = { x: 200, y: 150, width: 1000, height: 700, maximized: true }
    store.save(bounds)

    const filePath = join(tempDir, 'window-bounds.json')
    const stored = JSON.parse(readFileSync(filePath, 'utf8'))
    expect(stored).toEqual(bounds)
  })

  it('returns defaults when the file does not exist', () => {
    const store = createBoundsStore({
      fileName: 'window-bounds.json',
      defaults,
      minWidth: 300,
      minHeight: 200,
      userDataPath: tempDir,
      displays: () => []
    })

    const loaded = store.load()
    expect(loaded).toEqual(defaults)
  })

  it('returns defaults on corrupt JSON without throwing', () => {
    const filePath = join(tempDir, 'window-bounds.json')
    writeFileSync(filePath, '{{{', 'utf8')

    const store = createBoundsStore({
      fileName: 'window-bounds.json',
      defaults,
      minWidth: 300,
      minHeight: 200,
      userDataPath: tempDir,
      displays: () => []
    })

    const loaded = store.load()
    expect(loaded).toEqual(defaults)
  })

  it('falls back to defaults for fields with wrong types', () => {
    const filePath = join(tempDir, 'window-bounds.json')
    writeFileSync(filePath, JSON.stringify({
      x: 'not a number',
      y: 50,
      width: 'wide',
      height: 600,
      maximized: 'yes'
    }), 'utf8')

    const store = createBoundsStore({
      fileName: 'window-bounds.json',
      defaults,
      minWidth: 300,
      minHeight: 200,
      userDataPath: tempDir,
      // On-screen display so the recovered x/y are not overwritten by the
      // off-screen sentinel before these assertions see them.
      displays: () => [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }]
    })

    const loaded = store.load()
    expect(loaded.x).toBe(defaults.x)
    expect(loaded.y).toBe(50)
    expect(loaded.width).toBe(defaults.width)
    expect(loaded.height).toBe(600)
    expect(loaded.maximized).toBe(defaults.maximized)
  })

  it('clamps width below minWidth to minWidth', () => {
    const filePath = join(tempDir, 'window-bounds.json')
    writeFileSync(filePath, JSON.stringify({
      x: 100,
      y: 100,
      width: 100,
      height: 600,
      maximized: false
    }), 'utf8')

    const store = createBoundsStore({
      fileName: 'window-bounds.json',
      defaults,
      minWidth: 300,
      minHeight: 200,
      userDataPath: tempDir,
      displays: () => []
    })

    const loaded = store.load()
    expect(loaded.width).toBe(300)
  })

  it('clamps height below minHeight to minHeight', () => {
    const filePath = join(tempDir, 'window-bounds.json')
    writeFileSync(filePath, JSON.stringify({
      x: 100,
      y: 100,
      width: 800,
      height: 50,
      maximized: false
    }), 'utf8')

    const store = createBoundsStore({
      fileName: 'window-bounds.json',
      defaults,
      minWidth: 300,
      minHeight: 200,
      userDataPath: tempDir,
      displays: () => []
    })

    const loaded = store.load()
    expect(loaded.height).toBe(200)
  })

  it('returns off-screen position as -1, -1 with dimensions preserved', () => {
    const filePath = join(tempDir, 'window-bounds.json')
    writeFileSync(filePath, JSON.stringify({
      x: 9000,
      y: 9000,
      width: 800,
      height: 600,
      maximized: false
    }), 'utf8')

    const store = createBoundsStore({
      fileName: 'window-bounds.json',
      defaults,
      minWidth: 300,
      minHeight: 200,
      userDataPath: tempDir,
      displays: () => [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }]
    })

    const loaded = store.load()
    expect(loaded.x).toBe(-1)
    expect(loaded.y).toBe(-1)
    expect(loaded.width).toBe(800)
    expect(loaded.height).toBe(600)
    expect(loaded.maximized).toBe(false)
  })

  it('returns on-screen position unchanged', () => {
    const filePath = join(tempDir, 'window-bounds.json')
    const savedBounds = { x: 100, y: 100, width: 800, height: 600, maximized: false }
    writeFileSync(filePath, JSON.stringify(savedBounds), 'utf8')

    const store = createBoundsStore({
      fileName: 'window-bounds.json',
      defaults,
      minWidth: 300,
      minHeight: 200,
      userDataPath: tempDir,
      displays: () => [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }]
    })

    const loaded = store.load()
    expect(loaded).toEqual(savedBounds)
  })

  it('treats -1, -1 as a sentinel and never calls displays', () => {
    const filePath = join(tempDir, 'window-bounds.json')
    writeFileSync(filePath, JSON.stringify({
      x: -1,
      y: -1,
      width: 800,
      height: 600,
      maximized: false
    }), 'utf8')

    const displays = vi.fn(() => [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }])
    const store = createBoundsStore({
      fileName: 'window-bounds.json',
      defaults,
      minWidth: 300,
      minHeight: 200,
      userDataPath: tempDir,
      displays
    })

    const loaded = store.load()
    expect(loaded.x).toBe(-1)
    expect(loaded.y).toBe(-1)
    expect(displays).toHaveBeenCalledTimes(0)
  })

  it('swallows errors on unwritable path instead of throwing', () => {
    // Create a file instead of a directory as the parent
    const filePath = join(tempDir, 'not-a-dir')
    writeFileSync(filePath, 'I am a file', 'utf8')

    const store = createBoundsStore({
      fileName: 'nested/window-bounds.json',
      defaults,
      minWidth: 300,
      minHeight: 200,
      userDataPath: filePath,
      displays: () => []
    })

    const bounds: WindowBounds = { x: 200, y: 150, width: 1000, height: 700, maximized: false }

    expect(() => store.save(bounds)).not.toThrow()
  })

  it('accepts custom display information and uses it for on-screen checks', () => {
    const filePath = join(tempDir, 'window-bounds.json')
    writeFileSync(filePath, JSON.stringify({
      x: 1920,
      y: 0,
      width: 800,
      height: 600,
      maximized: false
    }), 'utf8')

    const store = createBoundsStore({
      fileName: 'window-bounds.json',
      defaults,
      minWidth: 300,
      minHeight: 200,
      userDataPath: tempDir,
      displays: () => [
        { bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
        { bounds: { x: 1920, y: 0, width: 1920, height: 1080 } }
      ]
    })

    const loaded = store.load()
    expect(loaded.x).toBe(1920)
    expect(loaded.y).toBe(0)
  })
})
