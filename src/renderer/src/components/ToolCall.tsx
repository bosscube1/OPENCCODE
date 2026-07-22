import { useState } from 'react'
import type { ReactNode } from 'react'
import type { ToolPart, ToolState } from '../lib/types'
import { formatDuration } from '../lib/format'
import { highlightCode } from '../lib/highlight'

/* ------------------------------------------------------------------ *
 * Defensive narrowing. `input` is Record<string, unknown> — never cast.
 * ------------------------------------------------------------------ */

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function firstString(source: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const hit = asString(source[key])
    if (hit !== null) return hit
  }
  return null
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

/* ------------------------------------------------------------------ *
 * Tool identity
 * ------------------------------------------------------------------ */

const KNOWN_TOOLS = [
  'bash',
  'read',
  'write',
  'edit',
  'multiedit',
  'patch',
  'glob',
  'grep',
  'list',
  'webfetch',
  'websearch',
  'todowrite',
  'todoread',
  'task'
] as const

type ToolKind = (typeof KNOWN_TOOLS)[number] | 'default'

function toolKind(tool: string): ToolKind {
  const lowered = tool.toLowerCase()
  for (const known of KNOWN_TOOLS) {
    if (lowered === known) return known
  }
  const tail = lowered.split(/[^a-z0-9]+/).filter(Boolean).pop()
  if (tail) {
    for (const known of KNOWN_TOOLS) {
      if (tail === known) return known
    }
  }
  return 'default'
}

const TOOL_ICON: Record<ToolKind, string> = {
  bash: '❯', // ❯
  read: '▤', // ▤
  write: '✚', // ✚
  edit: '✎', // ✎
  multiedit: '✎',
  patch: '✇', // ✇
  glob: '✱', // ✱
  grep: '⌕', // ⌕
  list: '☰', // ☰
  webfetch: '⇩', // ⇩
  websearch: '⌖', // ⌖
  todowrite: '☑', // ☑
  todoread: '☑',
  task: '◈', // ◈
  default: '⚙' // ⚙
}

const FILE_KEYS = ['filePath', 'file_path', 'path', 'file', 'target'] as const

/* ------------------------------------------------------------------ *
 * Clamped preformatted output
 * ------------------------------------------------------------------ */

const CLAMP_LINES = 40

function Clamp({ text, tone }: { text: string; tone?: 'error' }): ReactNode {
  const [expanded, setExpanded] = useState(false)
  const lines = text.split('\n')
  const overflowing = lines.length > CLAMP_LINES
  const shown = expanded || !overflowing ? text : lines.slice(0, CLAMP_LINES).join('\n')
  const cls = tone === 'error' ? 'tool__pre tool__pre--error' : 'tool__pre'

  return (
    <>
      <pre className={cls}>{shown}</pre>
      {overflowing ? (
        <button
          type="button"
          className="tool__more"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'Show less' : `Show ${lines.length - CLAMP_LINES} more lines`}
        </button>
      ) : null}
    </>
  )
}

/* ------------------------------------------------------------------ *
 * Line diff
 * ------------------------------------------------------------------ */

type DiffLine = { kind: 'ctx' | 'add' | 'del'; text: string }

function lineDiff(before: string, after: string, context = 2): DiffLine[] {
  const a = before.split('\n')
  const b = after.split('\n')

  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1

  let suffix = 0
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1
  }

  const out: DiffLine[] = []
  for (let i = Math.max(0, prefix - context); i < prefix; i += 1) {
    out.push({ kind: 'ctx', text: a[i] })
  }
  for (let i = prefix; i < a.length - suffix; i += 1) {
    out.push({ kind: 'del', text: a[i] })
  }
  for (let i = prefix; i < b.length - suffix; i += 1) {
    out.push({ kind: 'add', text: b[i] })
  }
  const tailEnd = Math.min(a.length, a.length - suffix + context)
  for (let i = a.length - suffix; i < tailEnd; i += 1) {
    out.push({ kind: 'ctx', text: a[i] })
  }
  return out
}

function parseUnifiedDiff(diff: string): DiffLine[] {
  return diff
    .split('\n')
    .filter(
      (line) =>
        !line.startsWith('diff ') &&
        !line.startsWith('index ') &&
        !line.startsWith('--- ') &&
        !line.startsWith('+++ ')
    )
    .map<DiffLine>((line) => {
      if (line.startsWith('+')) return { kind: 'add', text: line.slice(1) }
      if (line.startsWith('-')) return { kind: 'del', text: line.slice(1) }
      if (line.startsWith(' ')) return { kind: 'ctx', text: line.slice(1) }
      return { kind: 'ctx', text: line }
    })
}

const DIFF_CLAMP = 60

function DiffView({ lines }: { lines: DiffLine[] }): ReactNode {
  const [expanded, setExpanded] = useState(false)
  const overflowing = lines.length > DIFF_CLAMP
  const shown = expanded || !overflowing ? lines : lines.slice(0, DIFF_CLAMP)

  const diffText = shown
    .map((line) => (line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ') + line.text)
    .join('\n')
  const html = highlightCode(diffText, 'diff')

  return (
    <>
      <div className="tool__diff">
        {html ? (
          <div
            className="hljs language-diff"
            style={{ padding: '0 10px', whiteSpace: 'pre' }}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          shown.map((line, index) => (
            <div key={index} className={`tool__diffline tool__diffline--${line.kind}`}>
              <span className="tool__diffmark">
                {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}
              </span>
              <span className="tool__difftext">{line.text === '' ? ' ' : line.text}</span>
            </div>
          ))
        )}
      </div>
      {overflowing ? (
        <button
          type="button"
          className="tool__more"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'Show less' : `Show ${lines.length - DIFF_CLAMP} more lines`}
        </button>
      ) : null}
    </>
  )
}

/* ------------------------------------------------------------------ *
 * State readers
 * ------------------------------------------------------------------ */

function stateInput(state: ToolState): Record<string, unknown> {
  return state.input ?? {}
}

function stateTitle(state: ToolState): string | null {
  if (state.status === 'completed') return asString(state.title)
  if (state.status === 'running') return asString(state.title)
  return null
}

function stateMetadata(state: ToolState): Record<string, unknown> {
  if (state.status === 'pending') return {}
  return state.metadata ?? {}
}

function stateOutput(state: ToolState): string | null {
  return state.status === 'completed' ? asString(state.output) : null
}

function stateError(state: ToolState): string | null {
  return state.status === 'error' ? asString(state.error) : null
}

function stateDuration(state: ToolState): number | null {
  if (state.status === 'completed' || state.status === 'error') {
    return Math.max(0, state.time.end - state.time.start)
  }
  return null
}

/* ------------------------------------------------------------------ *
 * Per-tool bodies
 * ------------------------------------------------------------------ */

function Labelled({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div className="tool__field">
      <span className="tool__label">{label}</span>
      <span className="tool__value">{value}</span>
    </div>
  )
}

function ToolBody({ part }: { part: ToolPart }): ReactNode {
  const { state } = part
  const input = stateInput(state)
  const metadata = stateMetadata(state)
  const output = stateOutput(state)
  const error = stateError(state)
  const kind = toolKind(part.tool)

  const sections: ReactNode[] = []

  if (state.status === 'pending') {
    const raw = asString(state.raw)
    sections.push(
      <div className="tool__pending" key="pending">
        Preparing call{'…'}
      </div>
    )
    if (raw && Object.keys(input).length === 0) {
      sections.push(<Clamp key="raw" text={raw} />)
    }
  }

  switch (kind) {
    case 'bash': {
      const command = firstString(input, ['command', 'cmd', 'script'])
      const description = firstString(input, ['description'])
      if (description) sections.push(<Labelled key="desc" label="What" value={description} />)
      if (command) {
        sections.push(
          <pre className="tool__pre tool__pre--command" key="cmd">
            <span className="tool__prompt">$ </span>
            {command}
          </pre>
        )
      }
      break
    }

    case 'read':
    case 'write':
    case 'edit':
    case 'multiedit':
    case 'patch': {
      const file = firstString(input, FILE_KEYS)
      if (file) {
        sections.push(
          <div className="tool__path" key="path" title={file}>
            {file}
          </div>
        )
      }

      const oldString = firstString(input, ['oldString', 'old_string', 'before'])
      const newString = firstString(input, ['newString', 'new_string', 'after'])
      const metaDiff = firstString(metadata, ['diff', 'patch'])

      if (kind === 'edit' || kind === 'multiedit' || kind === 'patch') {
        if (oldString !== null && newString !== null) {
          sections.push(<DiffView key="diff" lines={lineDiff(oldString, newString)} />)
        } else if (metaDiff) {
          sections.push(<DiffView key="diff" lines={parseUnifiedDiff(metaDiff)} />)
        } else {
          const edits: unknown[] | null = Array.isArray(input.edits) ? (input.edits as unknown[]) : null
          if (edits) {
            const lines: DiffLine[] = []
            for (const raw of edits) {
              const edit = asRecord(raw)
              if (!edit) continue
              const from = firstString(edit, ['oldString', 'old_string'])
              const to = firstString(edit, ['newString', 'new_string'])
              if (from !== null && to !== null) lines.push(...lineDiff(from, to))
            }
            if (lines.length > 0) sections.push(<DiffView key="diff" lines={lines} />)
          }
        }
      }

      if (kind === 'write') {
        const content = asString(input.content)
        if (content) sections.push(<Clamp key="content" text={content} />)
      }
      break
    }

    case 'glob':
    case 'grep': {
      const pattern = firstString(input, ['pattern', 'query'])
      const path = firstString(input, ['path', 'cwd'])
      const include = firstString(input, ['include', 'glob'])
      if (pattern) sections.push(<Labelled key="pattern" label="Pattern" value={pattern} />)
      if (path) sections.push(<Labelled key="path" label="In" value={path} />)
      if (include) sections.push(<Labelled key="include" label="Include" value={include} />)
      break
    }

    case 'list': {
      const path = firstString(input, ['path', 'cwd', 'directory'])
      if (path) sections.push(<Labelled key="path" label="Path" value={path} />)
      break
    }

    case 'webfetch': {
      const url = firstString(input, ['url', 'uri'])
      const format = firstString(input, ['format'])
      if (url) sections.push(<Labelled key="url" label="URL" value={url} />)
      if (format) sections.push(<Labelled key="format" label="Format" value={format} />)
      break
    }

    case 'websearch': {
      const query = firstString(input, ['query', 'q', 'search'])
      if (query) sections.push(<Labelled key="query" label="Query" value={query} />)
      break
    }

    case 'task': {
      const description = firstString(input, ['description'])
      const agent = firstString(input, ['subagent_type', 'agent'])
      const prompt = firstString(input, ['prompt'])
      if (description) sections.push(<Labelled key="desc" label="Task" value={description} />)
      if (agent) sections.push(<Labelled key="agent" label="Agent" value={agent} />)
      if (prompt) sections.push(<Clamp key="prompt" text={prompt} />)
      break
    }

    default: {
      if (Object.keys(input).length > 0) {
        sections.push(<Clamp key="input" text={stringify(input)} />)
      }
      break
    }
  }

  if (error !== null) {
    sections.push(<Clamp key="error" text={error} tone="error" />)
  } else if (output !== null && output.trim() !== '') {
    sections.push(<Clamp key="output" text={output} />)
  }

  if (sections.length === 0) {
    sections.push(
      <div className="tool__empty" key="empty">
        No output
      </div>
    )
  }

  return <div className="tool__body">{sections}</div>
}

/* ------------------------------------------------------------------ *
 * Card
 * ------------------------------------------------------------------ */

export function ToolCall({ part }: { part: ToolPart }): ReactNode {
  const [override, setOverride] = useState<boolean | null>(null)

  const status = part.state.status
  const autoOpen = status === 'running' || status === 'error'
  const open = override ?? autoOpen

  const kind = toolKind(part.tool)
  const title = stateTitle(part.state)
  const duration = stateDuration(part.state)

  return (
    <div className={`tool tool--${status}`}>
      <button
        type="button"
        className="tool__header"
        aria-expanded={open}
        onClick={() => setOverride(!open)}
      >
        <span className="tool__chevron" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span className="tool__icon" aria-hidden="true">
          {TOOL_ICON[kind]}
        </span>
        <span className="tool__name">{part.tool}</span>
        {title ? <span className="tool__title">{title}</span> : null}
        <span className="tool__spacer" />
        {duration !== null ? <span className="tool__time">{formatDuration(duration)}</span> : null}
        <span className={`tool__dot tool__dot--${status}`} title={status} aria-label={status} />
      </button>
      {open ? <ToolBody part={part} /> : null}
    </div>
  )
}
