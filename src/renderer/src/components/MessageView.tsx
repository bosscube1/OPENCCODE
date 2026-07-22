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
  ToolPart
} from '../lib/types'
import { isFilePart, isTextPart } from '../lib/types'
import { formatCost, formatDuration, formatTokens } from '../lib/format'
import { guessMime } from '../lib/fileurl'
import { ToolCall } from './ToolCall'
import { ImageLightbox } from './ImageLightbox'
import { highlightCode } from '../lib/highlight'
import { extractArtifactsFromMessages } from '../lib/artifacts'
import { useStore } from '../lib/store'

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

  const html = highlightCode(code, language)

  return (
    <div className="msg__codeblock">
      <div className="msg__codebar">
        <span className="msg__codelang">{language || 'text'}</span>
        <button type="button" className="msg__copy" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="msg__codepre">
        {html ? (
          <code
            className={`hljs language-${language}`}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <code>{code}</code>
        )}
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

function MarkdownText({ text, caret }: { text: string; caret?: boolean }): ReactNode {
  return (
    <div className="msg__markdown">
      <Markdown remarkPlugins={REMARK_PLUGINS} components={markdownComponents}>
        {text}
      </Markdown>
      {caret ? <span className="msg__caret">▌</span> : null}
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

function isImageFile(part: FilePart): boolean {
  const mime = part.mime || guessMime(fileLabel(part))
  return mime.startsWith('image/')
}

function ImageThumbnail({
  part,
  onOpen
}: {
  part: FilePart
  onOpen: (src: string) => void
}): ReactNode {
  return (
    <img
      className="msg__thumb"
      src={part.url}
      alt={fileLabel(part)}
      onClick={() => onOpen(part.url)}
      title={fileLabel(part)}
    />
  )
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

/** Only text / reasoning / tool / file / retry / compaction / subtask are rendered; every other Part member is dropped. */
function isRenderable(part: Part): boolean {
  if (part.type === 'text' || part.type === 'reasoning') return part.text.trim() !== ''
  return ['tool', 'file', 'retry', 'compaction', 'subtask'].includes(part.type)
}

function AssistantPart({
  part,
  caret,
  onImageOpen
}: {
  part: Part
  caret?: boolean
  onImageOpen?: (src: string) => void
}): ReactNode {
  switch (part.type) {
    case 'text':
      return <MarkdownText text={part.text} caret={caret} />
    case 'reasoning':
      return <Reasoning part={part} />
    case 'tool':
      return <ToolCall part={part as ToolPart} />
    case 'file': {
      const filePart = part as FilePart
      if (isImageFile(filePart) && onImageOpen) {
        return <ImageThumbnail part={filePart} onOpen={onImageOpen} />
      }
      return <FileChip part={filePart} />
    }
    case 'retry':
      return <div className="msg__retry-chip">Retry {part.attempt}</div>
    case 'compaction':
      return <hr className="msg__compaction-divider" />
    case 'subtask':
      return <div className="msg__subtask-chip">Subtask: {part.description}</div>
    default:
      return null
  }
}

/* ------------------------------------------------------------------ *
 * Message
 * ------------------------------------------------------------------ */

export function MessageView({ message }: { message: MessageWithParts }): ReactNode {
  const [copiedText, setCopiedText] = useState(false)
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)
  const [editingText, setEditingText] = useState<string | null>(null)
  const { info, parts } = message

  const textParts = useMemo(() => parts.filter(isTextPart), [parts])
  const msgArtifacts = useMemo(() => extractArtifactsFromMessages([message]), [message])

  if (info.role === 'user') {
    const body = textParts
      .map((part) => part.text)
      .join('\n\n')
      .trim()
    const files = parts.filter(isFilePart)

    if (body === '' && files.length === 0) return null

    const handleEdit = () => {
      setEditingText(body)
    }

    const handleSaveEdit = () => {
      if (editingText && editingText.trim() !== body.trim()) {
        const confirmed = window.confirm(
          'Editing resends from here. This reverts the conversation and any file changes made after this message. Continue?'
        )
        if (confirmed) {
          void useStore.getState().editAndResend(info.id, editingText.trim())
          setEditingText(null)
        }
      } else {
        setEditingText(null)
      }
    }

    const handleCancelEdit = () => {
      setEditingText(null)
    }

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Escape') {
        handleCancelEdit()
      }
    }

    return (
      <article className="msg msg--user">
        <div className="msg__bubble">
          {editingText !== null ? (
            <div className="msg__edit-container">
              <textarea
                className="msg__edit-area"
                value={editingText}
                onChange={(e) => setEditingText(e.currentTarget.value)}
                onKeyDown={handleKeyDown}
                autoFocus
              />
              <div className="msg__edit-actions">
                <button
                  type="button"
                  className="msg__edit-save"
                  onClick={handleSaveEdit}
                  disabled={editingText.trim() === body.trim()}
                >
                  Save
                </button>
                <button type="button" className="msg__edit-cancel" onClick={handleCancelEdit}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              {body === '' ? null : (
                <div className="msg__usertext-wrapper">
                  <div className="msg__usertext">{body}</div>
                  <button
                    type="button"
                    className="msg__edit-btn"
                    onClick={handleEdit}
                    title="Edit message"
                  >
                    Edit
                  </button>
                </div>
              )}
              {files.length > 0 ? (
                <div className="msg__files">
                  {files.map((part) => {
                    const isImage = isImageFile(part)
                    return isImage ? (
                      <ImageThumbnail
                        key={part.id}
                        part={part}
                        onOpen={setLightboxSrc}
                      />
                    ) : (
                      <FileChip key={part.id} part={part} />
                    )
                  })}
                </div>
              ) : null}
            </>
          )}
        </div>
        {lightboxSrc && (
          <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
        )}
      </article>
    )
  }

  const finished = info.time.completed !== undefined
  const failure = describeError(info.error)
  const elapsed =
    info.time.completed !== undefined ? info.time.completed - info.time.created : null

  const visible = parts.filter(isRenderable)
  const lastTextPart = textParts[textParts.length - 1]
  return (
    <article className="msg msg--assistant">
      {msgArtifacts.length > 0 && (
        <div className="msg__artifacts" style={{ marginBottom: '8px' }}>
          {msgArtifacts.map((art) => (
            <button
              key={art.id}
              type="button"
              className="msg__artifact-chip"
              onClick={() => useStore.getState().setActiveArtifactID(art.id)}
              title={`Click to open ${art.title} in preview panel`}
            >
              <span className="msg__artifact-icon">⚡</span>
              <span>Open Artifact: {art.title}</span>
            </button>
          ))}
        </div>
      )}
      <div className="msg__parts">
        {visible.map((part) => (
          <div className="msg__part" key={part.id}>
            <AssistantPart
              part={part}
              caret={!finished && part === lastTextPart}
              onImageOpen={setLightboxSrc}
            />
          </div>
        ))}
      </div>
      {lightboxSrc && (
        <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
      )}

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
          <span className="msg__sep">·</span>
          <button
            type="button"
            className="msg__retry-btn"
            onClick={() => {
              const fullText = textParts.map((p) => p.text).join('\n\n')
              void navigator.clipboard.writeText(fullText)
              setCopiedText(true)
              window.setTimeout(() => setCopiedText(false), 1500)
            }}
          >
            {copiedText ? 'Copied' : 'Copy'}
          </button>
          <span className="msg__sep">·</span>
          <button
            type="button"
            className="msg__retry-btn"
            onClick={() => useStore.getState().retryExchange(message.info.id)}
          >
            Regenerate
          </button>
        </footer>
      ) : null}
    </article>
  )
}
