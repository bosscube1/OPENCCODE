/**
 * Multi-model fan-out (compare runs) — state, actions, and its own SSE path.
 *
 * A compare run has N exchanges in flight at once, which is exactly what the single-slot
 * attempt machine cannot represent. Everything here therefore stays clear of `activeAttempt`,
 * the routing ledger, and `beginFailover`.
 */

import {
  buildCompareTitle,
  compareColumnIndex,
  eventSessionID,
  isColumnEvent,
  isCompareBusy,
  withColumn,
  MAX_COMPARE_TARGETS,
  READONLY_TOOLS,
  type CompareColumn,
  type CompareRun
} from '../compare'
import { savePrefs } from '../prefs'
import { parseModelKey } from '../routing'
import { upsertMessage, removeMessage, upsertPart, removePart, upsertSession } from '../collections'
import { api, errText } from './api'
import type { AppState, SetState, GetState } from './types'
import type { Message, OcEvent, Part, Permission, PromptPart } from '../types'

export type CompareSlice = Pick<
  AppState,
  | 'compare'
  | 'compareTargets'
  | 'setCompareTargets'
  | 'sendToMany'
  | 'abortCompare'
  | 'promoteCompareColumn'
  | 'discardCompare'
  | 'clearCompare'
>

export function createCompareSlice(set: SetState, get: GetState): CompareSlice {
  return {
    compare: null,
    compareTargets: [],

    setCompareTargets(keys: string[]): void {
      const deduped = [...new Set(keys)].slice(0, MAX_COMPARE_TARGETS)
      set({ compareTargets: deduped })
      const { directory, providerID, modelID, theme, modelPool, routingMode, showPaidModels } = get()
      savePrefs({ directory, providerID, modelID, theme, modelPool, routingMode, showPaidModels, compareTargets: deduped })
    },

    /**
     * Fan one prompt out to N models, each in its own read-only session.
     *
     * Every column is a real OpenCode session in the same directory, so the existing prompt + SSE
     * pipeline does all the work. Two invariants matter here:
     *
     *  1. `READONLY_TOOLS` is passed on every prompt. All columns share ONE working tree; without this
     *     they would race on writes and corrupt the repo.
     *  2. None of the failover machinery is engaged — no `startActiveAttempt`, no `reserveAttempt`, no
     *     ledger write, no `lastPrompt`. `activeAttempt` is a single module-level slot and
     *     `beginFailover` reverts and re-sends `lastPrompt`, which is incoherent across N concurrent
     *     sessions. A column that fails simply reports its own error.
     */
    async sendToMany(text: string, parts?: PromptPart[]): Promise<void> {
      const trimmed = text.trim()
      if (trimmed.length === 0) return

      const { directory, compareTargets, providers, linkedProviderIDs } = get()
      if (!directory) {
        set({ error: 'Pick a project folder first.' })
        return
      }
      if (compareTargets.length < 2) {
        set({ error: 'Pick at least two models to compare.' })
        return
      }
      if (isCompareBusy(get().compare)) {
        set({ error: 'A comparison is still running. Stop it before starting another.' })
        return
      }

      // Resolve targets, dropping any whose provider has no key rather than failing the whole run.
      const resolved: Array<{ providerID: string; modelID: string }> = []
      const skipped: string[] = []
      for (const key of compareTargets.slice(0, MAX_COMPARE_TARGETS)) {
        const parsed = parseModelKey(key)
        if (!parsed) continue
        const known = providers.some(
          (p) => p.id === parsed.providerID && Object.prototype.hasOwnProperty.call(p.models ?? {}, parsed.modelID)
        )
        if (!known || !linkedProviderIDs.includes(parsed.providerID)) {
          skipped.push(key)
          continue
        }
        resolved.push(parsed)
      }
      if (resolved.length < 2) {
        set({
          error: skipped.length > 0
            ? `Not enough usable models to compare — no API key or model for: ${skipped.join(', ')}.`
            : 'Not enough usable models to compare.'
        })
        return
      }

      const run: CompareRun = {
        id: `cmp-${Date.now()}`,
        prompt: trimmed,
        startedAt: Date.now(),
        columns: resolved.map((target): CompareColumn => ({
          providerID: target.providerID,
          modelID: target.modelID,
          sessionID: null,
          messages: [],
          busy: true,
          error: null
        }))
      }
      set({ compare: run, error: null })
      if (skipped.length > 0) {
        get().addSystemNotice(`Skipped ${skipped.length} model(s) with no linked API key: ${skipped.join(', ')}.`)
      }

      // Create sessions and dispatch. Each column is independent: one failure must not abort the rest.
      await Promise.all(
        run.columns.map(async (column, index) => {
          try {
            const session = await api().sessions.create(
              directory,
              buildCompareTitle(column.modelID, trimmed)
            )
            // A newer run may have replaced this one while the session was being created.
            if (get().compare?.id !== run.id) return
            set((state) => ({
              compare: state.compare ? withColumn(state.compare, index, { sessionID: session.id }) : null,
              sessions: upsertSession(state.sessions, session)
            }))

            await api().prompt({
              directory,
              sessionID: session.id,
              providerID: column.providerID,
              modelID: column.modelID,
              text: trimmed,
              parts,
              tools: { ...READONLY_TOOLS }
            })
          } catch (e) {
            if (get().compare?.id !== run.id) return
            set((state) => ({
              compare: state.compare
                ? withColumn(state.compare, index, { busy: false, error: errText(e) })
                : null
            }))
          }
        })
      )
    },

    async abortCompare(): Promise<void> {
      const { directory, compare } = get()
      if (!directory || !compare) return
      await Promise.all(
        compare.columns.map(async (column, index) => {
          if (!column.sessionID || !column.busy) return
          try {
            await api().abort(directory, column.sessionID)
          } catch {
            /* a failed abort still leaves the column marked idle below */
          }
          set((state) => ({
            compare: state.compare ? withColumn(state.compare, index, { busy: false }) : null
          }))
        })
      )
    },

    /**
     * Adopt one column's session as the active session.
     *
     * The comparison itself is read-only; promoting is how a winning answer becomes a normal,
     * fully-tool-enabled session. Also pins the column's model so follow-up turns use it.
     */
    async promoteCompareColumn(index: number): Promise<void> {
      const { compare } = get()
      const column = compare?.columns[index]
      if (!compare || !column || !column.sessionID) return
      set({ compare: null })
      get().setModel(column.providerID, column.modelID)
      await get().selectSession(column.sessionID)
    },

    async discardCompare(): Promise<void> {
      const { directory, compare } = get()
      if (!compare) return
      set({ compare: null })
      if (!directory) return
      for (const column of compare.columns) {
        if (!column.sessionID) continue
        try {
          await api().sessions.remove(directory, column.sessionID)
          set((state) => ({
            sessions: state.sessions.filter((s) => s.id !== column.sessionID)
          }))
        } catch {
          /* a session that will not delete stays in the list; not worth failing the discard */
        }
      }
    },

    clearCompare(): void {
      set({ compare: null })
    }
  }
}

/* ------------------------------------------------------------------ *
 * Compare-run event routing
 * ------------------------------------------------------------------ */

/**
 * Apply an SSE event to a compare column. Returns true when the event was consumed here.
 *
 * WHY THIS EXISTS AS A SEPARATE PATH. The main reducer assumes ONE in-flight exchange: it drives
 * `activeAttempt` (a single module-level slot), the TTFT/stall watchdogs, the routing ledger, and
 * `beginFailover`, which reverts and re-sends `lastPrompt`. A compare run has N exchanges in flight
 * at once, so letting that traffic through would corrupt the attempt machine for NORMAL chat too —
 * mis-recording latencies, resetting `rotateRetries`, or triggering a failover that reverts the wrong
 * session. Every event whose session belongs to a column is therefore consumed here and nothing else
 * is touched.
 *
 * `session.created` / `.updated` / `.deleted` are deliberately NOT consumed (see `isColumnEvent`):
 * compare columns are real sessions and the sidebar's list must still see them.
 */
export function applyCompareEvent(
  e: OcEvent,
  set: (fn: (state: AppState) => Partial<AppState>) => void,
  get: GetState
): boolean {
  const run = get().compare
  if (run === null) return false
  if (!isColumnEvent(e.type)) return false

  const sessionID = eventSessionID(e.type, e.properties)
  const index = compareColumnIndex(run, sessionID)
  if (index < 0) return false

  const props = (e.properties ?? {}) as Record<string, unknown>
  const column = run.columns[index]

  switch (e.type) {
    case 'message.updated': {
      const info = props.info as Message | undefined
      if (!info || typeof info.id !== 'string') return true
      set((state) =>
        state.compare
          ? { compare: withColumn(state.compare, index, { messages: upsertMessage(column.messages, info) }) }
          : {}
      )
      return true
    }

    case 'message.part.updated': {
      const part = props.part as Part | undefined
      if (!part || typeof part.id !== 'string') return true
      const messages = upsertPart(column.messages, part)
      if (messages !== column.messages) {
        set((state) => (state.compare ? { compare: withColumn(state.compare, index, { messages }) } : {}))
      }
      return true
    }

    case 'message.removed': {
      const messageID = props.messageID as string | undefined
      if (!messageID) return true
      const messages = removeMessage(column.messages, messageID)
      if (messages !== column.messages) {
        set((state) => (state.compare ? { compare: withColumn(state.compare, index, { messages }) } : {}))
      }
      return true
    }

    case 'message.part.removed': {
      const messageID = props.messageID as string | undefined
      const partID = props.partID as string | undefined
      if (!messageID || !partID) return true
      const messages = removePart(column.messages, messageID, partID)
      if (messages !== column.messages) {
        set((state) => (state.compare ? { compare: withColumn(state.compare, index, { messages }) } : {}))
      }
      return true
    }

    case 'session.status': {
      const status = props.status as { type?: string } | undefined
      const busy = status?.type === 'busy' || status?.type === 'retry'
      if (busy !== column.busy) {
        set((state) => (state.compare ? { compare: withColumn(state.compare, index, { busy }) } : {}))
      }
      return true
    }

    case 'session.idle': {
      set((state) => (state.compare ? { compare: withColumn(state.compare, index, { busy: false }) } : {}))
      return true
    }

    case 'session.error': {
      const error = props.error as { data?: { message?: string }; name?: string } | undefined
      const detail = error?.data?.message ?? error?.name ?? 'Model returned an error.'
      set((state) =>
        state.compare
          ? { compare: withColumn(state.compare, index, { busy: false, error: detail }) }
          : {}
      )
      return true
    }

    case 'permission.updated': {
      // Belt and braces. With READONLY_TOOLS there should be no permission requests at all; if one
      // arrives, auto-reject rather than blocking a column forever on a prompt the compare UI does not
      // render. Never surfaced to the main `permissions` queue, which belongs to the active session.
      const permission = e.properties as Permission | undefined
      const directory = get().directory
      if (permission && typeof permission.id === 'string' && directory && sessionID) {
        void api()
          .replyPermission({ directory, sessionID, permissionID: permission.id, response: 'reject' })
          .catch(() => {
            /* nothing useful to do — the column reports the resulting error via session.error */
          })
        set((state) =>
          state.compare
            ? {
                compare: withColumn(state.compare, index, {
                  error: `Rejected a tool permission request (${permission.title ?? 'unknown tool'}) — comparisons run read-only.`
                })
              }
            : {}
        )
      }
      return true
    }

    default:
      return false
  }
}
