import { isValidElement, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { isAssistant, isFilePart, isReasoningPart, isTextPart } from '../lib/types'
import { formatCost, formatDuration, formatTokens } from '../lib/format'
import { guessMime } from '../lib/fileurl'
import { ToolCall } from './ToolCall'
import { ImageLightbox } from './ImageLightbox'
import { highlightCode } from '../lib/highlight'
import { extractArtifactsFromMessages } from '../lib/artifacts'
import { useStore } from '../lib/store'
import { isAgentModel } from '../lib/models'
import { isFreeModel } from '../lib/freeTier'

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
  onImageOpen,
  collapseTools
}: {
  part: Part
  caret?: boolean
  onImageOpen?: (src: string) => void
  collapseTools?: boolean
}): ReactNode {
  switch (part.type) {
    case 'text':
      return <MarkdownText text={part.text} caret={caret} />
    case 'reasoning':
      return <Reasoning part={part} />
    case 'tool':
      return <ToolCall part={part as ToolPart} collapsed={collapseTools} />
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
 * Regenerate split control
 * ------------------------------------------------------------------ */

/**
 * A split button: the primary half keeps the existing one-click "Regenerate" behaviour
 * (resend with the current store model); the chevron half opens a menu to pick a
 * different model for this one resend only. Model list uses the same store selectors
 * and free-vs-paid filter as ModelPicker.tsx, rather than a second list-building path.
 */
function RegenerateSplitButton({ messageID }: { messageID: string }): ReactNode {
  const providers = useStore((s) => s.providers)
  const showPaidModels = useStore((s) => s.showPaidModels)
  const [open, setOpen] = useState(false)

  const rootRef = useRef<HTMLDivElement | null>(null)
  const chevRef = useRef<HTMLButtonElement | null>(null)

  const groups = useMemo(() => {
    return providers
      .map((p) => ({
        provider: p,
        models: Object.values(p.models)
          .filter((m) => isAgentModel(m))
          .filter((m) => showPaidModels || isFreeModel(p.id, m.id))
          .sort((a, b) => a.name.localeCompare(b.name))
      }))
      .filter((g) => g.models.length > 0)
  }, [providers, showPaidModels])

  const close = useCallback(() => setOpen(false), [])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const el = rootRef.current
      if (el && e.target instanceof Node && !el.contains(e.target)) close()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
        chevRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, close])

  return (
    <div className="msg__regen" ref={rootRef}>
      <button
        type="button"
        className="msg__retry-btn msg__regen-main"
        onClick={() => void useStore.getState().retryExchange(messageID)}
      >
        Regenerate
      </button>
      <button
        type="button"
        ref={chevRef}
        className="msg__retry-btn msg__regen-chev"
        aria-label="Regenerate with a different model"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        ▾
      </button>
      {open ? (
        <div className="msg__regen-menu" role="menu" aria-label="Choose a model to regenerate with">
          {groups.length === 0 ? (
            <div className="msg__regen-empty">No models available.</div>
          ) : (
            groups.map((g) => (
              <div className="msg__regen-group" key={g.provider.id}>
                <div className="msg__regen-group-head">{g.provider.name}</div>
                {g.models.map((m) => (
                  <button
                    type="button"
                    key={`${g.provider.id}/${m.id}`}
                    role="menuitem"
                    className="msg__regen-item"
                    onClick={() => {
                      close()
                      void useStore
                        .getState()
                        .retryExchange(messageID, { providerID: g.provider.id, modelID: m.id })
                    }}
                  >
                    {m.name}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Message
 * ------------------------------------------------------------------ */

function MessageViewImpl({
  message,
  collapseTools = false,
  hideTools = false
}: {
  message: MessageWithParts
  collapseTools?: boolean
  /** Summary view mode: drop tool cards from the transcript entirely. */
  hideTools?: boolean
}): ReactNode {
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
                  <button
                    type="button"
                    className="msg__edit-btn msg__branch-btn"
                    onClick={() => void useStore.getState().branchFromMessage(info.id)}
                    title="Branch a new conversation from this message"
                  >
                    Branch
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

  // Summary mode drops tool cards but keeps `file` parts (attachments the user can see)
  // and `compaction`/`retry` notices, which explain gaps in the prose rather than adding
  // to the noise the mode exists to remove.
  const visible = parts.filter(
    (part) => isRenderable(part) && !(hideTools && (part.type === 'tool' || part.type === 'subtask'))
  )
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
              collapseTools={collapseTools}
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
          <RegenerateSplitButton messageID={message.info.id} />
        </footer>
      ) : null}
    </article>
  )
}

/**
 * During a stream, the store mutates in place and keeps re-handing us the SAME
 * `message` identity while `parts` grows and the last part's text lengthens token by
 * token — a naive `memo` (or none at all) either re-renders every message on every
 * token (the perf bug this fixes) or freezes mid-stream because it bails out on an
 * unchanged object reference. So we compare cheap, streaming-relevant signals instead
 * of the object identity:
 *  - `message.info.id` — a different message entirely.
 *  - `collapseTools` — orchestrator-driven prop; flips as older messages scroll out
 *    of the "recent" window.
 *  - `hideTools` — Summary view mode; changes which parts are rendered at all. Like
 *    `collapseTools` this is a prop, not message state, so it MUST be compared here:
 *    switching view mode does not touch `message`, so without this line every already-
 *    mounted message would keep its old density and only new ones would honour the mode.
 *  - `parts.length` — a new part (tool call, file, etc.) appeared.
 *  - the last part's text length — the common case: the tail text/reasoning part
 *    growing character by character during a stream. Not every part has `.text`
 *    (e.g. tool/file parts), so this is read defensively.
 *  - for assistant messages: `info.time.completed` and `info.error`, since those flip
 *    in place when the message finishes or fails, driving the footer/error UI, without
 *    touching `parts` at all.
 */
function messagePropsAreEqual(
  prev: { message: MessageWithParts; collapseTools?: boolean; hideTools?: boolean },
  next: { message: MessageWithParts; collapseTools?: boolean; hideTools?: boolean }
): boolean {
  if (prev.collapseTools !== next.collapseTools) return false
  if (prev.hideTools !== next.hideTools) return false

  const prevInfo = prev.message.info
  const nextInfo = next.message.info
  if (prevInfo.id !== nextInfo.id) return false

  const prevParts = prev.message.parts
  const nextParts = next.message.parts
  if (prevParts.length !== nextParts.length) return false

  const prevLast = prevParts[prevParts.length - 1]
  const nextLast = nextParts[nextParts.length - 1]
  const partTextLength = (part: Part | undefined): number => {
    if (part === undefined) return 0
    if (isTextPart(part) || isReasoningPart(part)) return part.text.length
    return 0
  }
  if (partTextLength(prevLast) !== partTextLength(nextLast)) return false

  if (isAssistant(prevInfo) && isAssistant(nextInfo)) {
    if (prevInfo.time.completed !== nextInfo.time.completed) return false
    if (prevInfo.error !== nextInfo.error) return false
  } else if (prevInfo.role !== nextInfo.role) {
    return false
  }

  return true
}

export const MessageView = memo(MessageViewImpl, messagePropsAreEqual)
