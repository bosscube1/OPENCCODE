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
