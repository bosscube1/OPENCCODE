import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Mutable state read by the mocked 'electron' module below. vi.hoisted so it exists before the
// hoisted vi.mock factory runs (see https://vitest.dev/api/vi.html#vi-hoisted).
const state = vi.hoisted(() => ({
  userDataDir: ''
}))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? state.userDataDir : tmpdir()),
    on: vi.fn()
  },
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn(), on: vi.fn() },
  shell: { openExternal: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.from(''),
    decryptString: () => ''
  },
  webContents: {}
}))

import { ipcMain } from 'electron'
import { registerIpc } from '../ipc'

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>

function findHandler(channel: string): Handler {
  const handle = ipcMain.handle as unknown as { mock: { calls: [string, Handler][] } }
  const call = handle.mock.calls.find(([c]) => c === channel)
  if (!call) throw new Error(`handler for ${channel} was never registered`)
  return call[1]
}

describe('oc:clipboard:saveImage', () => {
  let userDataDir: string
  let saveClipboardImage: Handler

  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'opencode-clipboard-'))
    state.userDataDir = userDataDir
    ;(ipcMain.handle as unknown as { mockClear: () => void }).mockClear()
    registerIpc()
    saveClipboardImage = findHandler('oc:clipboard:saveImage')
  })

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true })
  })

  it('writes the decoded bytes under userData/pasted-images and returns the path', async () => {
    const data = Buffer.from('hello image bytes').toString('base64')
    const path = (await saveClipboardImage({}, { data, ext: 'png' })) as string
    expect(path.startsWith(join(userDataDir, 'pasted-images'))).toBe(true)
    expect(path.endsWith('.png')).toBe(true)
    const files = readdirSync(join(userDataDir, 'pasted-images'))
    expect(files).toHaveLength(1)
  })

  it('rejects a non-allowlisted extension, including svg', async () => {
    const data = Buffer.from('x').toString('base64')
    await expect(saveClipboardImage({}, { data, ext: 'svg' })).rejects.toThrow(/ext/i)
    await expect(saveClipboardImage({}, { data, ext: 'bmp' })).rejects.toThrow(/ext/i)
  })

  it('rejects decoded data over the 5 MiB cap', async () => {
    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1, 1).toString('base64')
    await expect(saveClipboardImage({}, { data: oversized, ext: 'png' })).rejects.toThrow(/limit/i)
  })

  it('accepts data exactly at the 5 MiB cap', async () => {
    const exact = Buffer.alloc(5 * 1024 * 1024, 1).toString('base64')
    const path = (await saveClipboardImage({}, { data: exact, ext: 'jpg' })) as string
    expect(path.endsWith('.jpg')).toBe(true)
  })

  it('generates the filename in main and ignores any renderer-supplied name/path fields', async () => {
    const data = Buffer.from('hi').toString('base64')
    const path = (await saveClipboardImage(
      {},
      { data, ext: 'gif', filename: '../../evil.gif', name: 'evil', path: 'C:\\evil.gif' }
    )) as string
    expect(path).not.toContain('evil')
    expect(path.startsWith(join(userDataDir, 'pasted-images'))).toBe(true)
    expect(path.endsWith('.gif')).toBe(true)
  })

  it('produces distinct filenames for back-to-back pastes', async () => {
    const data = Buffer.from('hi').toString('base64')
    const first = (await saveClipboardImage({}, { data, ext: 'webp' })) as string
    const second = (await saveClipboardImage({}, { data, ext: 'webp' })) as string
    expect(first).not.toEqual(second)
  })
})
