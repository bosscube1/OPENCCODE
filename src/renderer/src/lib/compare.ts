/**
 * Multi-model fan-out ("compare run") — pure helpers.
 *
 * A compare run sends ONE prompt to N models at once. Each column is a real OpenCode session in the
 * same project directory, so the entire existing prompt + SSE pipeline is reused and nothing new has
 * to stream over IPC.
 *
 * No store or React imports: the routing predicate and the tool policy are the two things most
 * likely to break subtly, so both are unit-testable in isolation.
 */

import type { MessageWithParts } from './types'

/** Upper bound on columns in one run. Each column is a live session doing real work. */
export const MAX_COMPARE_TARGETS = 4

/**
 * Title prefix for a compare session.
 *
 * Compare columns are real sessions and would otherwise flood the sidebar, so they are tagged here
 * and filtered out of the session list by default. Keep this in sync with `isCompareSessionTitle`.
 */
export const COMPARE_TITLE_PREFIX = '⇄ '

/**
 * Tools disabled on every compare prompt — a safety invariant, not a preference: all N columns
 * share ONE working tree and would corrupt it if they could write. Defined in `toolPolicies.ts`
 * (shared with the composer's read-only session toggle) and re-exported here.
 */
export { READONLY_TOOLS } from './toolPolicies'

/** One model's column in a compare run. */
export type CompareColumn = {
  providerID: string
  modelID: string
  /** Null until the session has been created, or when creation failed. */
  sessionID: string | null
  messages: MessageWithParts[]
  busy: boolean
  error: string | null
}

/** A single fan-out of one prompt across several models. */
export type CompareRun = {
  id: string
  prompt: string
  columns: CompareColumn[]
  startedAt: number
}

/** `"providerID/modelID"` key for a column, matching the routing-ledger key format. */
export function columnKey(column: Pick<CompareColumn, 'providerID' | 'modelID'>): string {
  return `${column.providerID}/${column.modelID}`
}

/**
 * Session title for a column: prefix, model id, and a short slice of the prompt so runs are
 * distinguishable in the sidebar when the filter is turned off.
 */
export function buildCompareTitle(modelID: string, prompt: string): string {
  const trimmed = prompt.trim().replace(/\s+/g, ' ')
  const slice = trimmed.length > 40 ? `${trimmed.slice(0, 40)}…` : trimmed
  return `${COMPARE_TITLE_PREFIX}${modelID} — ${slice}`
}

/** True for a session created as part of a compare run, judged by its title tag. */
export function isCompareSessionTitle(title: string | undefined | null): boolean {
  return typeof title === 'string' && title.startsWith(COMPARE_TITLE_PREFIX)
}

/**
 * Index of the column owning `sessionID`, or -1.
 *
 * The single most important function here: it is what keeps compare traffic out of the main
 * transcript and away from the failover machinery.
 */
export function compareColumnIndex(
  run: CompareRun | null,
  sessionID: string | undefined | null
): number {
  if (run === null || typeof sessionID !== 'string' || sessionID.length === 0) return -1
  return run.columns.findIndex((column) => column.sessionID === sessionID)
}

/** True when any column is still working. */
export function isCompareBusy(run: CompareRun | null): boolean {
  return run !== null && run.columns.some((column) => column.busy)
}

/**
 * Pull the session id out of an SSE event's properties.
 *
 * Event shapes differ: `message.updated` nests it under `info`, `message.part.updated` under `part`,
 * `permission.updated` puts the Permission object directly in `properties`, and the session-level
 * events carry it at the top. Returns null when the event has no session scope.
 */
export function eventSessionID(type: string, properties: unknown): string | null {
  if (typeof properties !== 'object' || properties === null) return null
  const props = properties as Record<string, unknown>

  const nested = (value: unknown): string | null => {
    if (typeof value !== 'object' || value === null) return null
    const id = (value as Record<string, unknown>).sessionID
    return typeof id === 'string' && id.length > 0 ? id : null
  }

  if (type === 'message.updated') return nested(props.info)
  if (type === 'message.part.updated') return nested(props.part)

  const direct = props.sessionID
  return typeof direct === 'string' && direct.length > 0 ? direct : null
}

/**
 * Event types a compare column consumes.
 *
 * Deliberately EXCLUDES `session.created` / `.updated` / `.deleted`: compare sessions are real
 * sessions and those events must still reach the main reducer so the sidebar's session list stays
 * consistent.
 */
const COLUMN_EVENT_TYPES: ReadonlySet<string> = new Set([
  'message.updated',
  'message.part.updated',
  'message.removed',
  'message.part.removed',
  'session.idle',
  'session.status',
  'session.error',
  'permission.updated'
])

/** True when this event type should be applied to a compare column rather than the main transcript. */
export function isColumnEvent(type: string): boolean {
  return COLUMN_EVENT_TYPES.has(type)
}

/** Replace one column, returning a new run. Out-of-range indices return the run unchanged. */
export function withColumn(
  run: CompareRun,
  index: number,
  patch: Partial<CompareColumn>
): CompareRun {
  if (index < 0 || index >= run.columns.length) return run
  const columns = run.columns.slice()
  columns[index] = { ...columns[index], ...patch }
  return { ...run, columns }
}
