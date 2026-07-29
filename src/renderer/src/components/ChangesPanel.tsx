/**
 * ChangesPanel — multi-file review surface (P3 code surface).
 *
 * Every changed path in one scrollable list, each file collapsible, diffs
 * rendered inline. The single-file counterpart lives in EditorPanel.tsx (open
 * one file, review its hunks, accept/apply). This view is the "all of it at
 * once" complement — read-only, no accept/apply — for scanning the whole
 * working tree the way VS Code's "Changes" panel does.
 *
 * Hunks render through the shared `HunkView`, same as EditorPanel — here without
 * an `onToggle`, which is what makes them read-only.
 */

import { useEffect, useMemo, useState, type JSX } from 'react'
import { useStore } from '../lib/store'
import type { FileDiff, GitFileStatus, GitStatusEntry } from '../lib/types'
import { HunkView } from './HunkView'
import './editor.css'
import './panels.css'

const STATUS_GLYPH: Record<GitFileStatus, string> = {
  untracked: 'U',
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  conflicted: '!',
  ignored: 'I'
}

function statusTone(status: GitFileStatus): 'ok' | 'warn' | 'danger' | 'dim' {
  switch (status) {
    case 'added':
      return 'ok'
    case 'deleted':
    case 'conflicted':
      return 'danger'
    case 'modified':
    case 'renamed':
      return 'warn'
    case 'untracked':
    case 'ignored':
      return 'dim'
  }
}

function FileSection({
  entry,
  diff,
  loading,
  expanded,
  onToggleExpanded,
  onOpen
}: {
  entry: GitStatusEntry
  diff: FileDiff | undefined
  loading: boolean
  expanded: boolean
  onToggleExpanded: () => void
  onOpen: () => void
}): JSX.Element {
  const status = (entry.worktree ?? entry.index ?? 'modified') as GitFileStatus
  const tone = statusTone(status)

  return (
    <section className="changes__file">
      <div className="changes__file-head">
        <button
          type="button"
          className="changes__file-toggle"
          onClick={onToggleExpanded}
          aria-expanded={expanded}
        >
          <span className="changes__file-caret" aria-hidden="true">
            {expanded ? '▾' : '▸'}
          </span>
          <span className={`changes__glyph changes__glyph--${tone}`} aria-hidden="true">
            {STATUS_GLYPH[status]}
          </span>
          <span className="changes__file-path" title={entry.path}>
            {entry.renamedFrom ? `${entry.renamedFrom} → ${entry.path}` : entry.path}
          </span>
        </button>
        <button type="button" className="panel__toolbar-btn changes__open-btn" onClick={onOpen}>
          Open
        </button>
      </div>

      {expanded && (
        <div className="changes__file-body">
          {!diff ? (
            <p className="changes__file-note">{loading ? 'Loading diff…' : 'No diff available.'}</p>
          ) : diff.binary ? (
            <p className="changes__file-note">Binary file — no text diff to review.</p>
          ) : diff.hunks.length === 0 ? (
            <p className="changes__file-note">No changes to review.</p>
          ) : (
            <div className="editor__diff changes__diff">
              {diff.truncated && (
                <div className="editor__banner editor__banner--truncated" role="alert">
                  <span className="editor__banner-icon" aria-hidden="true">
                    ⚠
                  </span>
                  <span>
                    <strong>This diff is INCOMPLETE.</strong> It exceeded the 5000-line cap; hunks
                    past that point were dropped and are not shown below.
                  </span>
                </div>
              )}
              {diff.hunks.map((hunk) => (
                <HunkView key={hunk.id} hunk={hunk} />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

export function ChangesPanel(): JSX.Element {
  const directory = useStore((s) => s.directory)
  const gitStatus = useStore((s) => s.gitStatus)
  const gitStatusFor = useStore((s) => s.gitStatusFor)
  const refreshGit = useStore((s) => s.refreshGit)
  const changedDiffs = useStore((s) => s.changedDiffs)
  const changedDiffsLoading = useStore((s) => s.changedDiffsLoading)
  const loadChangedDiffs = useStore((s) => s.loadChangedDiffs)
  const openPath = useStore((s) => s.openPath)
  const setPanelTab = useStore((s) => s.setPanelTab)

  // Collapsed-by-user paths. Absent from the set == expanded (the default), so a
  // freshly changed file shows its diff immediately without an extra click.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    if (directory) void refreshGit()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [directory])

  useEffect(() => {
    if (gitStatus) void loadChangedDiffs()
    // Re-fetch whenever the entry list itself changes shape, not on every gitStatus
    // object identity change (branch/ahead-behind updates would otherwise refetch
    // every diff for no reason).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [directory, gitStatus?.entries.map((e) => `${e.path}:${e.index}:${e.worktree}`).join('|')])

  const entries = useMemo(() => gitStatus?.entries ?? [], [gitStatus])

  async function handleOpen(path: string): Promise<void> {
    await openPath(path)
    setPanelTab('editor')
  }

  if (!directory) {
    return (
      <div className="panel__empty">
        <p>Open a workspace to review its changes.</p>
      </div>
    )
  }

  if (!gitStatus) {
    // Same disambiguation GitPanel uses: a resolved fetch for THIS directory that
    // produced no status means "not a repository", not a stuck spinner.
    return gitStatusFor === directory ? (
      <div className="panel__empty">
        <p>This folder is not a git repository.</p>
      </div>
    ) : (
      <div className="panel__empty">
        <p>Loading git status…</p>
      </div>
    )
  }

  if (gitStatus.clean || entries.length === 0) {
    return (
      <div className="panel__empty">
        <p>Working tree clean. Nothing to review.</p>
      </div>
    )
  }

  return (
    <div className="changes">
      <div className="changes__list">
        {entries.map((entry) => (
          <FileSection
            key={entry.path}
            entry={entry}
            diff={changedDiffs[entry.path]}
            loading={changedDiffsLoading}
            expanded={!collapsed.has(entry.path)}
            onToggleExpanded={() =>
              setCollapsed((prev) => {
                const next = new Set(prev)
                if (next.has(entry.path)) next.delete(entry.path)
                else next.add(entry.path)
                return next
              })
            }
            onOpen={() => void handleOpen(entry.path)}
          />
        ))}
      </div>
    </div>
  )
}
