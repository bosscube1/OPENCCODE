/**
 * Subagent (Task-tool child session) helpers — pure, no store/React imports.
 *
 * The opencode server runs a Task tool call as a real child session
 * (`sessions.create({ parentID, title: '<desc> (@<agent> subagent)' })`). These helpers
 * cover the three things the UI needs around that: walking the `parentID` chain, pulling
 * the child session id out of a Task tool part, and splitting the generated title into a
 * tab label plus an agent badge.
 */

import type { Session, ToolPart } from './types'

/** Upper bound on the parentID walk — malformed cycles must not hang the reducer. */
const PARENT_WALK_GUARD = 32

/**
 * True when `sessionID` IS `rootID`, or is a descendant of it via the `parentID` chain
 * in `sessions`. Shared by the permission queue (child prompts surface in the parent's
 * chat) and the subagent-tab event router.
 */
export function isSelfOrDescendant(
  sessions: readonly Session[],
  rootID: string | null | undefined,
  sessionID: string | null | undefined
): boolean {
  if (!sessionID || !rootID) return false
  if (sessionID === rootID) return true
  const byId = new Map(sessions.map((s) => [s.id, s]))
  let current = byId.get(sessionID)
  let guard = 0
  while (current?.parentID && guard < PARENT_WALK_GUARD) {
    if (current.parentID === rootID) return true
    current = byId.get(current.parentID)
    guard += 1
  }
  return false
}

/** True when `sessionID` is a STRICT descendant of `rootID` — never true for the root itself. */
export function isDescendantOf(
  sessions: readonly Session[],
  rootID: string | null | undefined,
  sessionID: string | null | undefined
): boolean {
  if (!sessionID || !rootID || sessionID === rootID) return false
  return isSelfOrDescendant(sessions, rootID, sessionID)
}

/**
 * The child session a Task tool call spawned, read from `part.state.metadata.sessionId`.
 *
 * The server sets the metadata from the tool call's `running` state onward, so a pending
 * or malformed part yields undefined — callers render the drill-down only when this
 * returns a string.
 */
export function taskChildSessionId(part: ToolPart): string | undefined {
  if (part.tool.toLowerCase() !== 'task') return undefined
  const { state } = part
  if (state.status === 'pending') return undefined
  const sessionId = state.metadata?.['sessionId']
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined
}

/** Matches the trailing ` (@<agent> subagent)` the server appends to child session titles. */
const SUBAGENT_TITLE_SUFFIX = /\s*\(@([^()]+?)\s+subagent\)\s*$/

/**
 * Appended to a `/btw` side chat's title so its tab is distinguishable from a real
 * Task-tool subagent, even though both are child sessions rendered by the same tab
 * strip. A subagent is the agent's own Task call; a side chat is the user's `/btw`.
 */
export const SIDE_CHAT_TITLE_SUFFIX = ' (side chat)'

/** Matches the trailing ` (side chat)` marker `/btw` appends to its child session titles. */
const SIDE_CHAT_TITLE_SUFFIX_RE = /\s*\(side chat\)\s*$/

/** Longest question fragment kept in a side-chat tab title before ellipsis. */
const SIDE_CHAT_LABEL_MAX = 40

/**
 * Build the child session title for a `/btw` question: a trimmed, single-line, length-capped
 * fragment of the question plus the marker. Newlines are collapsed because the title renders
 * in a one-line tab, and any pre-existing marker in the user's text is stripped so
 * `isSideChatTitle` cannot be spoofed into double-marking.
 */
export function sideChatTitle(question: string): string {
  const flat = question.replace(/\s+/g, ' ').replace(SIDE_CHAT_TITLE_SUFFIX_RE, '').trim()
  if (flat === '') return `Side chat${SIDE_CHAT_TITLE_SUFFIX}`
  const label =
    flat.length > SIDE_CHAT_LABEL_MAX ? `${flat.slice(0, SIDE_CHAT_LABEL_MAX - 1).trimEnd()}…` : flat
  return `${label}${SIDE_CHAT_TITLE_SUFFIX}`
}

/** True when `title` carries the `/btw` side-chat marker (never true for a subagent title). */
export function isSideChatTitle(title: string | null | undefined): boolean {
  return typeof title === 'string' && SIDE_CHAT_TITLE_SUFFIX_RE.test(title)
}

/**
 * Split a side chat title (`"<question> (side chat)"`) into its tab label. Mirrors
 * `splitSubagentTitle`'s shape but a side chat has no agent badge — it is the user's
 * own tangent, not a Task-tool call. Titles that do not carry the marker come back
 * whole; empty input falls back to a generic label so a tab never renders blank.
 */
export function splitSideChatTitle(title: string | null | undefined): { label: string } {
  if (typeof title !== 'string' || title.trim() === '') return { label: 'Side chat' }
  const match = SIDE_CHAT_TITLE_SUFFIX_RE.exec(title)
  if (match === null) return { label: title }
  const label = title.slice(0, match.index).trim()
  return { label: label.length > 0 ? label : 'Side chat' }
}

/**
 * Split a child session title (`"<desc> (@<agent> subagent)"`) into the tab label and the
 * agent badge. Titles that do not match the generated shape come back whole with a null
 * agent; empty input falls back to a generic label so a tab never renders blank.
 */
export function splitSubagentTitle(title: string | null | undefined): { label: string; agent: string | null } {
  if (typeof title !== 'string' || title.trim() === '') return { label: 'Subagent', agent: null }
  const match = SUBAGENT_TITLE_SUFFIX.exec(title)
  if (match === null) return { label: title, agent: null }
  const label = title.slice(0, match.index).trim()
  const agent = match[1] ?? null
  return { label: label.length > 0 ? label : 'Subagent', agent }
}
