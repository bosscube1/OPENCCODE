import { useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { useStore } from '../lib/store'
import type { GitFileStatus, GitStatusEntry } from '../lib/types'
import './git.css'

const STATUS_GLYPH: Record<GitFileStatus, string> = {
  untracked: 'U',
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  conflicted: '!',
  ignored: 'I'
}

const STATUS_LABEL: Record<GitFileStatus, string> = {
  untracked: 'Untracked',
  modified: 'Modified',
  added: 'Added',
  deleted: 'Deleted',
  renamed: 'Renamed',
  conflicted: 'Conflicted',
  ignored: 'Ignored'
}

// Maps directly to design tokens — never a hardcoded hex. `ignored`/`untracked` fall
// back to the dim/neutral tone since they're informational rather than change states.
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

function Glyph({ status }: { status: GitFileStatus }): JSX.Element {
  const tone = statusTone(status)
  return (
    <span className={`git__glyph git__glyph--${tone}`} title={STATUS_LABEL[status]} aria-hidden="true">
      {STATUS_GLYPH[status]}
    </span>
  )
}

function FileRow({
  entry,
  status,
  checked,
  onToggle,
  onOpen
}: {
  entry: GitStatusEntry
  status: GitFileStatus
  checked: boolean
  onToggle: () => void
  onOpen: () => void
}): JSX.Element {
  return (
    <li className="git__file">
      <label className="git__file-check">
        <input type="checkbox" checked={checked} onChange={onToggle} aria-label={`Stage ${entry.path}`} />
      </label>
      <Glyph status={status} />
      <button type="button" className="git__file-path" onClick={onOpen} title={entry.path}>
        {entry.renamedFrom ? (
          <span className="git__rename">
            <span className="git__rename-old">{entry.renamedFrom}</span>
            <span aria-hidden="true"> → </span>
            <span className="git__rename-new">{entry.path}</span>
          </span>
        ) : (
          entry.path
        )}
      </button>
    </li>
  )
}

export function GitPanel(): JSX.Element {
  const directory = useStore((s) => s.directory)
  const gitStatus = useStore((s) => s.gitStatus)
  const gitBranches = useStore((s) => s.gitBranches)
  const refreshGit = useStore((s) => s.refreshGit)
  const stagePaths = useStore((s) => s.stagePaths)
  const commit = useStore((s) => s.commit)
  const generateCommitMessage = useStore((s) => s.generateCommitMessage)
  const openPath = useStore((s) => s.openPath)
  const setPanelTab = useStore((s) => s.setPanelTab)
  const openFile = useStore((s) => s.openFile)
  const openFileDiff = useStore((s) => s.openFileDiff)
  const error = useStore((s) => s.error)

  const [message, setMessage] = useState('')
  const [generating, setGenerating] = useState(false)
  const [committing, setCommitting] = useState(false)
  const [pendingPath, setPendingPath] = useState<string | null>(null)

  useEffect(() => {
    if (directory) void refreshGit()
    // Only re-run when the workspace directory changes; refreshGit is otherwise
    // driven by the `file.edited` SSE event via the store, not polling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [directory])

  const staged = useMemo(
    () => (gitStatus ? gitStatus.entries.filter((e) => e.index !== null) : []),
    [gitStatus]
  )
  const unstaged = useMemo(
    () => (gitStatus ? gitStatus.entries.filter((e) => e.worktree !== null) : []),
    [gitStatus]
  )

  async function openDiff(path: string): Promise<void> {
    setPendingPath(path)
    try {
      await openPath(path)
      setPanelTab('editor')
    } finally {
      setPendingPath(null)
    }
  }

  async function toggleStage(path: string, currentlyStaged: boolean): Promise<void> {
    // stagePaths only moves worktree -> index; there is no store action to unstage
    // (no `oc:git:unstage` wiring exposed on the git slice yet). Staging an
    // already-staged file is a harmless no-op server-side.
    if (currentlyStaged) return
    await stagePaths([path])
  }

  async function handleGenerate(): Promise<void> {
    setGenerating(true)
    try {
      const generated = await generateCommitMessage()
      if (generated) setMessage(generated)
    } finally {
      setGenerating(false)
    }
  }

  async function handleCommit(): Promise<void> {
    setCommitting(true)
    try {
      await commit(message)
      setMessage('')
    } finally {
      setCommitting(false)
    }
  }

  if (!directory) {
    return (
      <div className="panel__empty">
        <p>Open a workspace to see its git status.</p>
      </div>
    )
  }

  if (!gitStatus) {
    return (
      <div className="panel__empty">
        <p>Loading git status…</p>
      </div>
    )
  }

  const canCommit = staged.length > 0 && message.trim().length > 0 && !committing

  // Surfacing FileDiff.truncated: the only diff-derived data this panel shows is
  // whichever file is currently open via openPath (rendered in the editor panel).
  // If that diff was cut at the 5000-line cap, say so loudly here too, since a user
  // staging changes from the git panel while that warning is out of view would
  // otherwise believe the diff they just looked at was complete.
  const truncatedWarning =
    openFileDiff?.truncated && openFile ? (
      <div className="git__truncated" role="alert">
        <strong>Partial diff.</strong> {openFile.path} has changes beyond the 5000-line cap that
        are not shown — the diff view is incomplete. Do not assume staged hunks cover every change.
      </div>
    ) : null

  return (
    <div className="git">
      <div className="git__header">
        <div className="git__branch-row">
          <span className="git__branch-icon" aria-hidden="true">
            ⌥
          </span>
          <select
            className="git__branch-select"
            value={gitStatus.branch}
            disabled
            title="Branch switching isn't wired up yet — this workspace has no checkout action available."
          >
            {gitBranches.length > 0 ? (
              gitBranches.map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name}
                  {b.remote ? ' (remote)' : ''}
                </option>
              ))
            ) : (
              <option value={gitStatus.branch}>{gitStatus.branch}</option>
            )}
          </select>
        </div>
        <div className="git__sync-row">
          {gitStatus.upstream ? (
            <span className="git__upstream" title={`Tracking ${gitStatus.upstream}`}>
              {gitStatus.upstream}
            </span>
          ) : (
            <span className="git__upstream git__upstream--none">no upstream</span>
          )}
          {gitStatus.ahead > 0 && <span className="git__count git__count--ahead">↑{gitStatus.ahead}</span>}
          {gitStatus.behind > 0 && <span className="git__count git__count--behind">↓{gitStatus.behind}</span>}
        </div>
        {gitStatus.ahead > 0 && (
          <p className="git__push-note">
            Ahead of upstream — pushing happens from a terminal, not this panel.
          </p>
        )}
      </div>

      {truncatedWarning}

      {error && (
        <div className="git__error" role="alert">
          {error}
        </div>
      )}

      {gitStatus.clean ? (
        <div className="panel__empty">
          <p>Working tree clean. Nothing to stage or commit.</p>
        </div>
      ) : (
        <div className="git__body">
          <section className="git__section">
            <h3 className="git__section-title">Staged ({staged.length})</h3>
            {staged.length === 0 ? (
              <p className="git__section-empty">Nothing staged.</p>
            ) : (
              <ul className="git__file-list">
                {staged.map((entry) => (
                  <FileRow
                    key={`staged-${entry.path}`}
                    entry={entry}
                    status={entry.index as GitFileStatus}
                    checked
                    onToggle={() => void toggleStage(entry.path, true)}
                    onOpen={() => void openDiff(entry.path)}
                  />
                ))}
              </ul>
            )}
          </section>

          <section className="git__section">
            <h3 className="git__section-title">Unstaged ({unstaged.length})</h3>
            {unstaged.length === 0 ? (
              <p className="git__section-empty">Nothing unstaged.</p>
            ) : (
              <ul className="git__file-list">
                {unstaged.map((entry) => (
                  <FileRow
                    key={`unstaged-${entry.path}`}
                    entry={entry}
                    status={entry.worktree as GitFileStatus}
                    checked={false}
                    onToggle={() => void toggleStage(entry.path, false)}
                    onOpen={() => void openDiff(entry.path)}
                  />
                ))}
              </ul>
            )}
          </section>
        </div>
      )}

      <div className="git__commit-box">
        <textarea
          className="git__commit-message"
          placeholder="Commit message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={3}
        />
        <div className="git__commit-actions">
          <button
            type="button"
            className="panel__toolbar-btn"
            onClick={() => void handleGenerate()}
            disabled={generating}
          >
            {generating ? 'Generating…' : 'Generate'}
          </button>
          <button
            type="button"
            className="panel__toolbar-btn git__commit-btn"
            onClick={() => void handleCommit()}
            disabled={!canCommit}
          >
            {committing ? 'Committing…' : 'Commit'}
          </button>
        </div>
      </div>

      {pendingPath && <span className="git__visually-hidden" role="status">Opening diff for {pendingPath}…</span>}
    </div>
  )
}
