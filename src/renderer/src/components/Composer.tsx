import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, KeyboardEvent, ReactNode } from 'react'
import { useStore } from '../lib/store'
import { getMatchingCommands, type SlashCommand } from '../lib/commands'
import { guessMime, joinPath, toFileUrl } from '../lib/fileurl'
import type { PromptPart } from '../lib/types'
import { MentionMenu } from './MentionMenu'
import { ModelPicker } from './ModelPicker'
import './composer.css'

const MAX_HEIGHT_RATIO = 0.4
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024 // 5 MB — larger drag-and-drop files are silently skipped

export function Composer(): ReactNode {
  const directory = useStore((state) => state.directory)
  const providerID = useStore((state) => state.providerID)
  const modelID = useStore((state) => state.modelID)
  const activeSessionID = useStore((state) => state.activeSessionID)
  const busy = useStore((state) => state.busy)
  const send = useStore((state) => state.send)
  const abort = useStore((state) => state.abort)
  const serverCommands = useStore((state) => state.serverCommands)
  const queuedPrompts = useStore((state) => state.queuedPrompts)
  const queuePrompt = useStore((state) => state.queuePrompt)
  const removeQueued = useStore((state) => state.removeQueued)

  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [slashIndex, setSlashIndex] = useState(0)
  const [attachments, setAttachments] = useState<Array<{ filename: string; absPath: string }>>([])
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [mentionStart, setMentionStart] = useState<number | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const areaRef = useRef<HTMLTextAreaElement | null>(null)

  const slashMatches = useMemo(() => {
    if (text.startsWith('/')) {
      return getMatchingCommands(text, serverCommands)
    }
    return []
  }, [text, serverCommands])

  const showSlashMenu = slashMatches.length > 0

  useEffect(() => {
    setSlashIndex(0)
  }, [slashMatches.length])

  const blocked: string | null = !directory
    ? 'Open a folder to start coding'
    : !providerID || !modelID
      ? 'Choose a model to start'
      : null

  const disabled = blocked !== null

  const resize = useCallback(() => {
    const area = areaRef.current
    if (!area) return
    area.style.height = 'auto'
    const max = Math.max(120, Math.round(window.innerHeight * MAX_HEIGHT_RATIO))
    const next = Math.min(area.scrollHeight, max)
    area.style.height = `${next}px`
    area.style.overflowY = area.scrollHeight > max ? 'auto' : 'hidden'
  }, [])

  useLayoutEffect(() => {
    resize()
  }, [text, resize])

  useEffect(() => {
    const onResize = (): void => resize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [resize])

  useEffect(() => {
    if (!disabled && activeSessionID) areaRef.current?.focus()
  }, [activeSessionID, disabled])

  const submit = useCallback(
    (customText?: string) => {
      const payload = (customText ?? text).trim()
      if (payload === '' || disabled || sending) return

      let fileParts: PromptPart[] | undefined = undefined
      if (attachments.length > 0) {
        fileParts = attachments.map((att) => ({
          type: 'file' as const,
          mime: guessMime(att.filename),
          filename: att.filename,
          url: toFileUrl(att.absPath)
        }))
      }

      if (busy) {
        queuePrompt(payload, fileParts)
        setText('')
        setAttachments([])
        setMentionQuery(null)
        setMentionStart(null)
        return
      }

      setSending(true)
      void (async () => {
        try {
          await send(payload, fileParts)
          if (useStore.getState().error === null) {
            setText('')
            setAttachments([])
            setMentionQuery(null)
            setMentionStart(null)
          }
        } catch {
          /* keep the draft */
        } finally {
          setSending(false)
          areaRef.current?.focus()
        }
      })()
    },
    [text, disabled, sending, busy, send, attachments, queuePrompt]
  )

  const selectSlashCommand = useCallback((cmd: SlashCommand) => {
    setText(`${cmd.name} `)
    areaRef.current?.focus()
  }, [])

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (showSlashMenu) {
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setSlashIndex((i) => (i + 1) % slashMatches.length)
          return
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          setSlashIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length)
          return
        }
        if (event.key === 'Tab') {
          event.preventDefault()
          const cmd = slashMatches[slashIndex]
          if (cmd) selectSlashCommand(cmd)
          return
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          setText('')
          return
        }
      }

      if (event.key !== 'Enter') return
      if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return
      if (event.nativeEvent.isComposing) return
      if (mentionQuery !== null) return // Let MentionMenu handle Enter if open
      event.preventDefault()

      if (showSlashMenu && text.trim().startsWith('/')) {
        const cmd = slashMatches[slashIndex]
        if (cmd && text.trim() === cmd.name) {
          submit()
        } else if (cmd) {
          submit(cmd.name)
        } else {
          submit()
        }
        return
      }

      submit()
    },
    [showSlashMenu, slashMatches, slashIndex, selectSlashCommand, submit, text, mentionQuery]
  )

  const onChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    const val = event.target.value
    setText(val)

    if (val.startsWith('/')) {
      setMentionQuery(null)
      setMentionStart(null)
      return
    }

    const cursor = event.target.selectionStart
    const textBeforeCursor = val.slice(0, cursor)
    const match = textBeforeCursor.match(/(?:^|\s)@([^\s]*)$/)

    if (match && match.index !== undefined) {
      const startIdx = match.index + (textBeforeCursor[match.index] === '@' ? 0 : 1)
      setMentionStart(startIdx)
      setMentionQuery(match[1])
    } else {
      setMentionQuery(null)
      setMentionStart(null)
    }
  }, [])

  const onSelectMention = useCallback((filepath: string) => {
    if (mentionStart === null) return
    const before = text.slice(0, mentionStart)
    const after = text.slice(areaRef.current?.selectionEnd || mentionStart + (mentionQuery?.length || 0) + 1)

    const newText = before + filepath + ' ' + after
    setText(newText)

    const parts = filepath.split(/[/\\]/)
    const filename = parts[parts.length - 1]
    const absPath = joinPath(directory || '', filepath)

    setAttachments((prev) => {
      if (prev.find((a) => a.absPath === absPath)) return prev
      return [...prev, { filename, absPath }]
    })

    setMentionQuery(null)
    setMentionStart(null)
    areaRef.current?.focus()
  }, [text, mentionStart, mentionQuery, directory])

  /** Only react to file drags — dragging plain text/HTML must not trigger the overlay or a drop. */
  const isFileDrag = (e: React.DragEvent): boolean => Array.from(e.dataTransfer.types).includes('Files')

  const onDragOver = useCallback(
    (e: React.DragEvent) => {
      if (disabled || !isFileDrag(e)) return
      e.preventDefault()
      e.stopPropagation()
      setIsDragging(true)
    },
    [disabled]
  )

  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
  }, [])

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      if (!isFileDrag(e)) return
      e.preventDefault()
      e.stopPropagation()
      setIsDragging(false)
      if (disabled) return

      const dropped = Array.from(e.dataTransfer.files)
      if (dropped.length === 0) return

      for (const file of dropped) {
        if (file.size > MAX_ATTACHMENT_BYTES) continue // silent skip, per spec

        const absPath = window.api.pathForFile(file)
        if (!absPath) continue // Electron 43 dropped File.path; empty result means "can't resolve"

        const segments = absPath.split(/[/\\]/)
        const filename = segments[segments.length - 1]
        setAttachments((prev) => {
          if (prev.some((a) => a.absPath === absPath)) return prev
          return [...prev, { filename, absPath }]
        })
      }
    },
    [disabled]
  )

  const canSend = !disabled && !sending && text.trim() !== ''

  return (
    <div
      className={`composer${disabled ? ' composer--disabled' : ''}${isDragging ? ' composer--drag-active' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {showSlashMenu && (
        <div className="composer__slash-menu" role="listbox">
          <div className="composer__slash-head">Claude Code Slash Commands</div>
          {slashMatches.map((cmd, idx) => (
            <button
              type="button"
              key={cmd.name}
              className={`composer__slash-item${idx === slashIndex ? ' composer__slash-item--active' : ''}`}
              onClick={() => submit(cmd.name)}
              onMouseEnter={() => setSlashIndex(idx)}
            >
              <span className="composer__slash-name">{cmd.name}</span>
              {cmd.isServerCommand && <span className="composer__slash-badge">Project</span>}
              <span className="composer__slash-desc">{cmd.description}</span>
            </button>
          ))}
        </div>
      )}

      {mentionQuery !== null && directory && (
        <MentionMenu
          query={mentionQuery}
          directory={directory}
          onSelect={onSelectMention}
          onClose={() => {
            setMentionQuery(null)
            setMentionStart(null)
          }}
        />
      )}

      {queuedPrompts.length > 0 && (
        <div className="composer__queue">
          {queuedPrompts.map((q, idx) => (
            <div key={idx} className="composer__queue-chip">
              <span className="composer__queue-text">{q.text}</span>
              <button type="button" onClick={() => removeQueued(idx)}>×</button>
            </div>
          ))}
        </div>
      )}

      {attachments.length > 0 && (
        <div className="composer__attachments">
          {attachments.map((att, idx) => (
            <div key={idx} className="composer__chip">
              <span>{att.filename}</span>
              <button type="button" onClick={() => setAttachments(prev => prev.filter((_, i) => i !== idx))}>×</button>
            </div>
          ))}
        </div>
      )}

      <div className="composer__box">
        <textarea
          ref={areaRef}
          className="composer__input"
          value={text}
          onChange={onChange}
          onKeyDown={onKeyDown}
          disabled={disabled}
          rows={1}
          spellCheck={false}
          placeholder={
            disabled
              ? (blocked ?? '')
              : 'Ask anything, or type / for commands…'
          }
          aria-label="Message"
        />
        <div className="composer__actions">
          <div className="composer__actions-left">
            <ModelPicker compact />
          </div>
          <div className="composer__actions-right">
          {canSend && (
            <button
              type="button"
              className="composer__send"
              onClick={() => submit()}
              title={busy ? 'Queue Message (Enter)' : 'Send (Enter)'}
            >
              {busy ? 'Queue' : sending ? 'Sending…' : 'Send'}
            </button>
          )}
          {busy && (
            <button
              type="button"
              className="composer__send composer__send--stop"
              onClick={() => {
                void abort()
              }}
              title="Stop the assistant"
            >
              <span className="composer__stopglyph" aria-hidden="true">
                ■
              </span>
              Stop
            </button>
          )}
          {!busy && !canSend && (
            <button
              type="button"
              className="composer__send"
              disabled
              title="Send (Enter)"
            >
              Send
            </button>
          )}
          </div>
        </div>
      </div>

      <div className="composer__footer">
        {blocked ? (
          <span className="composer__hint composer__hint--warn">{blocked}</span>
        ) : (
          <span className="composer__hint">Enter to send · Type / for slash commands</span>
        )}
      </div>
    </div>
  )
}
