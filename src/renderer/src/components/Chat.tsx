import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useStore } from '../lib/store'
import { isTextPart } from '../lib/types'
import { MessageView } from './MessageView'
import { Composer } from './Composer'
import { PermissionPrompt } from './PermissionPrompt'
import { TodoPanel } from './TodoPanel'
import { ChatSearch, SCROLL_TO_MESSAGE_EVENT } from './ChatSearch'
import { exportMarkdown } from '../lib/exportMarkdown'
import './messages.css'

/** Dispatched by Sidebar.tsx to open the global chat-search modal. */
const OPEN_SEARCH_EVENT = 'chat:open-search'

/** DOM id assigned to each rendered message row, used for scroll-to-message. */
function messageDomID(id: string): string {
  return `msg-${id}`
}

/** How close to the bottom still counts as "following along", in pixels. */
const STICK_THRESHOLD = 80

const SUGGESTIONS = [
  'Give me a tour of this codebase — entry points, structure, how it runs.',
  'Find the bug: run the tests and fix whatever fails.',
  'Add a README with setup and usage instructions.',
  'Review the recent changes for correctness and edge cases.'
]

function folderName(directory: string): string {
  const parts = directory.split(/[\\/]/).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : directory
}

export function Chat(): ReactNode {
  const messages = useStore((state) => state.messages)
  const permissions = useStore((state) => state.permissions)
  const error = useStore((state) => state.error)
  const directory = useStore((state) => state.directory)
  const activeSessionID = useStore((state) => state.activeSessionID)
  const providerID = useStore((state) => state.providerID)
  const modelID = useStore((state) => state.modelID)
  const dismissError = useStore((state) => state.dismissError)
  const replyPermission = useStore((state) => state.replyPermission)
  const pickDirectory = useStore((state) => state.pickDirectory)
  const newSession = useStore((state) => state.newSession)
  const send = useStore((state) => state.send)

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const innerRef = useRef<HTMLDivElement | null>(null)
  const [detached, setDetached] = useState(false)
  const detachedRef = useRef(false)

  const [searchOpen, setSearchOpen] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findIndex, setFindIndex] = useState(0)

  const setDetachedBoth = useCallback((value: boolean) => {
    detachedRef.current = value
    setDetached(value)
  }, [])

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const element = scrollRef.current
    if (!element) return
    element.scrollTo({ top: element.scrollHeight, behavior })
  }, [])

  const onScroll = useCallback(() => {
    const element = scrollRef.current
    if (!element) return
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    const next = distance > STICK_THRESHOLD
    if (next !== detachedRef.current) setDetachedBoth(next)
  }, [setDetachedBoth])

  // New content: follow it only when the user has not scrolled away.
  useLayoutEffect(() => {
    if (!detachedRef.current) scrollToBottom()
  }, [messages, scrollToBottom])

  // Streaming grows the transcript without changing its identity — watch the box.
  useEffect(() => {
    const inner = innerRef.current
    if (!inner || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (!detachedRef.current) scrollToBottom()
    })
    observer.observe(inner)
    return () => observer.disconnect()
  }, [scrollToBottom])

  // Switching sessions always lands at the newest message.
  useLayoutEffect(() => {
    setDetachedBoth(false)
    scrollToBottom()
  }, [activeSessionID, scrollToBottom, setDetachedBoth])

  // Global "search all chats" modal, opened from the sidebar.
  useEffect(() => {
    const openSearch = (): void => setSearchOpen(true)
    window.addEventListener(OPEN_SEARCH_EVENT, openSearch)
    return () => window.removeEventListener(OPEN_SEARCH_EVENT, openSearch)
  }, [])

  // A global-search hit lands here once its session is active — scroll to the message.
  useEffect(() => {
    const onScrollTo = (e: Event): void => {
      const messageID = (e as CustomEvent<{ messageID: string }>).detail?.messageID
      if (!messageID) return
      window.setTimeout(() => {
        document.getElementById(messageDomID(messageID))?.scrollIntoView({
          behavior: 'smooth',
          block: 'center'
        })
      }, 60)
    }
    window.addEventListener(SCROLL_TO_MESSAGE_EVENT, onScrollTo)
    return () => window.removeEventListener(SCROLL_TO_MESSAGE_EVENT, onScrollTo)
  }, [])

  // Ctrl+F opens an in-session find bar over the currently loaded messages.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setFindOpen(true)
      } else if (e.key === 'Escape' && findOpen) {
        setFindOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [findOpen])

  // Message ids (in display order) whose text matches the in-session find query.
  const findMatches = useMemo(() => {
    const q = findQuery.trim().toLowerCase()
    if (!q) return []
    return messages
      .filter((m) =>
        m.parts.some((p) => isTextPart(p) && p.text.toLowerCase().includes(q))
      )
      .map((m) => m.info.id)
  }, [messages, findQuery])

  useEffect(() => {
    setFindIndex(0)
  }, [findQuery])

  const gotoFindMatch = useCallback(
    (index: number) => {
      if (findMatches.length === 0) return
      const wrapped = ((index % findMatches.length) + findMatches.length) % findMatches.length
      setFindIndex(wrapped)
      document.getElementById(messageDomID(findMatches[wrapped]))?.scrollIntoView({
        behavior: 'smooth',
        block: 'center'
      })
    },
    [findMatches]
  )

  const canPrompt = directory !== null && providerID !== null && modelID !== null

  const runSuggestion = useCallback(
    (text: string) => {
      void send(text)
    },
    [send]
  )

  const showEmptySession = activeSessionID !== null && messages.length === 0

  return (
    <section className="chat">
      {messages.length > 0 && (
        <div className="chat__header-actions">
          <button
            type="button"
            className="chat__export-btn"
            title="Export Chat History to Markdown"
            onClick={async () => {
              const sessions = useStore.getState().sessions
              const session = sessions.find((s) => s.id === activeSessionID)
              const defaultName = `${session?.title || 'opencode-chat'}.md`.replace(/[^a-zA-Z0-9._-]/g, '_')
              const content = exportMarkdown(messages, {
                sessionTitle: session?.title,
                directory: directory ?? undefined,
                providerID: providerID ?? undefined,
                modelID: modelID ?? undefined,
                exportedAt: new Date()
              })
              try {
                await window.api.exportChat(defaultName, content)
              } catch (err) {
                useStore
                  .getState()
                  .addSystemNotice(`Export failed: ${err instanceof Error ? err.message : String(err)}`)
              }
            }}
          >
            📄 Export Markdown
          </button>
        </div>
      )}
      <div className="chat__scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="chat__inner" ref={innerRef}>
          {activeSessionID === null ? (
            <div className="chat__empty">
              <div className="chat__emptyglyph" aria-hidden="true">
                ◇
              </div>
              <h2 className="chat__emptytitle">
                {directory === null ? 'Open a folder to get started' : 'No session selected'}
              </h2>
              <p className="chat__emptybody">
                {directory === null
                  ? 'opencode-desktop works against a project directory. Pick one and start a session — any provider, any model.'
                  : `Working in ${folderName(directory)}. Start a new session or pick one from the sidebar.`}
              </p>
              <div className="chat__emptyactions">
                {directory === null ? (
                  <button
                    type="button"
                    className="chat__cta"
                    onClick={() => {
                      void pickDirectory()
                    }}
                  >
                    Open folder…
                  </button>
                ) : (
                  <button
                    type="button"
                    className="chat__cta"
                    onClick={() => {
                      void newSession()
                    }}
                  >
                    New session
                  </button>
                )}
              </div>
              {directory !== null ? <code className="chat__emptypath">{directory}</code> : null}
            </div>
          ) : showEmptySession ? (
            <div className="chat__empty">
              <div className="chat__emptyglyph" aria-hidden="true">
                ✦
              </div>
              <h2 className="chat__emptytitle">What should we build?</h2>
              <p className="chat__emptybody">
                {directory === null
                  ? 'Describe a change and the agent will work through it.'
                  : `This session is scoped to ${folderName(directory)}. Describe a change and the agent will work through it.`}
              </p>
              <ul className="chat__suggestions">
                {SUGGESTIONS.map((suggestion) => (
                  <li key={suggestion}>
                    <button
                      type="button"
                      className="chat__suggestion"
                      disabled={!canPrompt}
                      onClick={() => runSuggestion(suggestion)}
                    >
                      {suggestion}
                    </button>
                  </li>
                ))}
              </ul>
              {!canPrompt ? (
                <p className="chat__emptyhint">Choose a model before sending your first prompt.</p>
              ) : null}
            </div>
          ) : (
            messages.map((message) => (
              <div
                key={message.info.id}
                id={messageDomID(message.info.id)}
                className={
                  findOpen && findMatches[findIndex] === message.info.id
                    ? 'chat__msgwrap chat__msgwrap--findactive'
                    : 'chat__msgwrap'
                }
              >
                <MessageView message={message} />
              </div>
            ))
          )}
        </div>
      </div>

      {findOpen ? (
        <div className="chat__findbar" role="search" aria-label="Find in session">
          <input
            type="text"
            className="chat__findinput"
            placeholder="Find in this session…"
            value={findQuery}
            autoFocus
            onChange={(e) => setFindQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                gotoFindMatch(findIndex + (e.shiftKey ? -1 : 1))
              } else if (e.key === 'Escape') {
                setFindOpen(false)
              }
            }}
          />
          <span className="chat__findcount">
            {findMatches.length > 0 ? `${findIndex + 1}/${findMatches.length}` : '0/0'}
          </span>
          <button
            type="button"
            className="chat__findnav"
            disabled={findMatches.length === 0}
            onClick={() => gotoFindMatch(findIndex - 1)}
            title="Previous match (Shift+Enter)"
          >
            ↑
          </button>
          <button
            type="button"
            className="chat__findnav"
            disabled={findMatches.length === 0}
            onClick={() => gotoFindMatch(findIndex + 1)}
            title="Next match (Enter)"
          >
            ↓
          </button>
          <button
            type="button"
            className="chat__findclose"
            onClick={() => setFindOpen(false)}
            aria-label="Close find"
          >
            ✕
          </button>
        </div>
      ) : null}

      {detached ? (
        <button
          type="button"
          className="chat__jump"
          onClick={() => {
            setDetachedBoth(false)
            scrollToBottom('smooth')
          }}
        >
          Jump to latest <span aria-hidden="true">↓</span>
        </button>
      ) : null}

      <div className="chat__dock">
        {error !== null ? (
          <div className="chat__banner" role="alert">
            <span className="chat__bannericon" aria-hidden="true">
              ⚠
            </span>
            <span className="chat__bannertext">{error}</span>
            <button
              type="button"
              className="chat__bannerclose"
              onClick={dismissError}
              aria-label="Dismiss error"
            >
              ✕
            </button>
          </div>
        ) : null}

        {permissions.length > 0 ? (
          <div className="chat__permissions">
            {permissions.map((permission) => (
              <PermissionPrompt
                key={permission.id}
                permission={permission}
                onRespond={(response) => {
                  void replyPermission(permission.id, response)
                }}
              />
            ))}
          </div>
        ) : null}

        <TodoPanel />
        <Composer />
      </div>

      <ChatSearch open={searchOpen} onClose={() => setSearchOpen(false)} />
    </section>
  )
}
