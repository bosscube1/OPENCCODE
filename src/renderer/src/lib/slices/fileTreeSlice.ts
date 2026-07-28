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
  'treeRoot' | 'treeExpanded' | 'treeLoading' | 'loadTree' | 'toggleTreeDir'
>

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
