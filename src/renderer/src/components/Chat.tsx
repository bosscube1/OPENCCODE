import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useStore } from '../lib/store'
import { isTextPart } from '../lib/types'
import { MessageView } from './MessageView'
import { Composer } from './Composer'
import { PermissionPrompt } from './PermissionPrompt'
import { SubagentTabs, SubagentView } from './SubagentTabs'
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

/**
 * Only the newest slice of a session is mounted. Long agentic sessions ran into
 * hundreds of messages, each rendering its own tool calls, and re-rendered the
 * lot on every streamed token.
 *
 * Windowing rather than a virtualiser is deliberate: the sticky-scroll effects
 * and the two scroll-to-message paths (in-session find and global chat search)
 * all resolve a message by DOM id, and a virtualiser would mean rebuilding all
 * of that. The cost is that those paths must widen the window before scrolling
 * — see `revealMessage`.
 */
const WINDOW_STEP = 60
/** Tool calls older than this many messages from the end start collapsed. */
const TOOLS_EXPANDED_TAIL = 10

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
  const subagentTabCount = useStore((state) => state.subagentTabs.length)
  const activeSubagentTab = useStore((state) => state.activeSubagentTab)
  /** Set while the active session is reverted to an earlier point (SDK `Session.revert`). */
  const revertInfo = useStore((state) => {
    const id = state.activeSessionID
    if (!id) return undefined
    return state.sessions.find((s) => s.id === id)?.revert
  })
  const unrevertSession = useStore((state) => state.unrevertSession)
  // True when a subagent tab is being viewed instead of the main transcript.
  const viewingSubagent = activeSubagentTab !== null

  // Messages at/after the revert point are the hidden ones — countable only while the
  // local transcript still contains them (an optimistic edit-and-resend slices it).
  let hiddenCount = 0
  if (revertInfo) {
    const idx = messages.findIndex((m) => m.info.id === revertInfo.messageID)
    if (idx >= 0) hiddenCount = messages.length - idx
  }

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const innerRef = useRef<HTMLDivElement | null>(null)
  const [detached, setDetached] = useState(false)
  const detachedRef = useRef(false)

  const [windowSize, setWindowSize] = useState(WINDOW_STEP)
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

  /* ---- windowing --------------------------------------------------------- */

  const olderCount = Math.max(0, messages.length - windowSize)
  const visibleMessages = olderCount > 0 ? messages.slice(olderCount) : messages

  // Prepending older messages grows the scroll box upwards, which would yank the
  // reader's position. Pin the distance from the BOTTOM, which is invariant here.
  const loadOlder = useCallback(() => {
    const element = scrollRef.current
    const anchor = element ? element.scrollHeight - element.scrollTop : null
    setWindowSize((size) => size + WINDOW_STEP)
    if (element === null || anchor === null) return
    window.requestAnimationFrame(() => {
      const current = scrollRef.current
      if (current) current.scrollTop = current.scrollHeight - anchor
    })
  }, [])

  /**
   * Scroll to a message, widening the window first when it sits outside it.
   * Both scroll-to-message paths MUST go through here: the element does not
   * exist in the DOM until the widened window has rendered, so the scroll is
   * deferred a frame.
   */
  const revealMessage = useCallback(
    (messageID: string, behavior: ScrollBehavior = 'smooth') => {
      const index = messages.findIndex((m) => m.info.id === messageID)
      if (index < 0) return
      const needed = messages.length - index
      if (needed > windowSize) setWindowSize(needed + WINDOW_STEP)
      window.requestAnimationFrame(() => {
        document.getElementById(messageDomID(messageID))?.scrollIntoView({ behavior, block: 'center' })
      })
    },
    [messages, windowSize]
  )

  // New content: follow it only when the user has not scrolled away. Returning from a
  // subagent tab remounts the scroll container, so re-follow on that transition too.
  useLayoutEffect(() => {
    if (!detachedRef.current) scrollToBottom()
  }, [messages, scrollToBottom, viewingSubagent])

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

  // Switching sessions always lands at the newest message, with a fresh window —
  // an expanded window must not carry over into an unrelated session.
  useLayoutEffect(() => {
    setDetachedBoth(false)
    setWindowSize(WINDOW_STEP)
    scrollToBottom()
  }, [activeSessionID, scrollToBottom, setDetachedBoth])

  // Global "search all chats" modal, opened from the sidebar.
  useEffect(() => {
    const openSearch = (): void => setSearchOpen(true)
    window.addEventListener(OPEN_SEARCH_EVENT, openSearch)
    return () => window.removeEventListener(OPEN_SEARCH_EVENT, openSearch)
  }, [])

  // A global-search hit lands here once its session is active — scroll to the
  // message, widening the window when the hit is older than what is mounted.
  useEffect(() => {
    const onScrollTo = (e: Event): void => {
      const messageID = (e as CustomEvent<{ messageID: string }>).detail?.messageID
      if (!messageID) return
      // The delay stays: the session's messages may still be loading when the hit arrives.
      window.setTimeout(() => revealMessage(messageID), 60)
    }
    window.addEventListener(SCROLL_TO_MESSAGE_EVENT, onScrollTo)
    return () => window.removeEventListener(SCROLL_TO_MESSAGE_EVENT, onScrollTo)
  }, [revealMessage])

  // Ctrl+F opens an in-session find bar over the currently loaded messages.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
        // Sidebar.tsx has advertised Ctrl+Shift+F in its tooltip all along while
        // nothing bound it. Same event the sidebar button dispatches.
        e.preventDefault()
        setSearchOpen(true)
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'f') {
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

  // findMatches is computed over ALL messages, not the mounted window, so find
  // still reaches matches that are scrolled out of the window — revealMessage
  // mounts them on demand.
  const gotoFindMatch = useCallback(
    (index: number) => {
      if (findMatches.length === 0) return
      const wrapped = ((index % findMatches.length) + findMatches.length) % findMatches.length
      setFindIndex(wrapped)
      revealMessage(findMatches[wrapped])
    },
    [findMatches, revealMessage]
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
      {subagentTabCount > 0 ? <SubagentTabs /> : null}
      {viewingSubagent ? (
        <SubagentView sessionID={activeSubagentTab} />
      ) : (
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
              <>
                {olderCount > 0 ? (
                  <button type="button" className="chat__loadolder" onClick={loadOlder}>
                    Load {Math.min(WINDOW_STEP, olderCount)} earlier message
                    {Math.min(WINDOW_STEP, olderCount) === 1 ? '' : 's'}
                    <span className="chat__loadolder-count">{olderCount} older</span>
                  </button>
                ) : null}
                {visibleMessages.map((message, index) => (
                  <div
                    key={message.info.id}
                    id={messageDomID(message.info.id)}
                    className={
                      findOpen && findMatches[findIndex] === message.info.id
                        ? 'chat__msgwrap chat__msgwrap--findactive'
                        : 'chat__msgwrap'
                    }
                  >
                    <MessageView
                      message={message}
                      collapseTools={visibleMessages.length - index > TOOLS_EXPANDED_TAIL}
                    />
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      )}

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

        {revertInfo && !viewingSubagent ? (
          <div className="chat__revert" role="status">
            <span className="chat__reverttext">
              This chat is reverted to an earlier point
              {hiddenCount > 0
                ? ` — ${hiddenCount} message${hiddenCount === 1 ? '' : 's'} hidden`
                : ' — later messages are hidden'}
              .
            </span>
            <button
              type="button"
              className="chat__revertbtn"
              onClick={() => {
                void unrevertSession()
              }}
            >
              Restore
            </button>
          </div>
        ) : null}

        <TodoPanel />
        {/* The composer stays bound to the main session; the subagent view is read-only
            and shows its own notice bar with a stop control instead. */}
        {viewingSubagent ? null : <Composer />}
      </div>

      <ChatSearch open={searchOpen} onClose={() => setSearchOpen(false)} />
    </section>
  )
}
