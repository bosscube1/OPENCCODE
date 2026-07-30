/**
 * Turn current repo state into a compact text blob for the Gemini Live copilot.
 *
 * The `#/live` window has no zustand store and no session state — it only has the
 * persisted project directory and the `window.api` bridge. This module gathers a small
 * slice of git state through that bridge and formats it as a spoken-context turn so the
 * copilot knows what the user is working on instead of only seeing pixels.
 *
 * PURE MODULE. No React, no zustand, no `window.*`, no direct IPC — everything comes in
 * through parameters, matching the house rule for `lib/` helpers (see `exportMarkdown.ts`
 * for the closest sibling: same "format gathered data into a text blob" shape).
 */
import { selectedHunksToPatch } from './hunks'
import type { FileDiff, GitStatus } from '../../../preload'

/** Bounds so a huge repo cannot blow past the Live session's text limit. */
export const MAX_CONTEXT_CHARS = 8000
export const MAX_LISTED_FILES = 40

const TRUNCATION_MARKER = '\n[context truncated]'

export type ProjectContextInput = {
  directory: string
  status: GitStatus | null
  /** Unified patches for a few changed files; may be empty. */
  diffs: Array<{ path: string; patch: string }>
}

/** Minimal slice of `window.api` this module needs — injected so it is testable. */
export type LiveContextApi = {
  git: {
    status(directory: string): Promise<GitStatus | null>
    diff(a: { directory: string; path: string; staged?: boolean }): Promise<FileDiff>
  }
}

function statusLabel(entry: GitStatus['entries'][number]): string {
  return entry.worktree ?? entry.index ?? '?'
}

/** Cuts `text` down to `maxChars`, breaking at the last full line, and marks the cut. */
function truncateAtLineBoundary(text: string, maxChars: number): string {
  const budget = Math.max(0, maxChars - TRUNCATION_MARKER.length)
  let cut = text.slice(0, budget)
  const lastNewline = cut.lastIndexOf('\n')
  if (lastNewline > 0) cut = cut.slice(0, lastNewline)
  return cut + TRUNCATION_MARKER
}

/** Pure: format gathered repo state as a compact text turn for Gemini. */
export function formatProjectContext(input: ProjectContextInput): string {
  const { directory, status, diffs } = input
  const lines: string[] = [`Project context for ${directory}:`]

  if (status === null) {
    lines.push('This directory is not a git repository (or git status could not be read).')
  } else {
    const upstream = status.upstream ? `tracking ${status.upstream}` : 'no upstream'
    lines.push(`Branch: ${status.branch} (${upstream}), ${status.ahead} ahead / ${status.behind} behind.`)

    if (status.clean) {
      lines.push('Working tree is clean — no uncommitted changes.')
    } else {
      const total = status.entries.length
      const shown = status.entries.slice(0, MAX_LISTED_FILES)
      lines.push(`Changed files (${total}):`)
      for (const entry of shown) {
        lines.push(`- ${statusLabel(entry)} ${entry.path}`)
      }
      if (total > shown.length) {
        lines.push(`…and ${total - shown.length} more`)
      }
    }
  }

  if (diffs.length > 0) {
    lines.push('')
    lines.push('Diffs:')
    for (const diff of diffs) {
      lines.push(`--- ${diff.path}`)
      if (diff.patch) lines.push(diff.patch)
    }
  }

  const out = lines.join('\n')
  return out.length > MAX_CONTEXT_CHARS ? truncateAtLineBoundary(out, MAX_CONTEXT_CHARS) : out
}

/**
 * Gather + format. Never throws: returns a usable string on any failure.
 *
 * Picks up to `options.maxDiffFiles` (default 3) changed entries from `status` and fetches
 * a diff for each. A rejected `status` call yields a short fallback context. A rejected
 * individual `diff` call just skips that file — one bad file must not lose the rest.
 */
export async function collectProjectContext(
  api: LiveContextApi,
  directory: string,
  options?: { maxDiffFiles?: number }
): Promise<string> {
  const maxDiffFiles = options?.maxDiffFiles ?? 3

  let status: GitStatus | null
  try {
    status = await api.git.status(directory)
  } catch {
    return `Project context for ${directory}: could not read git status.`
  }

  const diffs: Array<{ path: string; patch: string }> = []
  if (status && !status.clean) {
    const changed = status.entries.slice(0, maxDiffFiles)
    for (const entry of changed) {
      try {
        const fileDiff = await api.git.diff({ directory, path: entry.path })
        // FileDiff carries hunks (not a raw `.patch` string) — reuse the existing,
        // already-tested hunk-to-patch reconstruction from hunks.ts rather than
        // re-deriving unified-diff formatting here.
        const patch = selectedHunksToPatch(
          fileDiff,
          fileDiff.hunks.map((h) => h.id)
        )
        diffs.push({ path: entry.path, patch })
      } catch {
        // Skip this file; keep the rest of the context.
      }
    }
  }

  return formatProjectContext({ directory, status, diffs })
}
