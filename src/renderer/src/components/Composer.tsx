import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, KeyboardEvent, ReactNode } from 'react'
import { useStore } from '../lib/store'

const MAX_HEIGHT_RATIO = 0.4

export function Composer(): ReactNode {
  const directory = useStore((state) => state.directory)
  const providerID = useStore((state) => state.providerID)
  const modelID = useStore((state) => state.modelID)
  const providers = useStore((state) => state.providers)
  const activeSessionID = useStore((state) => state.activeSessionID)
  const busy = useStore((state) => state.busy)
  const send = useStore((state) => state.send)
  const abort = useStore((state) => state.abort)

  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const areaRef = useRef<HTMLTextAreaElement | null>(null)

  const modelLabel = useMemo(() => {
    if (!providerID || !modelID) return null
    const provider = providers.find((candidate) => candidate.id === providerID)
    const model = provider?.models?.[modelID]
    const name = model?.name ?? modelID
    return provider ? `${provider.name} · ${name}` : name
  }, [providers, providerID, modelID])

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

  const submit = useCallback(() => {
    const payload = text.trim()
    if (payload === '' || disabled || sending || busy) return
    setSending(true)
    void (async () => {
      try {
        await send(payload)
        // `send` reports failures by setting `error` rather than throwing, so a
        // clean error slot is what tells us the prompt actually went out.
        if (useStore.getState().error === null) setText('')
      } catch {
        /* keep the draft; the store surfaces the failure in its banner */
      } finally {
        setSending(false)
        areaRef.current?.focus()
      }
    })()
  }, [text, disabled, sending, busy, send])

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== 'Enter') return
      if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return
      if (event.nativeEvent.isComposing) return
      event.preventDefault()
      submit()
    },
    [submit]
  )

  const onChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    setText(event.target.value)
  }, [])

  const canSend = !disabled && !sending && text.trim() !== ''

  return (
    <div className={`composer${disabled ? ' composer--disabled' : ''}`}>
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
              : 'Ask anything, or describe a change…'
          }
          aria-label="Message"
        />
        {busy ? (
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
        ) : (
          <button
            type="button"
            className="composer__send"
            onClick={submit}
            disabled={!canSend}
            title="Send (Enter)"
          >
            {sending ? 'Sending…' : 'Send'}
          </button>
        )}
      </div>

      <div className="composer__footer">
        {blocked ? (
          <span className="composer__hint composer__hint--warn">{blocked}</span>
        ) : (
          <span className="composer__hint">Enter to send · Shift+Enter for a new line</span>
        )}
        {modelLabel ? <span className="composer__model">{modelLabel}</span> : null}
      </div>
    </div>
  )
}
