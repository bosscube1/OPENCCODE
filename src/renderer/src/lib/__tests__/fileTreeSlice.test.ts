import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { OpencodeApi } from '../slices/api'
import type { AppState, SetState, GetState } from '../slices/types'
import type { FileNode } from '../types'

vi.mock('../slices/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../slices/api')>()
  return { ...actual, api: vi.fn() }
})

import { api } from '../slices/api'
import { createFileTreeSlice, type FileTreeSlice } from '../slices/fileTreeSlice'

const mockApi = vi.mocked(api)

/** Minimal harness mirroring zustand's set/get shape, without pulling in zustand itself. */
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
 * initial values (empty treeRoot, empty treeExpanded, etc).
 */
function setup(overrides: Partial<AppState> = {}): { get: GetState; slice: FileTreeSlice } {
  const { get, set } = createStore()
  const slice = createFileTreeSlice(set, get)
  set(slice)
  set(overrides)
  return { get, slice }
}

function node(path: string, kind: 'file' | 'dir' = 'file'): FileNode {
  return { name: path.split('/').pop()!, path, kind, gitStatus: null, touched: false }
}

function fakeApi(fsTree: OpencodeApi['fs']['tree']): OpencodeApi {
  return { fs: { tree: fsTree } } as unknown as OpencodeApi
}

describe('fileTreeSlice', () => {
  beforeEach(() => {
    mockApi.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('refreshTree debounce', () => {
    it('collapses a burst of calls into a single sweep', async () => {
      vi.useFakeTimers()
      const treeFn = vi.fn(async () => [] as FileNode[])
      mockApi.mockReturnValue(fakeApi(treeFn))

      const { slice } = setup({ directory: '/proj' })

      // Each call clears the previous call's pending setTimeout, so only the LAST
      // call's returned promise ever resolves — the earlier ones hang forever by
      // design. Only await the final one.
      slice.refreshTree()
      slice.refreshTree()
      const last = slice.refreshTree()

      // Not yet fired — still within the debounce window.
      await vi.advanceTimersByTimeAsync(299)
      expect(treeFn).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      await last

      // One sweep only, for the root level (no expanded dirs).
      expect(treeFn).toHaveBeenCalledTimes(1)
      expect(treeFn).toHaveBeenCalledWith('/proj', undefined)
    })

    it('restarts the window on each call — only the final burst schedules a sweep', async () => {
      vi.useFakeTimers()
      const treeFn = vi.fn(async () => [] as FileNode[])
      mockApi.mockReturnValue(fakeApi(treeFn))

      const { slice } = setup({ directory: '/proj' })

      slice.refreshTree()
      await vi.advanceTimersByTimeAsync(250)
      slice.refreshTree() // resets the 300ms clock
      await vi.advanceTimersByTimeAsync(250)
      expect(treeFn).not.toHaveBeenCalled() // 250+250 > 300 but the clock was reset partway

      await vi.advanceTimersByTimeAsync(50)
      expect(treeFn).toHaveBeenCalledTimes(1)
    })
  })

  it('refetches the root plus every expanded directory, and expansion state survives the sweep', async () => {
    vi.useFakeTimers()
    const treeFn = vi.fn(async (_dir: string, path?: string) => {
      if (path === undefined) return [node('src', 'dir'), node('README.md')]
      if (path === 'src') return [node('src/a.ts'), node('src/b.ts')]
      return []
    })
    mockApi.mockReturnValue(fakeApi(treeFn))

    const { get, slice } = setup({
      directory: '/proj',
      treeExpanded: new Set(['src']),
      treeRoot: [node('src', 'dir'), node('src/a.ts')]
    })

    const p = slice.refreshTree()
    await vi.advanceTimersByTimeAsync(300)
    await p

    // Both levels were fetched together.
    expect(treeFn).toHaveBeenCalledWith('/proj', undefined)
    expect(treeFn).toHaveBeenCalledWith('/proj', 'src')

    // Expansion state is untouched by the refresh.
    expect(get().treeExpanded.has('src')).toBe(true)

    const paths = get().treeRoot.map((n) => n.path).sort()
    expect(paths).toEqual(['README.md', 'src', 'src/a.ts', 'src/b.ts'])
  })

  it('rebuilds treeRoot rather than merging, so a file deleted on the backend disappears', async () => {
    vi.useFakeTimers()
    // The backend no longer reports b.ts — it was deleted by the agent.
    const treeFn = vi.fn(async () => [node('a.ts'), node('README.md')])
    mockApi.mockReturnValue(fakeApi(treeFn))

    const { get, slice } = setup({
      directory: '/proj',
      treeExpanded: new Set<string>(),
      treeRoot: [node('a.ts'), node('b.ts'), node('README.md')]
    })

    const p = slice.refreshTree()
    await vi.advanceTimersByTimeAsync(300)
    await p

    const paths = get().treeRoot.map((n) => n.path).sort()
    expect(paths).toEqual(['README.md', 'a.ts'])
    expect(paths).not.toContain('b.ts')
  })

  it('does nothing when no directory is set', async () => {
    vi.useFakeTimers()
    const treeFn = vi.fn(async () => [] as FileNode[])
    mockApi.mockReturnValue(fakeApi(treeFn))

    const { slice } = setup({ directory: null })

    const p = slice.refreshTree()
    await vi.advanceTimersByTimeAsync(300)
    await p

    expect(treeFn).not.toHaveBeenCalled()
  })

  it('sets error and leaves treeRoot untouched when the sweep fails', async () => {
    vi.useFakeTimers()
    const treeFn = vi.fn(async () => {
      throw new Error('disk unplugged')
    })
    mockApi.mockReturnValue(fakeApi(treeFn))

    const existing = [node('a.ts')]
    const { get, slice } = setup({ directory: '/proj', treeRoot: existing, error: null })

    const p = slice.refreshTree()
    await vi.advanceTimersByTimeAsync(300)
    await p

    expect(get().error).toBe('disk unplugged')
    // A failed sweep must not half-erase the previous tree.
    expect(get().treeRoot).toBe(existing)
  })

  describe('loadTree', () => {
    it('replaces treeRoot entirely for the root level (no path)', async () => {
      const treeFn = vi.fn(async () => [node('new.ts')])
      mockApi.mockReturnValue(fakeApi(treeFn))

      const { get, slice } = setup({ directory: '/proj', treeRoot: [node('old.ts')] })

      await slice.loadTree()
      expect(get().treeRoot.map((n) => n.path)).toEqual(['new.ts'])
      expect(get().treeLoading).toBe(false)
    })

    it('merges into the existing list for a nested path instead of replacing it', async () => {
      const treeFn = vi.fn(async () => [node('src/child.ts')])
      mockApi.mockReturnValue(fakeApi(treeFn))

      const { get, slice } = setup({ directory: '/proj', treeRoot: [node('src', 'dir')] })

      await slice.loadTree('src')
      const paths = get().treeRoot.map((n) => n.path).sort()
      expect(paths).toEqual(['src', 'src/child.ts'])
    })
  })

  describe('toggleTreeDir', () => {
    it('collapsing removes the path from treeExpanded without refetching', async () => {
      const treeFn = vi.fn(async () => [] as FileNode[])
      mockApi.mockReturnValue(fakeApi(treeFn))

      const { get, slice } = setup({ directory: '/proj', treeExpanded: new Set(['src']), treeRoot: [node('src', 'dir')] })

      await slice.toggleTreeDir('src')
      expect(get().treeExpanded.has('src')).toBe(false)
      expect(treeFn).not.toHaveBeenCalled()
    })

    it('expanding an unloaded dir fetches its children and merges them in', async () => {
      const treeFn = vi.fn(async () => [node('src/a.ts')])
      mockApi.mockReturnValue(fakeApi(treeFn))

      const { get, slice } = setup({ directory: '/proj', treeRoot: [node('src', 'dir')] })

      await slice.toggleTreeDir('src')
      expect(get().treeExpanded.has('src')).toBe(true)
      expect(treeFn).toHaveBeenCalledWith('/proj', 'src')
      expect(get().treeRoot.map((n) => n.path).sort()).toEqual(['src', 'src/a.ts'])
    })

    it('expanding a dir whose children are already loaded skips the fetch', async () => {
      const treeFn = vi.fn(async () => [] as FileNode[])
      mockApi.mockReturnValue(fakeApi(treeFn))

      const { get, slice } = setup({
        directory: '/proj',
        treeRoot: [node('src', 'dir'), node('src/a.ts')]
      })

      await slice.toggleTreeDir('src')
      expect(treeFn).not.toHaveBeenCalled()
      expect(get().treeExpanded.has('src')).toBe(true)
    })
  })
})
