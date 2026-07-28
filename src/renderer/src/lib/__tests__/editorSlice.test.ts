import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { OpencodeApi } from '../slices/api'
import type { AppState, SetState, GetState } from '../slices/types'
import type { FileContent, FileDiff } from '../types'

vi.mock('../slices/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../slices/api')>()
  return { ...actual, api: vi.fn() }
})

import { api } from '../slices/api'
import { createEditorSlice, type EditorSlice } from '../slices/editorSlice'
import { parseUnifiedDiff } from '../hunks'

const mockApi = vi.mocked(api)

function createStore(): { get: GetState; set: SetState } {
  let state = {} as AppState
  const set = ((partial: unknown) => {
    const patch = typeof partial === 'function' ? (partial as (s: AppState) => Partial<AppState>)(state) : partial
    state = { ...state, ...(patch as Partial<AppState>) }
  }) as SetState
  const get: GetState = () => state
  return { get, set }
}

/**
 * Installs the slice's own defaults first, then layers the test's overrides on top —
 * calling `set(slice)` *after* the overrides would clobber them with the slice's
 * initial values (openFile: null, acceptedHunkIds: [], etc).
 */
function setup(overrides: Partial<AppState> = {}): { get: GetState; slice: EditorSlice } {
  const { get, set } = createStore()
  const slice = createEditorSlice(set, get)
  set(slice)
  set(overrides)
  return { get, slice }
}

function content(overrides: Partial<FileContent> = {}): FileContent {
  return { path: 'a.ts', text: 'hello', bytes: 5, truncated: false, sha: 'sha-1', language: 'typescript', ...overrides }
}

function fakeApi(overrides: { fs?: Partial<OpencodeApi['fs']>; git?: Partial<OpencodeApi['git']> }): OpencodeApi {
  return {
    fs: { read: vi.fn(), write: vi.fn(), tree: vi.fn(async () => []), ...overrides.fs },
    git: { diff: vi.fn(), ...overrides.git }
  } as unknown as OpencodeApi
}

describe('editorSlice', () => {
  beforeEach(() => {
    mockApi.mockReset()
  })

  describe('openPath', () => {
    it('requires a directory first', async () => {
      const { get, slice } = setup({ directory: null })

      await slice.openPath('a.ts')
      expect(get().error).toBe('Pick a project folder first.')
      expect(get().openFile).toBeNull()
    })

    it('loads the file and resets dirty/accepted-hunk state', async () => {
      const c = content()
      mockApi.mockReturnValue(
        fakeApi({
          fs: { read: vi.fn(async () => c) },
          git: { diff: vi.fn(async () => ({ path: 'a.ts', binary: false, truncated: false, hunks: [] })) }
        })
      )

      const { get, slice } = setup({ directory: '/proj', openFileDirty: true, acceptedHunkIds: ['x'] })

      await slice.openPath('a.ts')
      expect(get().openFile).toEqual(c)
      expect(get().openFileDirty).toBe(false)
      expect(get().acceptedHunkIds).toEqual([])
    })

    it('treats a failed diff fetch as "no diff" rather than an error (untracked/clean file)', async () => {
      const c = content()
      mockApi.mockReturnValue(
        fakeApi({
          fs: { read: vi.fn(async () => c) },
          git: {
            diff: vi.fn(async () => {
              throw new Error('no diff for clean file')
            })
          }
        })
      )

      const { get, slice } = setup({ directory: '/proj', error: null })

      await slice.openPath('a.ts')
      expect(get().openFileDiff).toBeNull()
      expect(get().error).toBeNull() // not surfaced as an error banner
      expect(get().openFile).toEqual(c)
    })

    it('sets error and does not attempt a diff fetch when the file read fails', async () => {
      const diffFn = vi.fn()
      mockApi.mockReturnValue(
        fakeApi({
          fs: {
            read: vi.fn(async () => {
              throw new Error('file not found')
            })
          },
          git: { diff: diffFn }
        })
      )

      const { get, slice } = setup({ directory: '/proj' })

      await slice.openPath('missing.ts')
      expect(get().error).toBe('file not found')
      expect(diffFn).not.toHaveBeenCalled()
    })
  })

  describe('setOpenFileText', () => {
    // Dirty means "differs from disk", not "differs from the previous keystroke" —
    // the latter clears the flag whenever an edit repeats the text before it, while
    // the buffer still differs from the file. Hence the separate baseline.
    it('marks the buffer dirty only when the text actually differs from the loaded file', () => {
      const { get, slice } = setup({
        openFile: content({ text: 'hello' }),
        openFileDirty: false,
        openFileBaseText: 'hello'
      })

      slice.setOpenFileText('hello world')
      expect(get().openFileDirty).toBe(true)
      expect(get().openFile!.text).toBe('hello world')

      slice.setOpenFileText('hello')
      expect(get().openFileDirty).toBe(false)
    })

    it('is a no-op when no file is open', () => {
      const { get, slice } = setup({ openFile: null, openFileDirty: false })

      slice.setOpenFileText('anything')
      expect(get().openFile).toBeNull()
      expect(get().openFileDirty).toBe(false)
    })
  })

  describe('saveOpenFile', () => {
    it('writes the buffer, updates the sha, clears dirty, and refreshes git', async () => {
      const writeFn = vi.fn(async () => ({ sha: 'sha-2' }))
      mockApi.mockReturnValue(fakeApi({ fs: { write: writeFn } }))

      const refreshGit = vi.fn(async () => {})
      const { get, slice } = setup({
        directory: '/proj',
        openFile: content({ text: 'changed' }),
        openFileDirty: true,
        refreshGit
      })

      await slice.saveOpenFile()
      expect(writeFn).toHaveBeenCalledWith({ directory: '/proj', path: 'a.ts', text: 'changed', baseSha: 'sha-1' })
      expect(get().openFile!.sha).toBe('sha-2')
      expect(get().openFileDirty).toBe(false)
      expect(refreshGit).toHaveBeenCalledTimes(1)
    })

    it('turns a stale-sha conflict into a friendly message and rethrows', async () => {
      mockApi.mockReturnValue(
        fakeApi({
          fs: {
            write: vi.fn(async () => {
              throw new Error('sha mismatch: file changed on disk')
            })
          }
        })
      )

      const refreshGit = vi.fn(async () => {})
      const { get, slice } = setup({ directory: '/proj', openFile: content(), openFileDirty: true, refreshGit })

      await expect(slice.saveOpenFile()).rejects.toThrow()
      expect(get().error).toMatch(/changed on disk since you opened it/)
      expect(get().openFileDirty).toBe(true) // the failed write must not have cleared dirty
      expect(refreshGit).not.toHaveBeenCalled()
    })

    it('passes an unrelated write failure through verbatim', async () => {
      mockApi.mockReturnValue(
        fakeApi({
          fs: {
            write: vi.fn(async () => {
              throw new Error('disk full')
            })
          }
        })
      )

      const { get, slice } = setup({ directory: '/proj', openFile: content(), openFileDirty: true })

      await expect(slice.saveOpenFile()).rejects.toThrow('disk full')
      expect(get().error).toBe('disk full')
    })

    it('is a no-op with no open file', async () => {
      const writeFn = vi.fn()
      mockApi.mockReturnValue(fakeApi({ fs: { write: writeFn } }))
      const { slice } = setup({ directory: '/proj', openFile: null })

      await slice.saveOpenFile()
      expect(writeFn).not.toHaveBeenCalled()
    })
  })

  describe('toggleHunk', () => {
    it('adds then removes a hunk id', () => {
      const { get, slice } = setup({ acceptedHunkIds: [] })

      slice.toggleHunk('1-1')
      expect(get().acceptedHunkIds).toEqual(['1-1'])
      slice.toggleHunk('1-1')
      expect(get().acceptedHunkIds).toEqual([])
    })
  })

  describe('applyAcceptedHunks', () => {
    const diffText = ['--- a/a.ts', '+++ b/a.ts', '@@ -1,1 +1,1 @@', '-hello', '+HELLO', ''].join('\n')
    const diff: FileDiff = parseUnifiedDiff(diffText)

    it('is a no-op when there is nothing to apply', async () => {
      const writeFn = vi.fn()
      mockApi.mockReturnValue(fakeApi({ fs: { write: writeFn } }))

      const { slice } = setup({ directory: '/proj', openFile: content(), openFileDiff: diff, acceptedHunkIds: [] })

      await slice.applyAcceptedHunks()
      expect(writeFn).not.toHaveBeenCalled()
    })

    it('refuses to apply hunks of a truncated diff', async () => {
      const writeFn = vi.fn()
      mockApi.mockReturnValue(fakeApi({ fs: { write: writeFn } }))

      const truncated: FileDiff = { ...diff, truncated: true }
      const { get, slice } = setup({
        directory: '/proj',
        openFile: content(),
        openFileDiff: truncated,
        acceptedHunkIds: [diff.hunks[0]!.id]
      })

      await slice.applyAcceptedHunks()
      expect(writeFn).not.toHaveBeenCalled()
      expect(get().error).toMatch(/partial diff/)
    })

    it('sets a helpful error when the diff no longer matches the buffer (stale context)', async () => {
      const writeFn = vi.fn()
      mockApi.mockReturnValue(fakeApi({ fs: { write: writeFn } }))

      // The buffer text no longer contains "hello" — the diff context is stale.
      const { get, slice } = setup({
        directory: '/proj',
        openFile: content({ text: 'totally different' }),
        openFileDiff: diff,
        acceptedHunkIds: [diff.hunks[0]!.id]
      })

      await slice.applyAcceptedHunks()
      expect(writeFn).not.toHaveBeenCalled()
      expect(get().error).toMatch(/file changed since this diff was taken/)
    })

    it('applies the hunk, writes the file, reopens it, and refreshes git', async () => {
      const writeFn = vi.fn(async () => ({ sha: 'sha-applied' }))
      const readFn = vi.fn(async () => content({ text: 'HELLO\n', sha: 'sha-applied' }))
      mockApi.mockReturnValue(
        fakeApi({
          fs: { write: writeFn, read: readFn },
          git: { diff: vi.fn(async () => ({ path: 'a.ts', binary: false, truncated: false, hunks: [] })) }
        })
      )

      const refreshGit = vi.fn(async () => {})
      // The diff has no "\ No newline" marker on either side, so it assumes a trailing
      // newline on both — match that here rather than fighting it.
      const { get, slice } = setup({
        directory: '/proj',
        openFile: content({ text: 'hello\n' }),
        openFileDiff: diff,
        acceptedHunkIds: [diff.hunks[0]!.id],
        refreshGit
      })

      await slice.applyAcceptedHunks()

      expect(writeFn).toHaveBeenCalledWith({ directory: '/proj', path: 'a.ts', text: 'HELLO\n', baseSha: 'sha-1' })
      // openPath is called again afterwards to reload the persisted state.
      expect(readFn).toHaveBeenCalledWith('/proj', 'a.ts')
      expect(refreshGit).toHaveBeenCalledTimes(1)
      expect(get().acceptedHunkIds).toEqual([])
    })
  })

  describe('closeFile', () => {
    it('clears all editor state', () => {
      const { get, slice } = setup({
        openFile: content(),
        openFileDirty: true,
        openFileDiff: { path: 'a.ts', binary: false, truncated: false, hunks: [] },
        acceptedHunkIds: ['1-1']
      })

      slice.closeFile()
      expect(get().openFile).toBeNull()
      expect(get().openFileDirty).toBe(false)
      expect(get().openFileDiff).toBeNull()
      expect(get().acceptedHunkIds).toEqual([])
    })
  })
})
