import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { useStore } from '../lib/store'
import { isSideChatTitle, splitSideChatTitle, splitSubagentTitle } from '../lib/subagents'
import { MessageView } from './MessageView'
import './subagent-tabs.css'

/**
 * Tab strip above the chat transcript: "Main" plus one tab per open subagent session.
 * Rendered only when at least one subagent tab exists (Chat gates on subagentTabs.length).
 */
export function SubagentTabs(): ReactNode {
  const tabs = useStore((state) => state.subagentTabs)
  const active = useStore((state) => state.activeSubagentTab)
  const sessions = useStore((state) => state.sessions)
  const busy = useStore((state) => state.subagentBusy)
  const errors = useStore((state) => state.subagentError)
  const setActiveSubagentTab = useStore((state) => state.setActiveSubagentTab)
  const closeSubagentTab = useStore((state) => state.closeSubagentTab)

  if (tabs.length === 0) return null

  return (
    <div className="subagent-tabs" role="tablist" aria-label="Subagent sessions">
      <button
        type="button"
        role="tab"
        aria-selected={active === null}
        className={`subagent-tabs__tab ${active === null ? 'subagent-tabs__tab--active' : ''}`}
        onClick={() => setActiveSubagentTab(null)}
      >
        Main
      </button>
      {tabs.map((id) => {
        const session = sessions.find((s) => s.id === id)
        // A `/btw` side chat and a Task-tool subagent are both child sessions sharing this
        // tab strip, but they are not the same thing: one is the user's tangent, the other
        // is the agent's own delegation. The badge distinguishes them.
        const sideChat = isSideChatTitle(session?.title)
        const { label, agent } = sideChat
          ? { ...splitSideChatTitle(session?.title), agent: null }
          : splitSubagentTitle(session?.title)
        const isActive = active === id
        const error = errors[id]
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={isActive}
            className={`subagent-tabs__tab ${isActive ? 'subagent-tabs__tab--active' : ''}`}
            title={session?.title ?? id}
            onClick={() => setActiveSubagentTab(id)}
          >
            {busy[id] === true ? (
              <span className="subagent-tabs__spinner" role="status" aria-label="Working" />
            ) : null}
            <span className="subagent-tabs__label">{label}</span>
            {sideChat ? <span className="subagent-tabs__badge">btw</span> : null}
            {agent !== null ? <span className="subagent-tabs__badge">{agent}</span> : null}
            {error !== undefined && error !== null ? (
              <span className="subagent-tabs__errordot" title={error} aria-label="Error" />
            ) : null}
            <span
              className="subagent-tabs__close"
              role="button"
              aria-label={`Close ${label} tab`}
              onClick={(e) => {
                e.stopPropagation()
                closeSubagentTab(id)
              }}
            >
              ×
            </span>
          </button>
        )
      })}
    </div>
  )
}

/**
 * Read-only transcript of one subagent session, swapped in for the main message list.
 * The composer stays bound to the parent session, so the bottom bar here is a notice
 * with a stop control instead of an input.
 */
export function SubagentView({ sessionID }: { sessionID: string }): ReactNode {
  const messages = useStore((state) => state.subagentMessages[sessionID])
  const busy = useStore((state) => state.subagentBusy[sessionID])
  const error = useStore((state) => state.subagentError[sessionID])
  const sessions = useStore((state) => state.sessions)
  const stopSubagent = useStore((state) => state.stopSubagent)
  const setActiveSubagentTab = useStore((state) => state.setActiveSubagentTab)

  const scrollRef = useRef<HTMLDivElement | null>(null)

  // Follow the stream: new content lands at the bottom, like the main transcript.
  useEffect(() => {
    const element = scrollRef.current
    if (element) element.scrollTo({ top: element.scrollHeight })
  }, [messages])

  const session = sessions.find((s) => s.id === sessionID)
  const { label } = splitSubagentTitle(session?.title)
  const transcript = messages ?? []

  return (
    <div className="subagent-view">
      <div className="subagent-view__scroll" ref={scrollRef}>
        <div className="subagent-view__inner">
          {transcript.map((message) => (
            <div key={message.info.id} className="subagent-view__msgwrap">
              <MessageView message={message} />
            </div>
          ))}
          {transcript.length === 0 ? (
            <div className="subagent-view__empty">
              {busy === true ? 'Subagent is working — waiting for output…' : 'No messages in this subagent session.'}
            </div>
          ) : null}
          {error !== undefined && error !== null ? (
            <div className="subagent-view__error" role="alert">
              <span className="subagent-view__errorlabel">Error</span>
              <span className="subagent-view__errortext">{error}</span>
            </div>
          ) : null}
        </div>
      </div>
      <div className="subagent-view__notice">
        <span className="subagent-view__noticetext">
          Viewing subagent <strong>{label}</strong> — read-only. Prompts go to the main session.
        </span>
        {busy === true ? (
          <button
            type="button"
            className="subagent-view__btn subagent-view__btn--stop"
            onClick={() => void stopSubagent(sessionID)}
          >
            Stop subagent
          </button>
        ) : null}
        <button
          type="button"
          className="subagent-view__btn"
          onClick={() => setActiveSubagentTab(null)}
        >
          Back to main
        </button>
      </div>
    </div>
  )
}
