/**
 * B1 — the scoped file tree (Phase 1 code surface).
 *
 * Reads `treeRoot` (a flat, path-keyed `FileNode[]`) straight from the store and
 * reconstructs nesting from each node's `path` — there is no `children` array.
 * Expansion is lazy: opening a directory calls `toggleTreeDir`, which fetches that
 * level on demand via the slice. This component never walks the repo itself.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { JSX, KeyboardEvent } from 'react'
import { useStore } from '../lib/store'
import type { FileNode, GitFileStatus } from '../lib/types'
import './tree.css'

/** A single directory listing beyond this size is capped, not virtualized — see report. */
const MAX_CHILDREN_PER_DIR = 500

type Row =
  | { type: 'node'; node: FileNode; depth: number }
  | { type: 'more'; key: string; depth: number; count: number }

function parentOf(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx === -1 ? '' : path.slice(0, idx)
}

function compareNodes(a: FileNode, b: FileNode): number {
  if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
  return a.name.localeCompare(b.name)
}

/** Group the flat node list by parent path, then walk from the root, only descending
 *  into directories the user has actually expanded. This is independent of the array's
 *  physical order in `treeRoot` (merges from later fetches may append out of order). */
function buildRows(nodes: FileNode[], expanded: Set<string>): Row[] {
  const byParent = new Map<string, FileNode[]>()
  for (const node of nodes) {
    const parent = parentOf(node.path)
    const list = byParent.get(parent)
    if (list) list.push(node)
    else byParent.set(parent, [node])
  }
  for (const list of byParent.values()) list.sort(compareNodes)

  const rows: Row[] = []
  const walk = (parentPath: string, depth: number): void => {
    const children = byParent.get(parentPath)
    if (!children) return
    const visible = children.slice(0, MAX_CHILDREN_PER_DIR)
    for (const node of visible) {
      rows.push({ type: 'node', node, depth })
      if (node.kind === 'dir' && expanded.has(node.path)) {
        walk(node.path, depth + 1)
      }
    }
    if (children.length > MAX_CHILDREN_PER_DIR) {
      rows.push({
        type: 'more',
        key: `${parentPath}::more`,
        depth,
        count: children.length - MAX_CHILDREN_PER_DIR
      })
    }
  }
  walk('', 0)
  return rows
}

function statusClass(status: GitFileStatus | null): string {
  switch (status) {
    case 'modified':
      return 'tree__row--modified'
    case 'added':
      return 'tree__row--added'
    case 'deleted':
      return 'tree__row--deleted'
    case 'untracked':
      return 'tree__row--untracked'
    case 'conflicted':
      return 'tree__row--conflicted'
    default:
      return ''
  }
}

export function FileTree(): JSX.Element {
  const directory = useStore((s) => s.directory)
  const treeRoot = useStore((s) => s.treeRoot)
  const treeExpanded = useStore((s) => s.treeExpanded)
  const treeLoading = useStore((s) => s.treeLoading)
  const gitStatus = useStore((s) => s.gitStatus)
  const loadTree = useStore((s) => s.loadTree)
  const toggleTreeDir = useStore((s) => s.toggleTreeDir)
  const openPath = useStore((s) => s.openPath)
  const setPanelTab = useStore((s) => s.setPanelTab)

  const [focusedPath, setFocusedPath] = useState<string | null>(null)
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>())

  // Initial load is a single lazy fetch of the root level only (fs:tree with no path),
  // never a recursive walk — deeper levels load only when the user expands a directory.
  useEffect(() => {
    if (directory && treeRoot.length === 0 && !treeLoading) {
      void loadTree()
    }
  }, [directory, treeRoot.length, treeLoading, loadTree])

  // Live git status (kept fresh by the debounced refreshGit()/file.edited flow) takes
  // priority over the snapshot baked into FileNode.gitStatus at fetch time.
  const liveStatusByPath = useMemo(() => {
    const map = new Map<string, GitFileStatus>()
    if (gitStatus) {
      for (const entry of gitStatus.entries) {
        const status = entry.worktree ?? entry.index
        if (status) map.set(entry.path, status)
      }
    }
    return map
  }, [gitStatus])

  const rows = useMemo(() => buildRows(treeRoot, treeExpanded), [treeRoot, treeExpanded])
  const nodeRows = useMemo(
    () => rows.filter((r): r is Extract<Row, { type: 'node' }> => r.type === 'node'),
    [rows]
  )

  useEffect(() => {
    if (nodeRows.length === 0) {
      setFocusedPath(null)
      return
    }
    if (!focusedPath || !nodeRows.some((r) => r.node.path === focusedPath)) {
      setFocusedPath(nodeRows[0].node.path)
    }
  }, [nodeRows, focusedPath])

  function activate(node: FileNode): void {
    if (node.kind === 'dir') {
      void toggleTreeDir(node.path)
    } else {
      void openPath(node.path)
      setPanelTab('editor')
    }
  }

  function focusIndex(index: number): void {
    const target = nodeRows[index]
    if (!target) return
    setFocusedPath(target.node.path)
    buttonRefs.current.get(target.node.path)?.focus()
  }

  function onTreeKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (nodeRows.length === 0) return
    const currentIndex = Math.max(
      0,
      focusedPath ? nodeRows.findIndex((r) => r.node.path === focusedPath) : 0
    )
    const current = nodeRows[currentIndex]

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        focusIndex(Math.min(currentIndex + 1, nodeRows.length - 1))
        break
      case 'ArrowUp':
        event.preventDefault()
        focusIndex(Math.max(currentIndex - 1, 0))
        break
      case 'Home':
        event.preventDefault()
        focusIndex(0)
        break
      case 'End':
        event.preventDefault()
        focusIndex(nodeRows.length - 1)
        break
      case 'ArrowRight':
        event.preventDefault()
        if (current.node.kind === 'dir') {
          if (!treeExpanded.has(current.node.path)) {
            void toggleTreeDir(current.node.path)
          } else {
            const next = nodeRows[currentIndex + 1]
            if (next && next.depth > current.depth) focusIndex(currentIndex + 1)
          }
        }
        break
      case 'ArrowLeft':
        event.preventDefault()
        if (current.node.kind === 'dir' && treeExpanded.has(current.node.path)) {
          void toggleTreeDir(current.node.path)
        } else {
          for (let i = currentIndex - 1; i >= 0; i--) {
            if (nodeRows[i].depth < current.depth) {
              focusIndex(i)
              break
            }
          }
        }
        break
      default:
        break
    }
  }

  if (!directory) {
    return <div className="panel__empty">Open a project folder to browse its files.</div>
  }

  if (!treeLoading && rows.length === 0) {
    return <div className="panel__empty">No files found in this workspace.</div>
  }

  return (
    <div className="tree" role="tree" aria-label="Files" onKeyDown={onTreeKeyDown}>
      {treeLoading && rows.length === 0 && (
        <div className="tree__loading" role="status">
          Loading files…
        </div>
      )}
      {rows.map((row) =>
        row.type === 'more' ? (
          <div
            key={row.key}
            className="tree__more"
            style={{ paddingLeft: `${10 + row.depth * 14}px` }}
          >
            {row.count} more item{row.count === 1 ? '' : 's'} not shown
          </div>
        ) : (
          <button
            key={row.node.path}
            type="button"
            ref={(el) => {
              if (el) buttonRefs.current.set(row.node.path, el)
              else buttonRefs.current.delete(row.node.path)
            }}
            className={`tree__row ${statusClass(liveStatusByPath.get(row.node.path) ?? row.node.gitStatus ?? null)}`}
            style={{ paddingLeft: `${10 + row.depth * 14}px` }}
            role="treeitem"
            aria-level={row.depth + 1}
            aria-expanded={row.node.kind === 'dir' ? treeExpanded.has(row.node.path) : undefined}
            tabIndex={row.node.path === focusedPath ? 0 : -1}
            onFocus={() => setFocusedPath(row.node.path)}
            onClick={() => activate(row.node)}
            title={row.node.path}
          >
            <span className="tree__twisty" aria-hidden="true">
              {row.node.kind === 'dir' ? (treeExpanded.has(row.node.path) ? '▾' : '▸') : ''}
            </span>
            <span className="tree__name">{row.node.name}</span>
            {row.node.touched && (
              <span className="tree__touched" aria-hidden="true" title="Edited this session">
                ●
              </span>
            )}
          </button>
        )
      )}
    </div>
  )
}
