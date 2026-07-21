import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useStore } from '../lib/store'
import { MessageView } from './MessageView'
import { Composer } from './Composer'
import { PermissionPrompt } from './PermissionPrompt'
import './chat.css'

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
            messages.map((message) => <MessageView key={message.info.id} message={message} />)
          )}
        </div>
      </div>

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

        <Composer />
      </div>
    </section>
  )
}
