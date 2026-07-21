import { isValidElement, useCallback, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import Markdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type {
  FilePart,
  MessageWithParts,
  Part,
  ReasoningPart,
  TextPart,
  ToolPart
} from '../lib/types'
import { isFilePart, isTextPart } from '../lib/types'
import { formatCost, formatDuration, formatTokens } from '../lib/format'
import { ToolCall } from './ToolCall'

/* ------------------------------------------------------------------ *
 * Local helpers
 * ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function describeError(error: unknown): { name: string; message: string } | null {
  const record = asRecord(error)
  if (!record) {
    return typeof error === 'string' && error.length > 0
      ? { name: 'Error', message: error }
      : null
  }
  const name = typeof record.name === 'string' && record.name.length > 0 ? record.name : 'Error'
  const data = asRecord(record.data)
  if (data && typeof data.message === 'string' && data.message.length > 0) {
    return { name, message: data.message }
  }
  if (typeof record.message === 'string' && record.message.length > 0) {
    return { name, message: record.message }
  }
  if (data) {
    try {
      return { name, message: JSON.stringify(data) }
    } catch {
      return { name, message: 'Unknown failure' }
    }
  }
  return { name, message: 'Unknown failure' }
}

/* ------------------------------------------------------------------ *
 * Markdown plumbing
 * ------------------------------------------------------------------ */

function nodeText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((child) => nodeText(child as ReactNode)).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children)
  return ''
}

function CodeBlock({ language, code }: { language: string; code: string }): ReactNode {
  const [copied, setCopied] = useState(false)

  const copy = useCallback(() => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(code)
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      } catch {
        setCopied(false)
      }
    })()
  }, [code])

  return (
    <div className="msg__codeblock">
      <div className="msg__codebar">
        <span className="msg__codelang">{language || 'text'}</span>
        <button type="button" className="msg__copy" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="msg__codepre">
        <code>{code}</code>
      </pre>
    </div>
  )
}

const markdownComponents: Components = {
  pre({ children }) {
    const child = Array.isArray(children) ? children[0] : children
    if (isValidElement<{ className?: string; children?: ReactNode }>(child)) {
      const match = /language-([\w+#.-]+)/.exec(child.props.className ?? '')
      return (
        <CodeBlock
          language={match ? match[1] : ''}
          code={nodeText(child.props.children).replace(/\n$/, '')}
        />
      )
    }
    return <CodeBlock language="" code={nodeText(children).replace(/\n$/, '')} />
  },
  code({ children, className }) {
    return <code className={`msg__inlinecode ${className ?? ''}`.trim()}>{children}</code>
  },
  a({ children, href }) {
    return (
      <a className="msg__link" href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    )
  },
  table({ children }) {
    return (
      <div className="msg__tablewrap">
        <table className="msg__table">{children}</table>
      </div>
    )
  }
}

const REMARK_PLUGINS = [remarkGfm]

function MarkdownText({ text }: { text: string }): ReactNode {
  return (
    <div className="msg__markdown">
      <Markdown remarkPlugins={REMARK_PLUGINS} components={markdownComponents}>
        {text}
      </Markdown>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Parts
 * ------------------------------------------------------------------ */

function Reasoning({ part }: { part: ReasoningPart }): ReactNode {
  const [open, setOpen] = useState(false)
  const text = part.text.trim()
  if (text === '') return null

  return (
    <div className="msg__reasoning">
      <button
        type="button"
        className="msg__reasontoggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span> Thinking
      </button>
      {open ? <div className="msg__reasonbody">{text}</div> : null}
    </div>
  )
}

function fileLabel(part: FilePart): string {
  if (part.filename && part.filename.length > 0) return part.filename
  try {
    const withoutQuery = part.url.split('?')[0]
    const segment = withoutQuery.split(/[\\/]/).filter(Boolean).pop()
    if (segment && segment.length > 0) return decodeURIComponent(segment)
  } catch {
    /* fall through to the raw url */
  }
  return part.url
}

function FileChip({ part }: { part: FilePart }): ReactNode {
  return (
    <span className="msg__file" title={part.url}>
      <span className="msg__fileicon" aria-hidden="true">
        ⎙
      </span>
      <span className="msg__filename">{fileLabel(part)}</span>
      <span className="msg__filemime">{part.mime}</span>
    </span>
  )
}

/** Only text / reasoning / tool / file are rendered; every other Part member is dropped. */
function isRenderable(part: Part): part is TextPart | ReasoningPart | ToolPart | FilePart {
  if (part.type === 'text' || part.type === 'reasoning') return part.text.trim() !== ''
  return part.type === 'tool' || part.type === 'file'
}

function AssistantPart({ part }: { part: TextPart | ReasoningPart | ToolPart | FilePart }): ReactNode {
  switch (part.type) {
    case 'text':
      return <MarkdownText text={part.text} />
    case 'reasoning':
      return <Reasoning part={part} />
    case 'tool':
      return <ToolCall part={part} />
    case 'file':
      return <FileChip part={part} />
    default:
      return null
  }
}

/* ------------------------------------------------------------------ *
 * Message
 * ------------------------------------------------------------------ */

export function MessageView({ message }: { message: MessageWithParts }): ReactNode {
  const { info, parts } = message

  const textParts = useMemo(() => parts.filter(isTextPart), [parts])

  if (info.role === 'user') {
    const body = textParts
      .map((part) => part.text)
      .join('\n\n')
      .trim()
    const files = parts.filter(isFilePart)

    if (body === '' && files.length === 0) return null

    return (
      <article className="msg msg--user">
        <div className="msg__bubble">
          {body === '' ? null : <div className="msg__usertext">{body}</div>}
          {files.length > 0 ? (
            <div className="msg__files">
              {files.map((part) => (
                <FileChip key={part.id} part={part} />
              ))}
            </div>
          ) : null}
        </div>
      </article>
    )
  }

  const finished = info.time.completed !== undefined
  const failure = describeError(info.error)
  const elapsed =
    info.time.completed !== undefined ? info.time.completed - info.time.created : null

  const visible = parts.filter(isRenderable)

  return (
    <article className="msg msg--assistant">
      <div className="msg__parts">
        {visible.map((part) => (
          <div className="msg__part" key={part.id}>
            <AssistantPart part={part} />
          </div>
        ))}
      </div>

      {visible.length === 0 && !finished ? (
        <div className="msg__working" aria-label="Working">
          <span className="msg__dot" />
          <span className="msg__dot" />
          <span className="msg__dot" />
        </div>
      ) : null}

      {failure ? (
        <div className="msg__error" role="alert">
          <span className="msg__errorname">{failure.name}</span>
          <span className="msg__errormsg">{failure.message}</span>
        </div>
      ) : null}

      {finished ? (
        <footer className="msg__footer">
          <span className="msg__meta">{info.modelID}</span>
          <span className="msg__sep">·</span>
          <span className="msg__meta" title="input / output tokens">
            {formatTokens(info.tokens.input)} in · {formatTokens(info.tokens.output)} out
          </span>
          {info.tokens.reasoning > 0 ? (
            <>
              <span className="msg__sep">·</span>
              <span className="msg__meta">{formatTokens(info.tokens.reasoning)} reasoning</span>
            </>
          ) : null}
          {info.tokens.cache.read > 0 || info.tokens.cache.write > 0 ? (
            <>
              <span className="msg__sep">·</span>
              <span className="msg__meta" title="cache read / write">
                cache {formatTokens(info.tokens.cache.read)}r /{' '}
                {formatTokens(info.tokens.cache.write)}w
              </span>
            </>
          ) : null}
          <span className="msg__sep">·</span>
          <span className="msg__meta">{formatCost(info.cost)}</span>
          {elapsed !== null ? (
            <>
              <span className="msg__sep">·</span>
              <span className="msg__meta">{formatDuration(elapsed)}</span>
            </>
          ) : null}
        </footer>
      ) : null}
    </article>
  )
}
