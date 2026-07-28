/**
 * The scoped file tree (Phase 1 code surface).
 *
 * `fs:tree` is lazy — one level at a time — so `treeRoot` accumulates every level
 * loaded so far as a flat, path-keyed list. `treeExpanded` tracks which directories
 * the user has opened; the tree component derives nesting by filtering `treeRoot`
 * against `treeExpanded` and parent-path prefixes.
 */

import { api, errText } from './api'
import type { AppState, SetState, GetState } from './types'
import type { FileNode } from '../types'

export type FileTreeSlice = Pick<
  AppState,
  'treeRoot' | 'treeExpanded' | 'treeLoading' | 'loadTree' | 'toggleTreeDir' | 'refreshTree'
>

const REFRESH_DEBOUNCE_MS = 300

let refreshTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Re-fetch the root level and every expanded directory, then rebuild `treeRoot` from
 * only what came back. Rebuilding (rather than merging into the old list) is what makes
 * deletions disappear; the levels are fetched together so a partially-failed refresh
 * leaves the previous tree untouched instead of half-erasing it.
 */
async function doRefreshTree(set: SetState, get: GetState): Promise<void> {
  const { directory, treeExpanded } = get()
  if (!directory) return

  // A collapsed-then-reopened dir refetches through toggleTreeDir, so only currently
  // expanded levels are worth the round-trip.
  const levels = [undefined, ...treeExpanded]
  try {
    const results = await Promise.all(levels.map((path) => api().fs.tree(directory, path)))
    let nodes: FileNode[] = []
    for (const level of results) nodes = mergeNodes(nodes, level ?? [])
    set({ treeRoot: nodes })
  } catch (e) {
    set({ error: errText(e) })
  }
}

/** Merge a freshly-fetched level into the flat node list, deduped by path. */
function mergeNodes(existing: FileNode[], incoming: FileNode[]): FileNode[] {
  const byPath = new Map(existing.map((n) => [n.path, n]))
  for (const n of incoming) byPath.set(n.path, n)
  return Array.from(byPath.values())
}

export function createFileTreeSlice(set: SetState, get: GetState): FileTreeSlice {
  return {
    treeRoot: [],
    treeExpanded: new Set<string>(),
    treeLoading: false,

    async loadTree(path?: string): Promise<void> {
      const { directory } = get()
      if (!directory) return
      set({ treeLoading: true })
      try {
        const nodes = await api().fs.tree(directory, path)
        set((state) => ({
          treeRoot: path ? mergeNodes(state.treeRoot, nodes ?? []) : (nodes ?? [])
        }))
      } catch (e) {
        set({ error: errText(e) })
      } finally {
        set({ treeLoading: false })
      }
    },

    refreshTree(): Promise<void> {
      // Same debounce shape as refreshGit: a burst of agent edits collapses into one
      // sweep ~300ms after the last one.
      return new Promise((resolve) => {
        if (refreshTimer) clearTimeout(refreshTimer)
        refreshTimer = setTimeout(() => {
          refreshTimer = null
          void doRefreshTree(set, get).finally(resolve)
        }, REFRESH_DEBOUNCE_MS)
      })
    },

    async toggleTreeDir(path: string): Promise<void> {
      const { treeExpanded } = get()
      const next = new Set(treeExpanded)

      if (next.has(path)) {
        next.delete(path)
        set({ treeExpanded: next })
        return
      }

      next.add(path)
      set({ treeExpanded: next })

      const { directory, treeRoot } = get()
      if (!directory) return
      // Only fetch this level if we have not already loaded any children under it.
      const alreadyLoaded = treeRoot.some((n) => n.path !== path && n.path.startsWith(`${path}/`))
      if (alreadyLoaded) return

      try {
        const children = await api().fs.tree(directory, path)
        set((state) => ({ treeRoot: mergeNodes(state.treeRoot, children ?? []) }))
      } catch (e) {
        set({ error: errText(e) })
      }
    }
  }
}
