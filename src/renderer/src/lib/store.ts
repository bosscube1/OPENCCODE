/**
 * The single renderer store (zustand).
 *
 * Components read via selectors and never keep their own copy of server state.
 * All traffic goes through `window.api` (the preload bridge) — the renderer never
 * speaks HTTP and never imports SDK runtime code.
 */

import { create } from 'zustand'
import { isAssistant } from './types'
import { isAgentModel } from './models'
import type {
  Message,
  MessageWithParts,
  OcEvent,
  Part,
  Permission,
  PermissionResponse,
  Provider,
  ServerStatus,
  Session
} from './types'

/* ------------------------------------------------------------------ *
 * Preload bridge
 * ------------------------------------------------------------------ */

interface OpencodeApi {
  status(): Promise<ServerStatus>
  restart(): Promise<ServerStatus>
  pickDirectory(): Promise<string | null>
  sessions: {
    list(directory: string): Promise<Session[]>
    create(directory: string, title?: string): Promise<Session>
    remove(directory: string, id: string): Promise<void>
  }
  messages(directory: string, sessionID: string): Promise<MessageWithParts[]>
  prompt(a: {
    directory: string
    sessionID: string
    providerID: string
    modelID: string
    text: string
  }): Promise<void>
  abort(directory: string, sessionID: string): Promise<void>
  providers(): Promise<{ providers: Provider[]; default: Record<string, string> }>
  replyPermission(a: {
    directory: string
    sessionID: string
    permissionID: string
    response: PermissionResponse
  }): Promise<void>
  openExternal(url: string): Promise<void>
  onEvent(cb: (e: OcEvent) => void): () => void
  onServer(cb: (s: ServerStatus) => void): () => void
}

function api(): OpencodeApi {
  const bridge = (window as unknown as { api?: OpencodeApi }).api
  if (!bridge) {
    throw new Error('Preload bridge unavailable — window.api is not defined.')
  }
  return bridge
}

/** Turn anything thrown across IPC into a readable one-liner. */
function errText(e: unknown): string {
  let raw: string
  if (e instanceof Error) raw = e.message
  else if (typeof e === 'string') raw = e
  else {
    try {
      raw = JSON.stringify(e)
    } catch {
      raw = String(e)
    }
  }
  const cleaned = raw.replace(/^Error invoking remote method '[^']*':\s*/, '').trim()
  return cleaned.length > 0 ? cleaned : 'Something went wrong.'
}

/* ------------------------------------------------------------------ *
 * Persisted preferences
 * ------------------------------------------------------------------ */

const PREFS_KEY = 'opencode-desktop:prefs'

type Prefs = {
  directory: string | null
  providerID: string | null
  modelID: string | null
}

const EMPTY_PREFS: Prefs = { directory: null, providerID: null, modelID: null }

function loadPrefs(): Prefs {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY)
    if (!raw) return { ...EMPTY_PREFS }
    const parsed = JSON.parse(raw) as Partial<Record<keyof Prefs, unknown>>
    return {
      directory: typeof parsed.directory === 'string' ? parsed.directory : null,
      providerID: typeof parsed.providerID === 'string' ? parsed.providerID : null,
      modelID: typeof parsed.modelID === 'string' ? parsed.modelID : null
    }
  } catch {
    return { ...EMPTY_PREFS }
  }
}

function savePrefs(prefs: Prefs): void {
  try {
    window.localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({
        directory: prefs.directory,
        providerID: prefs.providerID,
        modelID: prefs.modelID
      })
    )
  } catch {
    // Storage can be unavailable or full; preferences are best-effort.
  }
}

/* ------------------------------------------------------------------ *
 * Model selection — never default to Anthropic
 *
 * The server's `default[providerID]` map is unreliable (empirically it has
 * returned audio-transcription and image models as a provider's "default"),
 * so it is never used to auto-select a model. Instead we walk an explicit
 * preference list of provider/model pairs verified working against this
 * user's configured free-tier keys, falling back to a provider-priority
 * scan of whatever passes `isAgentModel`.
 * ------------------------------------------------------------------ */

/** Exact provider/model pairs verified working end-to-end. Keep IDs verbatim. */
const PREFERRED_MODELS: ReadonlyArray<{ providerID: string; modelID: string }> = [
  { providerID: 'google', modelID: 'gemini-3.6-flash' },
  { providerID: 'google', modelID: 'gemini-3.5-flash' },
  { providerID: 'google', modelID: 'gemini-2.5-flash' },
  { providerID: 'cerebras', modelID: 'gpt-oss-120b' },
  { providerID: 'mistral', modelID: 'ministral-8b-latest' },
  { providerID: 'cohere', modelID: 'command-r-08-2024' },
  { providerID: 'openrouter', modelID: 'nvidia/nemotron-nano-9b-v2:free' }
]

/** Provider priority for the fallback scan when none of the preferred pairs are available. */
const FALLBACK_PROVIDER_ORDER = ['google', 'cerebras', 'mistral', 'cohere', 'openrouter', 'groq']

function pickDefaultModel(providers: Provider[]): { providerID: string; modelID: string } | null {
  const byId = new Map(providers.map((p) => [p.id, p]))

  for (const { providerID, modelID } of PREFERRED_MODELS) {
    const model = byId.get(providerID)?.models?.[modelID]
    if (model && isAgentModel(model)) return { providerID, modelID }
  }

  for (const providerID of FALLBACK_PROVIDER_ORDER) {
    const provider = byId.get(providerID)
    if (!provider) continue
    const candidates = Object.values(provider.models ?? {})
      .filter(isAgentModel)
      .sort((a, b) => compareIds(a.id, b.id))
    if (candidates.length > 0) return { providerID, modelID: candidates[0].id }
  }

  return null
}

/** True only when the restored provider/model still exists AND still passes `isAgentModel`. */
function restoredSelectionValid(
  providers: Provider[],
  providerID: string | null,
  modelID: string | null
): boolean {
  if (!providerID || !modelID) return false
  const provider = providers.find((p) => p.id === providerID)
  const model = provider?.models?.[modelID]
  return Boolean(model && isAgentModel(model))
}

/* ------------------------------------------------------------------ *
 * Immutable collection helpers
 * ------------------------------------------------------------------ */

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Oldest -> newest, ties broken by id. */
function sortMessages(list: MessageWithParts[]): MessageWithParts[] {
  return list.slice().sort((a, b) => {
    const delta = a.info.time.created - b.info.time.created
    if (delta !== 0) return delta
    return compareIds(a.info.id, b.info.id)
  })
}

function upsertMessage(list: MessageWithParts[], info: Message): MessageWithParts[] {
  const index = list.findIndex((m) => m.info.id === info.id)
  if (index === -1) return sortMessages([...list, { info, parts: [] }])
  const existing = list[index] as MessageWithParts
  const next = list.slice()
  next[index] = { info, parts: existing.parts }
  return sortMessages(next)
}

function removeMessage(list: MessageWithParts[], messageID: string): MessageWithParts[] {
  const index = list.findIndex((m) => m.info.id === messageID)
  if (index === -1) return list
  return list.filter((m) => m.info.id !== messageID)
}

/** Upsert a part, preserving first-seen order. Ignored when the message is unknown. */
function upsertPart(list: MessageWithParts[], part: Part): MessageWithParts[] {
  const index = list.findIndex((m) => m.info.id === part.messageID)
  if (index === -1) return list
  const message = list[index] as MessageWithParts
  const partIndex = message.parts.findIndex((p) => p.id === part.id)
  let parts: Part[]
  if (partIndex === -1) {
    parts = [...message.parts, part]
  } else {
    parts = message.parts.slice()
    parts[partIndex] = part
  }
  const next = list.slice()
  next[index] = { info: message.info, parts }
  return next
}

function removePart(
  list: MessageWithParts[],
  messageID: string,
  partID: string
): MessageWithParts[] {
  const index = list.findIndex((m) => m.info.id === messageID)
  if (index === -1) return list
  const message = list[index] as MessageWithParts
  if (!message.parts.some((p) => p.id === partID)) return list
  const next = list.slice()
  next[index] = { info: message.info, parts: message.parts.filter((p) => p.id !== partID) }
  return next
}

/** Newest first — that is the order the sidebar renders. */
function sortSessions(list: Session[]): Session[] {
  return list.slice().sort((a, b) => {
    const delta = b.time.updated - a.time.updated
    if (delta !== 0) return delta
    return compareIds(b.id, a.id)
  })
}

function upsertSession(list: Session[], session: Session): Session[] {
  const index = list.findIndex((s) => s.id === session.id)
  if (index === -1) return sortSessions([...list, session])
  const next = list.slice()
  next[index] = session
  return sortSessions(next)
}

function normalizePath(p: string): string {
  return p.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
}

function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  return normalizePath(a) === normalizePath(b)
}

/* ------------------------------------------------------------------ *
 * Store
 * ------------------------------------------------------------------ */

export interface AppState {
  // connection
  server: ServerStatus
  // project
  directory: string | null
  // sessions
  sessions: Session[]
  activeSessionID: string | null
  // messages for the active session, ordered oldest -> newest
  messages: MessageWithParts[]
  busy: boolean
  // model
  providers: Provider[]
  defaultModels: Record<string, string>
  providerID: string | null
  modelID: string | null
  // permissions awaiting user answer, oldest first
  permissions: Permission[]
  // last error banner text, null when clear
  error: string | null

  // actions
  init(): Promise<void>
  pickDirectory(): Promise<void>
  setDirectory(dir: string): Promise<void>
  newSession(): Promise<void>
  selectSession(id: string): Promise<void>
  deleteSession(id: string): Promise<void>
  send(text: string): Promise<void>
  abort(): Promise<void>
  setModel(providerID: string, modelID: string): void
  replyPermission(id: string, response: PermissionResponse): Promise<void>
  applyEvent(e: OcEvent): void
  dismissError(): void
}

/** True when the event's session is the active one, or a subagent of it. */
function isActiveOrDescendant(
  state: Pick<AppState, 'activeSessionID' | 'sessions'>,
  sessionID: string | undefined | null
): boolean {
  const active = state.activeSessionID
  if (!sessionID || !active) return false
  if (sessionID === active) return true
  const byId = new Map(state.sessions.map((s) => [s.id, s]))
  let current = byId.get(sessionID)
  let guard = 0
  while (current?.parentID && guard < 32) {
    if (current.parentID === active) return true
    current = byId.get(current.parentID)
    guard += 1
  }
  return false
}

export const useStore = create<AppState>()((set, get) => ({
  server: { running: false, url: null },
  directory: null,
  sessions: [],
  activeSessionID: null,
  messages: [],
  busy: false,
  providers: [],
  defaultModels: {},
  providerID: null,
  modelID: null,
  permissions: [],
  error: null,

  async init(): Promise<void> {
    subscribe()

    try {
      const status = await api().status()
      set({ server: status })
    } catch (e) {
      set({ server: { running: false, url: null, error: errText(e) } })
    }

    // The main process may still be spawning `opencode serve`. Poll status
    // briefly instead of blowing up on providers() before the server is ready;
    // the `onServer` bridge will also refetch once the status flips.
    for (let i = 0; i < 40 && !get().server.running; i++) {
      await new Promise((r) => setTimeout(r, 250))
    }

    let providers: Provider[] = []
    let defaultModels: Record<string, string> = {}
    if (get().server.running) {
      try {
        const result = await api().providers()
        providers = result?.providers ?? []
        defaultModels = result?.default ?? {}
        set({ providers, defaultModels })
      } catch (e) {
        set({ error: errText(e) })
      }
    }

    const prefs = loadPrefs()
    let providerID = prefs.providerID
    let modelID = prefs.modelID

    // Only re-pick when we actually know what the server offers; otherwise keep
    // whatever the user last chose so a temporarily-down server does not reset it.
    // A restored selection that no longer exists, or no longer passes the
    // agent-model predicate, falls through to the default preference walk.
    if (providers.length > 0 && !restoredSelectionValid(providers, providerID, modelID)) {
      const picked = pickDefaultModel(providers)
      providerID = picked ? picked.providerID : null
      modelID = picked ? picked.modelID : null
    }

    set({ providerID, modelID })
    savePrefs({ directory: prefs.directory, providerID, modelID })

    if (prefs.directory) {
      await get().setDirectory(prefs.directory)
    }
  },

  async pickDirectory(): Promise<void> {
    try {
      const dir = await api().pickDirectory()
      if (!dir) return
      await get().setDirectory(dir)
    } catch (e) {
      set({ error: errText(e) })
    }
  },

  async setDirectory(dir: string): Promise<void> {
    set({
      directory: dir,
      sessions: [],
      activeSessionID: null,
      messages: [],
      permissions: [],
      busy: false
    })
    const { providerID, modelID } = get()
    savePrefs({ directory: dir, providerID, modelID })

    try {
      const sessions = await api().sessions.list(dir)
      if (get().directory !== dir) return
      set({ sessions: sortSessions(sessions ?? []) })
    } catch (e) {
      set({ error: errText(e) })
    }
  },

  async newSession(): Promise<void> {
    const directory = get().directory
    if (!directory) {
      set({ error: 'Pick a project folder first.' })
      return
    }
    try {
      const session = await api().sessions.create(directory)
      set((state) => ({
        sessions: upsertSession(state.sessions, session),
        activeSessionID: session.id,
        messages: [],
        permissions: [],
        busy: false,
        error: null
      }))
    } catch (e) {
      set({ error: errText(e) })
    }
  },

  async selectSession(id: string): Promise<void> {
    const directory = get().directory
    if (!directory) {
      set({ error: 'Pick a project folder first.' })
      return
    }
    set({ activeSessionID: id, messages: [], permissions: [], busy: false })

    try {
      const loaded = await api().messages(directory, id)
      if (get().activeSessionID !== id) return
      const messages = sortMessages(loaded ?? [])
      const last = messages.length > 0 ? messages[messages.length - 1] : undefined
      const info = last?.info
      const stillRunning =
        info !== undefined &&
        isAssistant(info) &&
        info.time.completed === undefined &&
        info.error === undefined
      set({ messages, busy: stillRunning })
    } catch (e) {
      set({ error: errText(e) })
    }
  },

  async deleteSession(id: string): Promise<void> {
    const directory = get().directory
    if (!directory) return
    try {
      await api().sessions.remove(directory, id)
      set((state) => {
        const wasActive = state.activeSessionID === id
        return {
          sessions: state.sessions.filter((s) => s.id !== id),
          activeSessionID: wasActive ? null : state.activeSessionID,
          messages: wasActive ? [] : state.messages,
          permissions: wasActive
            ? []
            : state.permissions.filter((p) => p.sessionID !== id),
          busy: wasActive ? false : state.busy
        }
      })
    } catch (e) {
      set({ error: errText(e) })
    }
  },

  async send(text: string): Promise<void> {
    const trimmed = text.trim()
    if (trimmed.length === 0) return

    const { directory, providerID, modelID } = get()
    if (!directory) {
      set({ error: 'Pick a project folder first.' })
      return
    }
    if (!providerID || !modelID) {
      set({ error: 'Choose a model before sending a message.' })
      return
    }

    try {
      let sessionID = get().activeSessionID
      if (!sessionID) {
        const session = await api().sessions.create(directory)
        sessionID = session.id
        set((state) => ({
          sessions: upsertSession(state.sessions, session),
          activeSessionID: session.id,
          messages: [],
          permissions: []
        }))
      }

      // Nothing is appended optimistically: the server echoes the user message
      // back as message.updated / message.part.updated over SSE.
      set({ busy: true, error: null })
      await api().prompt({ directory, sessionID, providerID, modelID, text: trimmed })
    } catch (e) {
      set({ busy: false, error: errText(e) })
    }
  },

  async abort(): Promise<void> {
    const { directory, activeSessionID } = get()
    if (!directory || !activeSessionID) return
    try {
      await api().abort(directory, activeSessionID)
      set({ busy: false })
    } catch (e) {
      set({ busy: false, error: errText(e) })
    }
  },

  setModel(providerID: string, modelID: string): void {
    set({ providerID, modelID })
    savePrefs({ directory: get().directory, providerID, modelID })
  },

  async replyPermission(id: string, response: PermissionResponse): Promise<void> {
    const { directory, permissions } = get()
    const permission = permissions.find((p) => p.id === id)
    if (!permission) return
    if (!directory) {
      set({ error: 'Pick a project folder first.' })
      return
    }

    // Optimistically dismiss; restore it if the reply fails.
    set((state) => ({ permissions: state.permissions.filter((p) => p.id !== id) }))

    try {
      await api().replyPermission({
        directory,
        sessionID: permission.sessionID,
        permissionID: id,
        response
      })
    } catch (e) {
      set((state) => ({
        error: errText(e),
        permissions: state.permissions.some((p) => p.id === id)
          ? state.permissions
          : [...state.permissions, permission].sort(
              (a, b) => a.time.created - b.time.created || compareIds(a.id, b.id)
            )
      }))
    }
  },

  applyEvent(e: OcEvent): void {
    if (!e || typeof e.type !== 'string') return
    const state = get()
    const props = (e.properties ?? {}) as Record<string, unknown>

    switch (e.type) {
      case 'message.updated': {
        const info = props.info as Message | undefined
        if (!info || typeof info.id !== 'string') return
        if (info.sessionID !== state.activeSessionID) return
        set({ messages: upsertMessage(state.messages, info) })
        return
      }

      case 'message.part.updated': {
        const part = props.part as Part | undefined
        if (!part || typeof part.id !== 'string') return
        if (part.sessionID !== state.activeSessionID) return
        const messages = upsertPart(state.messages, part)
        if (messages !== state.messages) set({ messages })
        return
      }

      case 'message.removed': {
        const sessionID = props.sessionID as string | undefined
        const messageID = props.messageID as string | undefined
        if (!messageID || sessionID !== state.activeSessionID) return
        const messages = removeMessage(state.messages, messageID)
        if (messages !== state.messages) set({ messages })
        return
      }

      case 'message.part.removed': {
        const sessionID = props.sessionID as string | undefined
        const messageID = props.messageID as string | undefined
        const partID = props.partID as string | undefined
        if (!messageID || !partID || sessionID !== state.activeSessionID) return
        const messages = removePart(state.messages, messageID, partID)
        if (messages !== state.messages) set({ messages })
        return
      }

      case 'permission.updated': {
        const permission = e.properties as Permission | undefined
        if (!permission || typeof permission.id !== 'string') return
        if (!isActiveOrDescendant(state, permission.sessionID)) return
        if (state.permissions.some((p) => p.id === permission.id)) return
        set({ permissions: [...state.permissions, permission] })
        return
      }

      case 'permission.replied': {
        const permissionID = props.permissionID as string | undefined
        if (!permissionID) return
        if (!state.permissions.some((p) => p.id === permissionID)) return
        set({ permissions: state.permissions.filter((p) => p.id !== permissionID) })
        return
      }

      case 'session.status': {
        const sessionID = props.sessionID as string | undefined
        const status = props.status as { type?: string } | undefined
        if (!sessionID || sessionID !== state.activeSessionID) return
        const busy = status?.type === 'busy' || status?.type === 'retry'
        if (busy !== state.busy) set({ busy })
        return
      }

      case 'session.idle': {
        const sessionID = props.sessionID as string | undefined
        if (sessionID !== state.activeSessionID) return
        if (state.busy) set({ busy: false })
        return
      }

      case 'session.error': {
        const sessionID = props.sessionID as string | undefined
        if (sessionID && sessionID !== state.activeSessionID) return
        const error = props.error as
          | { name?: string; data?: { message?: string } }
          | undefined
        if (error?.name === 'MessageAbortedError') {
          set({ busy: false })
          return
        }
        const message =
          error?.data?.message ?? error?.name ?? 'The session reported an error.'
        set({ busy: false, error: message })
        return
      }

      case 'session.created':
      case 'session.updated': {
        const info = props.info as Session | undefined
        if (!info || typeof info.id !== 'string') return
        const known = state.sessions.some((s) => s.id === info.id)
        if (!known && !samePath(info.directory, state.directory)) return
        set({ sessions: upsertSession(state.sessions, info) })
        return
      }

      case 'session.deleted': {
        const info = props.info as Session | undefined
        const id = info?.id
        if (!id) return
        if (!state.sessions.some((s) => s.id === id) && state.activeSessionID !== id) {
          return
        }
        const wasActive = state.activeSessionID === id
        set({
          sessions: state.sessions.filter((s) => s.id !== id),
          activeSessionID: wasActive ? null : state.activeSessionID,
          messages: wasActive ? [] : state.messages,
          permissions: wasActive
            ? []
            : state.permissions.filter((p) => p.sessionID !== id),
          busy: wasActive ? false : state.busy
        })
        return
      }

      default:
        // server.connected, file.edited, todo.updated, tui.* … nothing to reduce.
        return
    }
  },

  dismissError(): void {
    set({ error: null })
  }
}))

/** Convenience alias — some components prefer the longer name. */
export const useAppStore = useStore

/* ------------------------------------------------------------------ *
 * Bridge subscriptions — wired exactly once
 * ------------------------------------------------------------------ */

let subscribed = false

function subscribe(): void {
  if (subscribed) return
  subscribed = true
  try {
    const bridge = api()
    bridge.onEvent((event) => {
      useStore.getState().applyEvent(event)
    })
    bridge.onServer((status) => {
      const prev = useStore.getState().server
      useStore.setState({ server: status })
      // Server went down — clear providers so they get refetched on reconnect.
      if (!status.running && prev.running) {
        useStore.setState({ providers: [], defaultModels: {} })
      }
      // Server just came up (or came back) — refetch providers.
      if (status.running && !prev.running) {
        void (async () => {
          try {
            const result = await bridge.providers()
            useStore.setState({
              providers: result?.providers ?? [],
              defaultModels: result?.default ?? {}
            })
            const { providerID, modelID, providers } = useStore.getState()
            if (providers.length > 0 && !restoredSelectionValid(providers, providerID, modelID)) {
              const picked = pickDefaultModel(providers)
              const nextProvider = picked ? picked.providerID : null
              const nextModel = picked ? picked.modelID : null
              useStore.setState({ providerID: nextProvider, modelID: nextModel })
              savePrefs({
                directory: useStore.getState().directory,
                providerID: nextProvider,
                modelID: nextModel
              })
            }
          } catch (e) {
            useStore.setState({ error: errText(e) })
          }
        })()
      }
    })
  } catch (e) {
    subscribed = false
    useStore.setState({ error: errText(e) })
  }
}
