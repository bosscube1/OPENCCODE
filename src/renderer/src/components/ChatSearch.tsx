import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useStore } from '../lib/store'
import { relativeTime } from '../lib/format'
import { splitHighlight } from '../lib/search'

/** Mirrors the shape returned by `window.api.searchChats` (Stream 2A / preload). */
type ChatSearchHit = {
  sessionID: string
  title: string
  messageID: string
  snippet: string
  time: number
}

/** Dispatched with `{ detail: { messageID: string } }` once the target session is active. */
export const SCROLL_TO_MESSAGE_EVENT = 'chat:scroll-to-message'

function Snippet({ text, query }: { text: string; query: string }): ReactNode {
  const parts = splitHighlight(text, query)
  return (
    <>
      {parts.map((p, i) =>
        p.match ? (
          <mark key={i} className="chatsearch__mark">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        )
      )}
    </>
  )
}

export function ChatSearch({ open, onClose }: { open: boolean; onClose: () => void }): ReactNode {
  const directory = useStore((s) => s.directory)
  const selectSession = useStore((s) => s.selectSession)

  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ChatSearchHit[]>([])
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Reset transient state whenever the modal opens fresh.
  useEffect(() => {
    if (!open) return
    setQuery('')
    setResults([])
    setSearched(false)
    setErr(null)
    const t = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const runSearch = async (): Promise<void> => {
    if (!directory || !query.trim()) return
    setLoading(true)
    setErr(null)
    try {
      const hits = await window.api.searchChats(directory, query.trim())
      setResults(hits)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setResults([])
    } finally {
      setLoading(false)
      setSearched(true)
    }
  }

  const handleClick = (hit: ChatSearchHit): void => {
    void selectSession(hit.sessionID).then(() => {
      onClose()
      window.dispatchEvent(
        new CustomEvent(SCROLL_TO_MESSAGE_EVENT, { detail: { messageID: hit.messageID } })
      )
    })
  }

  return (
    <div
      className="providers chatsearch"
      role="dialog"
      aria-modal="true"
      aria-label="Search all chats"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="providers__panel chatsearch__panel">
        <div className="providers__head">
          <span className="providers__title">Search chats</span>
          <button type="button" className="providers__close" onClick={onClose} title="Close (Esc)">
            ×
          </button>
        </div>

        <div className="providers__body chatsearch__body">
          {directory === null ? (
            <p className="providers__empty">Open a project first.</p>
          ) : (
            <>
              <div className="chatsearch__inputrow">
                <input
                  ref={inputRef}
                  type="text"
                  className="chatsearch__input"
                  placeholder="Search all sessions in this project…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void runSearch()
                  }}
                />
                {loading ? <span className="chatsearch__spinner" aria-hidden="true" /> : null}
              </div>

              {err !== null ? <p className="chatsearch__error">{err}</p> : null}

              {!loading && searched && results.length === 0 ? (
                <p className="providers__empty">No matches for &ldquo;{query.trim()}&rdquo;.</p>
              ) : null}

              {!loading && !searched ? (
                <p className="providers__empty">
                  Type a query and press Enter to search across every session&apos;s messages.
                </p>
              ) : null}

              <div className="chatsearch__results">
                {results.map((hit) => (
                  <button
                    type="button"
                    key={`${hit.sessionID}-${hit.messageID}`}
                    className="chatsearch__row"
                    onClick={() => handleClick(hit)}
                  >
                    <div className="chatsearch__row-head">
                      <span className="chatsearch__row-title">{hit.title || 'Untitled'}</span>
                      <span className="chatsearch__row-time">{relativeTime(hit.time)}</span>
                    </div>
                    <div className="chatsearch__row-snippet">
                      <Snippet text={hit.snippet} query={query.trim()} />
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
