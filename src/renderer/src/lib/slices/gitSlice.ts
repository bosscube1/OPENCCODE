/**
 * Git panel state (Phase 1 code surface).
 *
 * `refreshGit()` is debounced (~300ms) at module scope so it can be called both from
 * UI actions (mount, manual refresh) and from `eventSlice`'s `file.edited` handler
 * without ever double-fetching: the agent editing several files in quick succession
 * collapses into a single status/branches round-trip ~300ms after the last edit.
 *
 * NOTE on `stageHunks`: it depends on `selectedHunksToPatch` from
 * src/renderer/src/lib/hunks.ts (not yet written — owned by a concurrent workstream).
 * Stubbed below — see TODO(hunks).
 */

import { api, errText } from './api'
import type { AppState, SetState, GetState } from './types'

export type GitSlice = Pick<
  AppState,
  'gitStatus' | 'gitBranches' | 'refreshGit' | 'stagePaths' | 'stageHunks' | 'commit' | 'generateCommitMessage'
>

const REFRESH_DEBOUNCE_MS = 300

let refreshTimer: ReturnType<typeof setTimeout> | null = null

async function doRefreshGit(set: SetState, get: GetState): Promise<void> {
  const { directory } = get()
  if (!directory) return
  try {
    const [status, branches] = await Promise.all([api().git.status(directory), api().git.branches(directory)])
    set({ gitStatus: status, gitBranches: branches ?? [] })
  } catch (e) {
    set({ error: errText(e) })
  }
}

export function createGitSlice(set: SetState, get: GetState): GitSlice {
  return {
    gitStatus: null,
    gitBranches: [],

    refreshGit(): Promise<void> {
      return new Promise((resolve) => {
        if (refreshTimer) clearTimeout(refreshTimer)
        refreshTimer = setTimeout(() => {
          refreshTimer = null
          void doRefreshGit(set, get).finally(resolve)
        }, REFRESH_DEBOUNCE_MS)
      })
    },

    async stagePaths(paths: string[]): Promise<void> {
      const { directory } = get()
      if (!directory || paths.length === 0) return
      try {
        const status = await api().git.stage(directory, paths)
        set({ gitStatus: status })
      } catch (e) {
        set({ error: errText(e) })
      }
    },

    async stageHunks(_path: string, _hunkIds: string[]): Promise<void> {
      // TODO(hunks): needs `selectedHunksToPatch` from src/renderer/src/lib/hunks.ts to build
      // the unified-diff patch, then:
      //   const status = await api().git.stageHunks({ directory, path, patch })
      //   set({ gitStatus: status })
      set({ error: 'Staging individual hunks is not available yet.' })
      throw new Error('hunks module not yet available')
    },

    async commit(message: string): Promise<void> {
      const { directory } = get()
      if (!directory) return
      const trimmed = message.trim()
      if (trimmed.length === 0) {
        set({ error: 'Enter a commit message first.' })
        return
      }
      try {
        await api().git.commit({ directory, message: trimmed })
        await doRefreshGit(set, get)
      } catch (e) {
        set({ error: errText(e) })
      }
    },

    async generateCommitMessage(): Promise<string> {
      // No `/commit` slash command exists yet in lib/commands.ts to reuse, so this derives
      // a minimal heuristic message straight from the current git status rather than
      // round-tripping through the LLM.
      const { directory } = get()
      if (!directory) return ''

      let status = get().gitStatus
      if (!status) {
        try {
          status = await api().git.status(directory)
          set({ gitStatus: status })
        } catch (e) {
          set({ error: errText(e) })
          return ''
        }
      }

      const staged = status.entries.filter((entry) => entry.index !== null)
      const changed = staged.length > 0 ? staged : status.entries
      if (changed.length === 0) return ''

      if (changed.length === 1) {
        const entry = changed[0]
        const side = entry.index ?? entry.worktree
        const verb = side === 'added' || side === 'untracked' ? 'Add' : side === 'deleted' ? 'Remove' : 'Update'
        return `${verb} ${entry.path}`
      }

      return `Update ${changed.length} files`
    }
  }
}
