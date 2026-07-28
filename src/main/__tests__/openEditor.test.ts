import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Mutable state read by the mocked modules below. vi.hoisted so it exists before the hoisted
// vi.mock factories run (see https://vitest.dev/api/vi.html#vi-hoisted).
const state = vi.hoisted(() => ({
  openExternal: vi.fn(async (_url: string) => {})
}))

vi.mock('electron', () => ({
  shell: { openExternal: state.openExternal }
}))

import { openEditor, register } from '../openEditor'

describe('openEditor', () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'opencode-openeditor-'))
    mkdirSync(join(projectDir, 'src'), { recursive: true })
    writeFileSync(join(projectDir, 'src', 'foo.ts'), 'export {}', 'utf8')
    state.openExternal.mockClear()
  })

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true })
  })

  it('opens a vscode:// deep link for a contained relative path', async () => {
    await openEditor({ directory: projectDir, path: 'src/foo.ts' })
    expect(state.openExternal).toHaveBeenCalledTimes(1)
    const url = state.openExternal.mock.calls[0][0] as string
    expect(url.startsWith('vscode://file/')).toBe(true)
    expect(url).toContain('src/foo.ts')
  })

  it('appends :line and :line:column when provided', async () => {
    await openEditor({ directory: projectDir, path: 'src/foo.ts', line: 12 })
    expect(state.openExternal.mock.calls[0][0]).toMatch(/:12$/)

    await openEditor({ directory: projectDir, path: 'src/foo.ts', line: 12, column: 3 })
    expect(state.openExternal.mock.calls[1][0]).toMatch(/:12:3$/)
  })

  it('never emits anything but an allowlisted scheme', async () => {
    await openEditor({ directory: projectDir, path: 'src/foo.ts' })
    const url = state.openExternal.mock.calls[0][0] as string
    const scheme = url.split('://')[0]
    expect(['vscode', 'vscode-insiders', 'cursor']).toContain(scheme)
  })

  it('rejects a path that escapes the project directory', async () => {
    await expect(openEditor({ directory: projectDir, path: '../outside.ts' })).rejects.toThrow(/strictly inside/i)
    expect(state.openExternal).not.toHaveBeenCalled()
  })

  it('rejects an absolute path outside the project directory', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'opencode-openeditor-outside-'))
    try {
      await expect(
        openEditor({ directory: projectDir, path: join(outside, 'evil.ts') })
      ).rejects.toThrow(/strictly inside/i)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
    expect(state.openExternal).not.toHaveBeenCalled()
  })

  it('rejects when directory is the empty string (IPC boundary requires it explicitly)', async () => {
    await expect(openEditor({ directory: '', path: 'src/foo.ts' })).rejects.toThrow()
    expect(state.openExternal).not.toHaveBeenCalled()
  })

  describe('register', () => {
    it('wires the oc:openEditor IPC channel and validates arguments', async () => {
      const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
      const ipc = {
        removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
        handle: vi.fn((channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
          handlers.set(channel, fn)
        })
      }

      register(ipc as unknown as import('electron').IpcMain)
      expect(ipc.handle).toHaveBeenCalledWith('oc:openEditor', expect.any(Function))

      const handler = handlers.get('oc:openEditor')!
      await handler({}, { directory: projectDir, path: 'src/foo.ts', line: 4 })
      expect(state.openExternal).toHaveBeenCalledTimes(1)

      await expect(handler({}, { directory: projectDir, path: 123 })).rejects.toThrow(
        /path must be a non-empty string/i
      )
      await expect(
        handler({}, { directory: projectDir, path: 'src/foo.ts', line: -1 })
      ).rejects.toThrow(/line must be a positive integer/i)
      await expect(handler({}, null)).rejects.toThrow(/must be an object/i)
      await expect(handler({}, { path: 'src/foo.ts' })).rejects.toThrow(/directory must be a non-empty string/i)
    })
  })
})
