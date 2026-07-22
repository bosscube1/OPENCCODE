import { useRef, useState } from 'react'
import type { FormEvent, JSX, KeyboardEvent } from 'react'
import './quick-entry.css'

export function QuickEntry(): JSX.Element {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const submit = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault()
    if (submitting) return

    const prompt = text.trim()
    if (prompt.length === 0) {
      setError('Enter a prompt first.')
      textareaRef.current?.focus()
      return
    }

    setSubmitting(true)
    setError(null)
    try {
      await window.api.quick.submit(prompt)
      setText('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      textareaRef.current?.focus()
    } finally {
      setSubmitting(false)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      window.close()
      return
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void submit()
    }
  }

  return (
    <main className="quick-entry">
      <form className="quick-entry__composer" onSubmit={(event) => void submit(event)}>
        <textarea
          ref={textareaRef}
          className="quick-entry__input"
          value={text}
          onChange={(event) => {
            setText(event.target.value)
            if (error) setError(null)
          }}
          onKeyDown={onKeyDown}
          placeholder="Ask OpenCode anything..."
          aria-label="Quick entry prompt"
          aria-describedby={error ? 'quick-entry-error' : 'quick-entry-hint'}
          autoFocus
          disabled={submitting}
          rows={3}
        />
        <div className="quick-entry__footer">
          <div className="quick-entry__feedback">
            {error ? (
              <span id="quick-entry-error" className="quick-entry__error" role="alert">
                {error}
              </span>
            ) : (
              <span id="quick-entry-hint" className="quick-entry__hint">
                Enter to send | Shift+Enter for a new line | Esc to close
              </span>
            )}
          </div>
          <button
            type="submit"
            className="quick-entry__submit"
            disabled={submitting || text.trim().length === 0}
          >
            {submitting ? 'Sending...' : 'Send'}
          </button>
        </div>
      </form>
    </main>
  )
}
