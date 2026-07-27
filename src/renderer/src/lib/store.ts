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
import { loadPrefs, savePrefs, type Theme, type RoutingMode } from './prefs'
import { pickDefaultModel, restoredSelectionValid, classifyError, isTokenThroughputLimit } from './rotation'
import { isFreeModel } from './freeTier'
import { classifyBilling, pickDefaultImageModel } from './imageModels'
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
} from './compare'
import { loadLedger, saveLedger, record429, recordSuccess, recordFailure, recordTimeout, reserveAttempt, releaseAttempt, selectModel, DEFAULT_PROVIDER_CAPS, parseModelKey, type Ledger } from './routing'
import { sortMessages, upsertMessage, removeMessage, upsertPart, removePart, sortSessions, upsertSession, samePath, compareIds, makeNotice, makeImageNotice, type NoticeImage } from './collections'
import { getMatchingCommands } from './commands'
import type { AppSettings, AppSettingsResult, Message, MessageWithParts, OcEvent, Part, Permission, PermissionResponse, Provider, ServerStatus, Session, Todo, ServerCommand, ProjectRecord, PromptPart, UpdateStatus, GeneratedImageMeta, NanogptGenerateArgs, NanogptGenerateResult, NanogptModelsResult, NanogptRefreshResult, NanoUsage } from './types'

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
    update(directory: string, id: string, title: string): Promise<Session>
    summarize(a: { directory: string; sessionID: string; providerID: string; modelID: string }): Promise<boolean>
    init(a: { directory: string; sessionID: string; providerID: string; modelID: string; messageID: string }): Promise<boolean>
    todos(directory: string, sessionID: string): Promise<Todo[]>
    command(a: { directory: string; sessionID: string; command: string; arguments: string }): Promise<void>
  }
  commands: { list(directory: string): Promise<ServerCommand[]> }
  find: { files(directory: string, query: string): Promise<string[]> }
  vcs: { get(directory: string): Promise<{ branch: string } | null> }
  projects: {
    list(): Promise<ProjectRecord[]>
    create(name: string): Promise<ProjectRecord>
    getInstructions(directory: string): Promise<string>
    setInstructions(directory: string, text: string): Promise<void>
    listKnowledge(directory: string): Promise<import('./types').KnowledgeFile[]>
    addKnowledge(directory: string, filePaths?: string[]): Promise<import('./types').KnowledgeFile[]>
    removeKnowledge(directory: string, filename: string): Promise<void>
  }
  appSettings: {
    get(): Promise<AppSettingsResult>
    set(patch: Partial<AppSettings>): Promise<AppSettingsResult>
  }
  nanogpt: {
    models(): Promise<NanogptModelsResult>
    refresh(): Promise<NanogptRefreshResult>
    usage(): Promise<NanoUsage>
    generate(a: NanogptGenerateArgs): Promise<NanogptGenerateResult>
    images: {
      list(sessionID?: string): Promise<GeneratedImageMeta[]>
      read(id: string): Promise<string | null>
      remove(id: string): Promise<void>
    }
  }
  messages(directory: string, sessionID: string): Promise<MessageWithParts[]>
  revertMessage(a: { directory: string; sessionID: string; messageID: string }): Promise<void>
  prompt(a: {
    directory: string
    sessionID: string
    providerID: string
    modelID: string
    text: string
    parts?: PromptPart[]
    /** Per-request tool policy; compare runs use it to disable every mutating tool. */
    tools?: Record<string, boolean>
  }): Promise<void>
  abort(directory: string, sessionID: string): Promise<void>
  providers(): Promise<{ providers: Provider[]; default: Record<string, string>; linkedProviderIDs: string[] }>
  replyPermission(a: {
    directory: string
    sessionID: string
    permissionID: string
    response: PermissionResponse
  }): Promise<void>
  openExternal(url: string): Promise<void>
  onEvent(cb: (e: OcEvent) => void): () => void
  onServer(cb: (s: ServerStatus) => void): () => void
  onUpdateStatus(cb: (status: UpdateStatus) => void): () => void
}

function api(): OpencodeApi {
  const bridge = (window as unknown as { api?: OpencodeApi }).api
  if (!bridge) {
    throw new Error('Preload bridge unavailable — window.api is not defined.')
  }
  return bridge
}

let lastPrompt: { text: string; parts?: PromptPart[]; sessionID: string; userMessageID: string | null } | null = null
let rotateRetries = 0
let routingLedger: Ledger = {}
let lastSendStartTime: number | null = null
const DEFAULT_TTFT_MS = 20_000
const DEFAULT_STALL_MS = 90_000
type ActiveAttempt = {
  attemptId: number
  sessionID: string
  providerID: string
  modelID: string
  startedAt: number
  ttftTimer: ReturnType<typeof setTimeout> | null
  stallTimer: ReturnType<typeof setTimeout> | null
  hasStreamed: boolean
  toolExecuted: boolean
  pausedForTool: boolean
  pausedForPermission: boolean
  failoverInFlight: boolean
  /** The user message id that opened this exchange, for revertMessage transactionality. */
  userMessageID: string | null
}
let attemptCounter = 0
let activeAttempt: ActiveAttempt | null = null
let abortForRecoverySessionID: string | null = null

/** Turn anything thrown across IPC into a readable one-liner. */
export function errText(e: unknown): string {
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
  /** Main-process verified only; never inferred from OpenCode's provider metadata. */
  linkedProviderIDs: string[]
  providerID: string | null
  modelID: string | null
  /** User's pinned choice — mutated only by setModel. Never overwritten by failover. */
  pinnedProviderID: string | null
  pinnedModelID: string | null
  autoRotate: boolean
  modelPool: string[] | null
  stickyModel: boolean
  routingMode: RoutingMode
  showPaidModels: boolean
  // permissions awaiting user answer, oldest first
  permissions: Permission[]
  // last error banner text, null when clear
  error: string | null

  todos: Todo[]
  branch: string | null
  queuedPrompts: Array<{ text: string, parts?: PromptPart[] }>
  serverCommands: ServerCommand[]
  projects: ProjectRecord[]
  activeView: 'chats' | 'projects' | 'images'
  appSettings: AppSettings
  shortcutRegistered: boolean
  shortcutError: string | null
  updateStatus: UpdateStatus
  theme: Theme
  activeArtifactID: string | null

  /* ---- multi-model fan-out (compare runs) ---- */
  /** The active compare run, or null. While non-null, Chat renders CompareView. */
  compare: CompareRun | null
  /** Persisted `"providerID/modelID"` targets for the next fan-out. */
  compareTargets: string[]
  setCompareTargets(keys: string[]): void
  /**
   * Fan one prompt out to every target as its own read-only session.
   * Never engages the failover machinery — see the note on `applyCompareEvent`.
   */
  sendToMany(text: string, parts?: PromptPart[]): Promise<void>
  abortCompare(): Promise<void>
  /** Adopt a column's session as the active (fully tool-enabled) session and clear the run. */
  promoteCompareColumn(index: number): Promise<void>
  /** Delete every session in the run and clear it. */
  discardCompare(): Promise<void>
  /** Leave the run's sessions in place but stop showing the comparison. */
  clearCompare(): void

  // actions
  init(): Promise<void>
  pickDirectory(): Promise<void>
  setDirectory(dir: string): Promise<void>
  loadProjects(): Promise<void>
  createProject(name: string): Promise<ProjectRecord>
  openProject(project: ProjectRecord): Promise<void>
  setActiveView(view: 'chats' | 'projects' | 'images'): void
  loadAppSettings(): Promise<void>
  updateAppSettings(patch: Partial<AppSettings>): Promise<void>
  setUpdateStatus(status: UpdateStatus): void
  newSession(): Promise<void>
  selectSession(id: string): Promise<void>
  deleteSession(id: string): Promise<void>
  send(text: string, parts?: PromptPart[]): Promise<void>
  abort(): Promise<void>
  setModel(providerID: string, modelID: string): void
  revertToPinned(): void
  toggleAutoRotate(): void
  toggleStickyModel(): void
  setRoutingMode(mode: RoutingMode): void
  setShowPaidModels(v: boolean): void
  setModelPool(pool: string[] | null): void
  rotateToNextFreeModel(exclude?: string, excludeProviderID?: string): { providerID: string; modelID: string; providerName: string; modelName: string } | null
  addSystemNotice(text: string): void
  executeSlashCommand(cmdText: string): Promise<void>
  replyPermission(id: string, response: PermissionResponse): Promise<void>
  applyEvent(e: OcEvent): void
  dismissError(): void
  renameSession(id: string, title: string): Promise<void>
  setTheme(t: Theme): void
  queuePrompt(text: string, parts?: PromptPart[]): void
  removeQueued(index: number): void
  retryExchange(messageID: string): Promise<void>
  editAndResend(messageID: string, newText: string): Promise<void>
  setActiveArtifactID(id: string | null): void
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
  linkedProviderIDs: [],
  providerID: null,
  modelID: null,
  pinnedProviderID: null,
  pinnedModelID: null,
  autoRotate: false,
  modelPool: null,
  stickyModel: false,
  routingMode: 'failover' as RoutingMode,
  showPaidModels: false,
  permissions: [],
  error: null,
  todos: [],
  branch: null,
  queuedPrompts: [],
  serverCommands: [],
  projects: [],
  activeView: 'chats',
  appSettings: { closeToTray: true, globalShortcut: 'Ctrl+Alt+Space', showPaidModels: false, ttftMs: 20_000, stallMs: 90_000, nanogptSubscriptionOnly: true },
  shortcutRegistered: false,
  shortcutError: null,
  updateStatus: { state: 'idle' },
  theme: 'auto' as Theme,
  activeArtifactID: null,
  compare: null,
  compareTargets: [],

  async init(): Promise<void> {
    subscribe()
    routingLedger = loadLedger()
    const appSettingsReady = get().loadAppSettings()

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
    let linkedProviderIDs: string[] = []
    if (get().server.running) {
      try {
        const result = await api().providers()
        providers = result?.providers ?? []
        defaultModels = result?.default ?? {}
        linkedProviderIDs = result?.linkedProviderIDs ?? []
        set({ providers, defaultModels, linkedProviderIDs })
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
    const linkedProviders = providers.filter((provider) => linkedProviderIDs.includes(provider.id))
    if (linkedProviders.length > 0 && !restoredSelectionValid(linkedProviders, providerID, modelID, prefs.showPaidModels)) {
      const picked = pickDefaultModel(linkedProviders)
      providerID = picked ? picked.providerID : null
      modelID = picked ? picked.modelID : null
    }

    set({
      providerID,
      modelID,
      pinnedProviderID: providerID,
      pinnedModelID: modelID,
      autoRotate: prefs.autoRotate,
      theme: prefs.theme,
      modelPool: prefs.modelPool,
      stickyModel: prefs.stickyModel,
      routingMode: prefs.routingMode,
      showPaidModels: prefs.showPaidModels,
      compareTargets: prefs.compareTargets,
    })
    savePrefs({
      directory: prefs.directory,
      providerID,
      modelID,
      autoRotate: prefs.autoRotate,
      theme: prefs.theme,
      modelPool: prefs.modelPool,
      stickyModel: prefs.stickyModel,
      routingMode: prefs.routingMode,
      showPaidModels: prefs.showPaidModels,
    })

    await appSettingsReady
    await get().loadProjects()

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
    const { providerID, modelID, autoRotate, modelPool, stickyModel } = get()
    savePrefs({ directory: dir, providerID, modelID, autoRotate, theme: get().theme, modelPool, stickyModel })

    try {
      const sessions = await api().sessions.list(dir)
      if (get().directory !== dir) return
      set({ sessions: sortSessions(sessions ?? []) })
    } catch (e) {
      set({ error: errText(e) })
    }
    try {
      const vcsInfo = await api().vcs.get(dir)
      set({ branch: vcsInfo?.branch ?? null })
    } catch {
      set({ branch: null })
    }
    try {
      const commands = await api().commands.list(dir)
      set({ serverCommands: commands ?? [] })
    } catch {
      set({ serverCommands: [] })
    }
  },

  async loadProjects(): Promise<void> {
    try {
      const projects = await api().projects.list()
      set({ projects: projects ?? [] })
    } catch (e) {
      set({ error: errText(e) })
    }
  },

  async createProject(name: string): Promise<ProjectRecord> {
    try {
      const project = await api().projects.create(name)
      set((state) => ({
        projects: [project, ...state.projects.filter((row) => row.id !== project.id)],
        error: null
      }))
      await get().setDirectory(project.directory)
      return project
    } catch (e) {
      const message = errText(e)
      set({ error: message })
      throw new Error(message)
    }
  },

  async openProject(project: ProjectRecord): Promise<void> {
    await get().setDirectory(project.directory)
  },

  setActiveView(view: 'chats' | 'projects' | 'images'): void {
    set({ activeView: view })
  },

  async loadAppSettings(): Promise<void> {
    try {
      const result = await api().appSettings.get()
      set({
        appSettings: result.settings,
        shortcutRegistered: result.shortcutRegistered,
        shortcutError: result.shortcutError ?? null
      })
    } catch (e) {
      set({ error: errText(e) })
    }
  },

  async updateAppSettings(patch: Partial<AppSettings>): Promise<void> {
    try {
      const result = await api().appSettings.set(patch)
      set({
        appSettings: result.settings,
        shortcutRegistered: result.shortcutRegistered,
        shortcutError: result.shortcutError ?? null
      })
    } catch (e) {
      set({ error: errText(e) })
    }
  },

  setUpdateStatus(status: UpdateStatus): void {
    set({ updateStatus: status })
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
    try {
      const todos = await api().sessions.todos(directory, id)
      if (get().activeSessionID === id) set({ todos: todos ?? [] })
    } catch {
      // Todos are optional
    }
    // Generated images are local-only synthetic messages, so the server transcript above does not
    // contain them. Restore them from the on-disk gallery index.
    await rehydrateSessionImages(id, get, set)
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

  toggleAutoRotate(): void {
    const next = !get().autoRotate
    set({ autoRotate: next })
    const { directory, providerID, modelID, theme, modelPool, stickyModel } = get()
    savePrefs({ directory, providerID, modelID, autoRotate: next, theme, modelPool, stickyModel })
  },

  toggleStickyModel(): void {
    const next = !get().stickyModel
    set({ stickyModel: next })
    const { directory, providerID, modelID, autoRotate, theme, modelPool, routingMode, showPaidModels } = get()
    savePrefs({ directory, providerID, modelID, autoRotate, theme, modelPool, stickyModel: next, routingMode, showPaidModels })
  },

  setRoutingMode(mode: RoutingMode): void {
    // Keep legacy booleans in sync for read-only consumers during transition
    const autoRotate = mode === 'auto'
    const stickyModel = mode === 'failover'
    set({ routingMode: mode, autoRotate, stickyModel })
    const { directory, providerID, modelID, theme, modelPool, showPaidModels } = get()
    savePrefs({ directory, providerID, modelID, autoRotate, theme, modelPool, stickyModel, routingMode: mode, showPaidModels })
  },

  setShowPaidModels(v: boolean): void {
    set({ showPaidModels: v })
    const { directory, providerID, modelID, autoRotate, theme, modelPool, stickyModel, routingMode } = get()
    savePrefs({ directory, providerID, modelID, autoRotate, theme, modelPool, stickyModel, routingMode, showPaidModels: v })
  },

  setModelPool(pool: string[] | null): void {
    set({ modelPool: pool })
    const { directory, providerID, modelID, autoRotate, theme, stickyModel } = get()
    savePrefs({ directory, providerID, modelID, autoRotate, theme, modelPool: pool, stickyModel })
  },

  rotateToNextFreeModel(exclude?: string, excludeProviderID?: string): { providerID: string; modelID: string; providerName: string; modelName: string } | null {
    const { providers, linkedProviderIDs, providerID: currentP, modelID: currentM, modelPool } = get()
    if (providers.length === 0) return null

    // Free-only pool for auto-failover (never routes to paid, even if showPaidModels is on)
    const available = new Set<string>()
    for (const p of providers) {
      if (!linkedProviderIDs.includes(p.id)) continue
      for (const m of Object.values(p.models ?? {}) as Array<{ id: string }>) {
        if (isAgentModel(m as any) && isFreeModel(p.id, m.id)) available.add(`${p.id}/${m.id}`)
      }
    }
    // A failed model must never be immediately selected again.  Transient
    // errors do not impose a long provider cooldown, so relying on the ledger
    // alone can otherwise make failover retry the same high-ranked model.
    if (exclude) available.delete(exclude)
    if (excludeProviderID) {
      for (const key of available) {
        if (parseModelKey(key)?.providerID === excludeProviderID) available.delete(key)
      }
    }

    const chosenKey = selectModel(modelPool, routingLedger, DEFAULT_PROVIDER_CAPS, Date.now(), {
      sticky: false,
      current: currentP && currentM ? `${currentP}/${currentM}` : null,
      available,
      authenticatedProviders: new Set(linkedProviderIDs)
    })

    if (chosenKey && chosenKey !== `${currentP}/${currentM}`) {
      const parsed = parseModelKey(chosenKey)
      if (!parsed) return null
      const { providerID: nextP, modelID: nextM } = parsed
      const provider = providers.find((p) => p.id === nextP)
      const model = provider?.models?.[nextM]
      if (provider && model) {
        // R4: effective-only rotation — do NOT savePrefs; chosen pin stays intact
        set({ providerID: nextP, modelID: nextM })
        return {
          providerID: nextP,
          modelID: nextM,
          providerName: provider.name,
          modelName: model.name ?? nextM
        }
      }
    }

    return null
  },

  addSystemNotice(text: string): void {
    const activeSessionID = get().activeSessionID ?? 'default'
    set((state) => ({ messages: sortMessages([...state.messages, makeNotice(activeSessionID, text)]) }))
  },

  async renameSession(id: string, title: string): Promise<void> {
    const directory = get().directory
    if (!directory) return
    try {
      const updated = await api().sessions.update(directory, id, title)
      set((state) => ({ sessions: upsertSession(state.sessions, updated) }))
    } catch (e) {
      set({ error: errText(e) })
    }
  },

  setTheme(t: Theme): void {
    set({ theme: t })
    const { directory, providerID, modelID, autoRotate, modelPool, stickyModel } = get()
    savePrefs({ directory, providerID, modelID, autoRotate, theme: t, modelPool, stickyModel })
  },

  queuePrompt(text: string, parts?: PromptPart[]): void {
    set((state) => ({ queuedPrompts: [...state.queuedPrompts, { text, parts }] }))
  },

  removeQueued(index: number): void {
    set((state) => ({
      queuedPrompts: state.queuedPrompts.filter((_, i) => i !== index)
    }))
  },

  async retryExchange(messageID: string): Promise<void> {
    const { directory, activeSessionID, providerID, modelID, messages } = get()
    if (!directory || !activeSessionID || !providerID || !modelID) return
    const msgIndex = messages.findIndex((m) => m.info.id === messageID)
    if (msgIndex < 0) return
    let userText: string | null = null
    for (let i = msgIndex - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.info.role === 'user') {
        const textParts = m.parts.filter((p) => p.type === 'text')
        userText = textParts.map((p) => (p as { text: string }).text).join('\n').trim()
        break
      }
    }
    if (!userText) return
    set({ busy: true, error: null })
    try {
      await api().prompt({ directory, sessionID: activeSessionID, providerID, modelID, text: userText })
    } catch (e) {
      set({ busy: false, error: errText(e) })
    }
  },

  async editAndResend(messageID: string, newText: string): Promise<void> {
    const { directory, activeSessionID, messages } = get()
    if (!directory || !activeSessionID) return
    if (newText.trim().length === 0) return

    const msgIndex = messages.findIndex((m) => m.info.id === messageID)
    if (msgIndex < 0) return
    if (messages[msgIndex].info.role !== 'user') return

    try {
      // Revert the server to before the edited user message. This also restores
      // workspace file snapshots — expected behaviour for edit-and-resend.
      await api().revertMessage({ directory, sessionID: activeSessionID, messageID })
      // Optimistically drop the edited message and everything after it.
      set({ messages: messages.slice(0, msgIndex) })
      // Reuse send() so routing / rotation / queueing all apply.
      await get().send(newText)
    } catch (e) {
      set({ error: errText(e) })
    }
  },

  setActiveArtifactID(id: string | null): void {
    set({ activeArtifactID: id })
  },

  async executeSlashCommand(cmdText: string): Promise<void> {
    const parts = cmdText.trim().split(/\s+/)
    const command = parts[0].toLowerCase()
    const directory = get().directory

    if (!directory) {
      set({ error: 'Pick a project folder first.' })
      return
    }

    let sessionID = get().activeSessionID
    if (!sessionID) {
      try {
        const session = await api().sessions.create(directory)
        sessionID = session.id
        set((state) => ({
          sessions: upsertSession(state.sessions, session),
          activeSessionID: session.id,
          messages: [],
          permissions: []
        }))
      } catch (e) {
        set({ error: errText(e) })
        return
      }
    }

    const usrId = `usr-${Date.now()}`
    const userMsg: MessageWithParts = {
      info: {
        id: usrId,
        sessionID: sessionID!,
        role: 'user',
        time: { created: Math.floor(Date.now() / 1000) }
      } as any,
      parts: [
        {
          id: `part-${usrId}`,
          messageID: usrId,
          sessionID: sessionID!,
          type: 'text',
          text: cmdText
        } as any
      ]
    }
    set((state) => ({ messages: sortMessages([...state.messages, userMsg]) }))

    const allMatching = getMatchingCommands(command, get().serverCommands)
    const exactMatch = allMatching.find((c) => c.name === command || c.alias === command)

    if (exactMatch && exactMatch.action) {
      const args = cmdText.slice(parts[0].length).trim()
      await exactMatch.action(args)
      return
    }

    if (command === '/help') {
      const helpText = `### 🤖 Claude Code Style Slash Commands

| Command | Description |
|---|---|
| \`/help\` | Show available slash commands and usage guide |
| \`/free\` or \`/auto\` | Toggle Free Model Auto-Routing (auto-cycles models on 429 rate limits) |
| \`/clear\` | Clear current conversation messages |
| \`/models\` | List available AI models and active provider status |
| \`/doctor\` | Run environment and OpenCode server diagnostics |
| \`/compact\` | Compact conversation context |
| \`/init\` | Create a default \`opencode.json\` config file in project folder |
| \`/cost\` | Display session message statistics and provider metrics |
| \`/image <prompt>\` | Generate an image with NanoGPT (alias \`/img\`) |`
      get().addSystemNotice(helpText)
    } else if (command === '/clear') {
      const sid = get().activeSessionID
      set({ messages: [] })
      get().addSystemNotice(
        sid
          ? `🧹 Cleared local view (server session \`${sid}\` intact). Start a new session for a fresh context.`
          : '🧹 Cleared local view. Start a new session for a fresh context.'
      )
    } else if (command === '/models') {
      const { providers, providerID, modelID, autoRotate } = get()
      let text = `### 🧠 Models & Providers\n\n**Active Model:** \`${providerID}/${modelID}\`\n**Free Auto-Routing:** ${autoRotate ? '⚡ ENABLED (cycles models on 429 rate limits)' : '⚪ DISABLED'}\n\n`
      if (providers.length === 0) {
        text += '_No providers currently connected._'
      } else {
        text += '#### Authenticated Providers:\n'
        for (const p of providers) {
          const count = Object.values(p.models ?? {}).filter(isAgentModel).length
          text += `- **${p.name}** (\`${p.id}\`): ${count} agent models available\n`
        }
      }
      get().addSystemNotice(text)
    } else if (command === '/free' || command === '/auto') {
      get().toggleAutoRotate()
      const nextState = get().autoRotate
      get().addSystemNotice(
        nextState
          ? '⚡ **Free Model Auto-Routing is now ENABLED.** OpenCode Desktop will automatically cycle to another free model (Gemini, Groq, OpenRouter, Cerebras, Mistral, Cohere) whenever a 429 rate limit or quota error occurs!'
          : '⚪ **Free Model Auto-Routing is now DISABLED.**'
      )
    } else if (command === '/image' || command === '/img') {
      await runImageCommand(cmdText.slice(parts[0].length).trim(), sessionID!, set, get)
    } else if (command === '/doctor') {
      const { server, directory, providers, providerID, modelID, autoRotate } = get()
      const text = `### 🩺 System Diagnostics

- **OpenCode Server Status:** ${server.running ? '✅ Running' : '❌ Offline'} (${server.url ?? 'N/A'})
- **Project Directory:** \`${directory ?? 'None'}\`
- **Active Model:** \`${providerID ?? 'None'} / ${modelID ?? 'None'}\`
- **Connected Providers:** ${providers.length} (${providers.map((p) => p.name).join(', ') || 'None'})
- **Free Model Auto-Routing:** ${autoRotate ? '⚡ Enabled' : 'Disabled'}
- **Platform:** Windows`
      get().addSystemNotice(text)
    } else {
      get().addSystemNotice(`Unknown slash command: \`${command}\`. Type \`/help\` for a list of available commands.`)
    }
  },

  async send(text: string, parts?: PromptPart[]): Promise<void> {
    const trimmed = text.trim()
    if (trimmed.length === 0) return

    if (trimmed.startsWith('/')) {
      await get().executeSlashCommand(trimmed)
      return
    }

    const { directory, routingMode, modelPool, providers, linkedProviderIDs } = get()
    let { providerID, modelID } = get()

    if (!directory) {
      set({ error: 'Pick a project folder first.' })
      return
    }

    // Legacy 'auto' mode: keep the proactive pre-send hijack for power users.
    // 'failover' (default) and 'locked' modes never pre-swap the user's pick.
    if (routingMode === 'auto' && providers.length > 0) {
      const available = new Set<string>()
      for (const p of providers) {
        if (!linkedProviderIDs.includes(p.id)) continue
        for (const m of Object.values(p.models ?? {}) as Array<{ id: string }>) {
          if (isAgentModel(m as any) && isFreeModel(p.id, m.id)) available.add(`${p.id}/${m.id}`)
        }
      }

      const currentKey = providerID && modelID ? `${providerID}/${modelID}` : null
      const chosenKey = selectModel(modelPool, routingLedger, DEFAULT_PROVIDER_CAPS, Date.now(), {
        sticky: false,
        current: currentKey,
        available,
        authenticatedProviders: new Set(linkedProviderIDs)
      })

      if (chosenKey && chosenKey !== currentKey) {
        const parsed = parseModelKey(chosenKey)
        if (parsed) {
          providerID = parsed.providerID
          modelID = parsed.modelID
          set({ providerID, modelID })
          // Effective-only rotation: do NOT savePrefs — user's chosen pin stays intact.
          const pName = providers.find((p) => p.id === providerID)?.name ?? providerID
          const mName = providers.find((p) => p.id === providerID)?.models?.[modelID]?.name ?? modelID
          get().addSystemNotice(`⚡ **Auto-mode: proactively selected ${pName} · ${mName}**`)
        }
      }
    }

    if (!providerID || !modelID) {
      set({ error: 'Choose a model before sending a message.' })
      return
    }
    if (!linkedProviderIDs.includes(providerID)) {
      set({ error: `Add an API key for ${providerID} before routing a request to it.` })
      return
    }

    let sessionID = get().activeSessionID
    if (!sessionID) {
      try {
        const session = await api().sessions.create(directory)
        sessionID = session.id
        set((state) => ({
          sessions: upsertSession(state.sessions, session),
          activeSessionID: session.id,
          messages: [],
          permissions: []
        }))
      } catch (e) {
        set({ busy: false, error: errText(e) })
        return
      }
    }

    lastPrompt = { text: trimmed, parts, sessionID, userMessageID: null }
    rotateRetries = 0
    lastSendStartTime = Date.now()
    routingLedger = reserveAttempt(routingLedger, `${providerID}/${modelID}`, lastSendStartTime)
    saveLedger(routingLedger)
    startActiveAttempt(sessionID, providerID, modelID)
    set({ busy: true, error: null })

    try {
      await api().prompt({ directory, sessionID, providerID, modelID, text: trimmed, parts })
    } catch (e) {
      clearActiveAttempt(sessionID)
      const errString = errText(e)
      const now = Date.now()
      const errClass = classifyError(errString)
      const failedProviderID = isTokenThroughputLimit(errString) ? providerID : undefined
      if (providerID && modelID) {
        if (errClass === 'rpm-wait' || errClass === 'rpd-drop') {
          routingLedger = record429(routingLedger, `${providerID}/${modelID}`, now)
        } else {
          routingLedger = recordFailure(routingLedger, `${providerID}/${modelID}`, now)
        }
        // Release the reservation — dispatch failed before the request landed
        routingLedger = releaseAttempt(routingLedger, `${providerID}/${modelID}`)
        saveLedger(routingLedger)
      }

      const canFailover =
        get().routingMode !== 'locked' &&
        (errClass === 'rpm-wait' || errClass === 'rpd-drop' || errClass === 'timeout' || errClass === 'transient')

      // R1 guard: if any tool ran or tokens streamed, do NOT auto-retry
      const attemptSafe = !activeAttempt?.toolExecuted && !activeAttempt?.hasStreamed

      if (canFailover && attemptSafe) {
        const failoverResult = await beginFailover(
          sessionID,
          directory,
          trimmed,
          parts,
          `Rate limit / error on ${providerID}/${modelID}`,
          `${providerID}/${modelID}`,
          failedProviderID,
        )
        if (failoverResult) return
      }
      set({ busy: false, error: errString })
    }
  },

  setCompareTargets(keys: string[]): void {
    const deduped = [...new Set(keys)].slice(0, MAX_COMPARE_TARGETS)
    set({ compareTargets: deduped })
    const { directory, providerID, modelID, autoRotate, theme, modelPool, stickyModel, routingMode, showPaidModels } = get()
    savePrefs({ directory, providerID, modelID, autoRotate, theme, modelPool, stickyModel, routingMode, showPaidModels, compareTargets: deduped })
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
  },

  async abort(): Promise<void> {
    const { directory, activeSessionID } = get()
    if (!directory || !activeSessionID) return
    try {
      clearActiveAttempt(activeSessionID)
      await api().abort(directory, activeSessionID)
      set({ busy: false })
    } catch (e) {
      set({ busy: false, error: errText(e) })
    }
  },

  setModel(providerID: string, modelID: string): void {
    // Setting a model updates BOTH pinned (user intent) and effective (current run)
    set({ providerID, modelID, pinnedProviderID: providerID, pinnedModelID: modelID })
    const { directory, autoRotate, theme, modelPool, stickyModel, routingMode, showPaidModels } = get()
    savePrefs({ directory, providerID, modelID, autoRotate, theme, modelPool, stickyModel, routingMode, showPaidModels })
  },

  revertToPinned(): void {
    const { pinnedProviderID, pinnedModelID } = get()
    if (!pinnedProviderID || !pinnedModelID) return
    set({ providerID: pinnedProviderID, modelID: pinnedModelID })
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

    // Compare-run traffic is handled entirely separately and returns before the switch below, so it
    // can never reach the single-slot attempt machine, the routing ledger, or beginFailover.
    if (applyCompareEvent(e, set, get)) return

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

        // Capture the opening user message ID for transactional revert
        const anyPart = part as any
        if (anyPart.messageID && lastPrompt?.sessionID === part.sessionID && !lastPrompt.userMessageID) {
          // Only capture the FIRST message id (the user turn opener)
          const msg = state.messages.find((m) => m.info.id === anyPart.messageID)
          if (msg?.info.role === 'user') {
            lastPrompt = { ...lastPrompt, userMessageID: anyPart.messageID }
            if (activeAttempt && activeAttempt.userMessageID === null) {
              activeAttempt.userMessageID = anyPart.messageID
            }
          }
        }

        // Tool part lifecycle → pause/resume stall watchdog
        if (part.type === 'tool') {
          const toolState = (part as any).state?.status
          if (toolState === 'pending' || toolState === 'running') {
            markToolStarted(part.sessionID)
          } else if (toolState === 'completed' || toolState === 'error') {
            markToolCompleted(part.sessionID)
          }
        } else if (part.type === 'text' || part.type === 'reasoning') {
          // Real streaming token → clear TTFT, arm stall
          touchActiveAttempt(part.sessionID)
        }

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
        markPermissionAsked(permission.sessionID)
        set({ permissions: [...state.permissions, permission] })
        return
      }

      case 'permission.replied': {
        const permissionID = props.permissionID as string | undefined
        if (!permissionID) return
        if (!state.permissions.some((p) => p.id === permissionID)) return
        // Locate its sessionID before removing
        const p = state.permissions.find((x) => x.id === permissionID)
        if (p) markPermissionReplied(p.sessionID)
        set({ permissions: state.permissions.filter((x) => x.id !== permissionID) })
        return
      }

      case 'session.status': {
        const sessionID = props.sessionID as string | undefined
        const status = props.status as { type?: string } | undefined
        if (!sessionID || sessionID !== state.activeSessionID) return
        // Pause stall watchdog during server-side retry so it doesn't fire
        if (status?.type === 'retry' && activeAttempt?.sessionID === sessionID) {
          if (activeAttempt.stallTimer) clearTimeout(activeAttempt.stallTimer)
          activeAttempt.stallTimer = null
        } else if (status?.type === 'busy' && activeAttempt?.sessionID === sessionID) {
          armStallWatchdog()
        }
        const busy = status?.type === 'busy' || status?.type === 'retry'
        if (busy !== state.busy) set({ busy })
        return
      }

      case 'session.idle': {
        const sessionID = props.sessionID as string | undefined
        if (sessionID !== state.activeSessionID) return
        if (state.busy) set({ busy: false })

        const now = Date.now()
        const attempt = activeAttempt
        const cleanCompletion = attempt?.sessionID === sessionID && !attempt.failoverInFlight
        if (attempt?.sessionID === sessionID) {
          const latencyMs = Math.max(50, now - attempt.startedAt)
          clearActiveAttempt(sessionID)
          lastSendStartTime = null
          routingLedger = recordSuccess(routingLedger, `${attempt.providerID}/${attempt.modelID}`, latencyMs, now)
          saveLedger(routingLedger)
        }
        // R2: reset per-exchange retry counter ONLY on clean completion
        if (cleanCompletion) rotateRetries = 0
        if (lastPrompt?.sessionID === sessionID) lastPrompt = null

        const queue = get().queuedPrompts
        if (queue.length > 0) {
          const next = queue[0]
          set({ queuedPrompts: queue.slice(1) })
          void get().send(next.text, next.parts)
        }
        return
      }

      case 'session.error': {
        const sessionID = props.sessionID as string | undefined
        // Never associate an unscoped server error with the current request:
        // doing so could replay a stale prompt into an unrelated session.
        if (!sessionID || sessionID !== state.activeSessionID) return
        // Widened cast — the SDK's ApiError already exposes responseHeaders/
        // statusCode/isRetryable; the previous cast discarded them.
        const error = props.error as
          | {
              name?: string
              data?: {
                message?: string
                statusCode?: number
                isRetryable?: boolean
                responseHeaders?: Record<string, string>
                responseBody?: string
              }
            }
          | undefined

        if (error?.name === 'MessageAbortedError') {
          if (abortForRecoverySessionID === sessionID) {
            abortForRecoverySessionID = null
            return
          }
          clearActiveAttempt(sessionID)
          set({ busy: false })
          lastSendStartTime = null
          return
        }
        const message =
          error?.data?.message ?? error?.name ?? 'The session reported an error.'

        const now = Date.now()
        const retryAfterMs = parseRetryAfterMs(error?.data?.responseHeaders ?? null)
        const errClass = classifyError(message, {
          statusCode: error?.data?.statusCode,
          isRetryable: error?.data?.isRetryable,
          retryAfterMs,
        })

        const attempt = activeAttempt?.sessionID === sessionID ? activeAttempt : null
        const failedProviderID = isTokenThroughputLimit(message) ? attempt?.providerID : undefined
        const attemptSafe = !attempt?.toolExecuted && !attempt?.hasStreamed
        clearActiveAttempt(sessionID)
        lastSendStartTime = null

        if (attempt) {
          if (errClass === 'rpm-wait' || errClass === 'rpd-drop') {
            routingLedger = record429(routingLedger, `${attempt.providerID}/${attempt.modelID}`, now, retryAfterMs)
          } else {
            routingLedger = recordFailure(routingLedger, `${attempt.providerID}/${attempt.modelID}`, now)
          }
          saveLedger(routingLedger)
        }

        const capturedPrompt = lastPrompt?.sessionID === sessionID ? lastPrompt : null
        const canFailover =
          state.routingMode !== 'locked' &&
          (errClass === 'rpm-wait' || errClass === 'rpd-drop' || errClass === 'timeout' || errClass === 'transient')

        if (canFailover && attemptSafe && capturedPrompt && state.directory) {
          void (async () => {
            const failedOver = await beginFailover(
              sessionID,
              state.directory!,
              capturedPrompt.text,
              capturedPrompt.parts,
              `${errClass}: ${message.slice(0, 80)}`,
              attempt ? `${attempt.providerID}/${attempt.modelID}` : undefined,
              failedProviderID,
            )
            if (!failedOver) set({ busy: false, error: message })
          })()
          return
        }

        if (!attemptSafe) {
          state.addSystemNotice(
            `⚠️ **Auto-retry blocked: side effects already committed** (tools ran or tokens streamed). Send again to try a different model.`
          )
        }

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

      case 'todo.updated': {
        const sessionID = props.sessionID as string | undefined
        if (sessionID !== state.activeSessionID) return
        const directory = state.directory
        if (!directory || !sessionID) return
        void (async () => {
          try {
            const todos = await api().sessions.todos(directory, sessionID)
            if (get().activeSessionID === sessionID) set({ todos: todos ?? [] })
          } catch { /* ignore */ }
        })()
        return
      }

      case 'vcs.branch.updated': {
        const branch = props.branch as string | undefined
        if (branch !== undefined) set({ branch: branch || null })
        return
      }

      case 'session.compacted': {
        const sessionID = props.sessionID as string | undefined
        if (sessionID !== state.activeSessionID) return
        const directory = state.directory
        if (!directory || !sessionID) return
        void (async () => {
          try {
            const loaded = await api().messages(directory, sessionID)
            if (get().activeSessionID !== sessionID) return
            const messages = sortMessages(loaded ?? [])
            set({ messages: sortMessages([...messages, makeNotice(sessionID, 'Context compacted.')]) })
          } catch { /* ignore */ }
        })()
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
function applyCompareEvent(
  e: OcEvent,
  set: (fn: (state: AppState) => Partial<AppState>) => void,
  get: () => AppState
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

/* ------------------------------------------------------------------ *
 * NanoGPT image generation (/image, /img)
 * ------------------------------------------------------------------ */

/**
 * Most recent generated images restored into a transcript on session open.
 *
 * Each one is held live as a base64 `data:` URI, so this is a memory bound, not a display
 * preference. Older generations remain available in the Images view, which loads lazily.
 */
const MAX_REHYDRATED_IMAGES = 12

/** Compact caption line rendered above the generated thumbnails. */
function imageCaption(
  prompt: string,
  model: string,
  result: { billing: string; cost?: number; remainingBalance?: number }
): string {
  const badge =
    result.billing === 'subscription'
      ? '✅ subscription'
      : result.billing === 'balance'
        ? '⚠️ **billed to balance**'
        : '❔ billing unreported'
  const bits = [`\`${model}\``, badge]
  if (typeof result.cost === 'number') bits.push(`cost ${result.cost}`)
  if (result.billing === 'balance' && typeof result.remainingBalance === 'number') {
    bits.push(`balance left ${result.remainingBalance}`)
  }
  return `🖼️ **${prompt}**\n\n${bits.join(' · ')}`
}

/**
 * Run `/image <prompt>`: pick a model, generate, and append the results to the transcript.
 *
 * Model choice comes from the cached catalogue via `pickDefaultImageModel`, which excludes
 * balance-billing models while `nanogptSubscriptionOnly` is on. Any failure becomes a system notice
 * rather than the global error banner, so it stays attached to the command that caused it.
 */
async function runImageCommand(
  prompt: string,
  sessionID: string,
  set: (partial: Partial<AppState>) => void,
  get: () => AppState
): Promise<void> {
  if (prompt.length === 0) {
    get().addSystemNotice('Usage: `/image <prompt>` — for example `/image a red fox in snow, cinematic`.')
    return
  }

  const subscriptionOnly = get().appSettings.nanogptSubscriptionOnly

  let catalogue: NanogptModelsResult
  try {
    catalogue = await api().nanogpt.models()
  } catch (e) {
    get().addSystemNotice(`Could not read the NanoGPT image catalogue: ${errText(e)}`)
    return
  }

  if (catalogue.image.length === 0) {
    get().addSystemNotice(
      'No NanoGPT image models are cached yet. Open **Providers → NanoGPT** and choose **Refresh models**.'
    )
    return
  }

  const model = pickDefaultImageModel(catalogue.image, catalogue.balanceBilled, subscriptionOnly)
  if (model === null) {
    get().addSystemNotice(
      'Every cached NanoGPT image model is known to bill your balance. Turn off **Subscription images only** in Settings to use one.'
    )
    return
  }

  set({ busy: true })
  get().addSystemNotice(`🖼️ Generating with \`${model}\`…`)

  try {
    const result = await api().nanogpt.generate({ prompt, model, sessionID })
    const images: NoticeImage[] = result.images.map((image, index) => ({
      id: image.meta.id,
      dataUrl: `data:image/png;base64,${image.base64}`,
      filename: `${model.replace(/[^a-zA-Z0-9._-]/g, '_')}-${index + 1}.png`
    }))
    set({
      messages: sortMessages([
        ...get().messages,
        makeImageNotice(sessionID, imageCaption(prompt, model, result), images)
      ])
    })
    if (result.blacklisted) {
      get().addSystemNotice(
        `⚠️ \`${model}\` billed your NanoGPT **balance**, not your subscription (\`paymentSource: ${result.paymentSource ?? 'unknown'}\`). It has been marked and will be refused while **Subscription images only** is on.`
      )
    }
  } catch (e) {
    get().addSystemNotice(`Image generation failed: ${errText(e)}`)
  } finally {
    set({ busy: false })
  }
}

/**
 * Rebuild image messages for a session from the on-disk index.
 *
 * Generated images are appended as synthetic messages with no server-side counterpart, so a session
 * reload would otherwise drop them. Bytes are read lazily per image and the original `createdAt` is
 * preserved so each lands back in its original transcript position.
 */
async function rehydrateSessionImages(sessionID: string, get: () => AppState, set: (partial: Partial<AppState>) => void): Promise<void> {
  let metas: GeneratedImageMeta[]
  try {
    metas = await api().nanogpt.images.list(sessionID)
  } catch {
    return // an unreadable gallery must never block opening a session
  }
  if (metas.length === 0) return

  // Bound the memory this can pull in. Each image becomes a base64 `data:` URI held live in the
  // transcript, and a busy session can hold dozens — reading them all would spike renderer memory on
  // every session open. `list()` is newest-first, so this keeps the most recent ones.
  const recent = metas.slice(0, MAX_REHYDRATED_IMAGES)

  const notices: MessageWithParts[] = []
  for (const meta of recent) {
    // Re-check inside the loop: these reads are sequential IPC round trips, so a user who switches
    // session mid-flight should stop the work rather than let it run to completion and be discarded.
    if (get().activeSessionID !== sessionID) return
    let base64: string | null = null
    try {
      base64 = await api().nanogpt.images.read(meta.id)
    } catch {
      continue
    }
    if (base64 === null) continue
    notices.push(
      makeImageNotice(
        sessionID,
        imageCaption(meta.prompt, meta.model, {
          billing: classifyBilling(meta.paymentSource),
          ...(meta.cost !== undefined ? { cost: meta.cost } : {})
        }),
        [{
          id: meta.id,
          dataUrl: `data:image/png;base64,${base64}`,
          filename: `${meta.model.replace(/[^a-zA-Z0-9._-]/g, '_')}.png`
        }],
        meta.createdAt
      )
    )
  }
  if (notices.length === 0) return
  // Guard against the user having switched sessions while the reads were in flight.
  if (get().activeSessionID !== sessionID) return

  // Never let the cap misrepresent the transcript as complete — say what was left out and where to
  // find it.
  if (metas.length > recent.length) {
    notices.unshift(
      makeNotice(
        sessionID,
        `🖼️ Showing the ${recent.length} most recent generated images of ${metas.length} in this session. The rest are in the Images view.`
      )
    )
  }
  set({ messages: sortMessages([...get().messages, ...notices]) })
}

function clearActiveAttempt(sessionID?: string): void {
  if (!activeAttempt || (sessionID && activeAttempt.sessionID !== sessionID)) return
  if (activeAttempt.ttftTimer) clearTimeout(activeAttempt.ttftTimer)
  if (activeAttempt.stallTimer) clearTimeout(activeAttempt.stallTimer)
  activeAttempt = null
}

function getTtftMs(): number {
  return useStore.getState().appSettings.ttftMs ?? DEFAULT_TTFT_MS
}

function getStallMs(): number {
  return useStore.getState().appSettings.stallMs ?? DEFAULT_STALL_MS
}

/** TTFT watchdog — fires if no tokens arrive within ttftMs. */
function armTtftWatchdog(): void {
  if (!activeAttempt) return
  if (activeAttempt.ttftTimer) clearTimeout(activeAttempt.ttftTimer)
  const watched = activeAttempt
  watched.ttftTimer = setTimeout(() => {
    void recoverHungAttempt(watched, 'ttft')
  }, getTtftMs())
}

/** Stall watchdog — re-armed on each new part; paused during tool/permission. */
function armStallWatchdog(): void {
  if (!activeAttempt) return
  if (activeAttempt.stallTimer) clearTimeout(activeAttempt.stallTimer)
  if (activeAttempt.pausedForTool || activeAttempt.pausedForPermission) return
  const watched = activeAttempt
  watched.stallTimer = setTimeout(() => {
    void recoverHungAttempt(watched, 'stall')
  }, getStallMs())
}

function startActiveAttempt(sessionID: string, providerID: string, modelID: string): void {
  clearActiveAttempt()
  attemptCounter += 1
  activeAttempt = {
    attemptId: attemptCounter,
    sessionID,
    providerID,
    modelID,
    startedAt: Date.now(),
    ttftTimer: null,
    stallTimer: null,
    hasStreamed: false,
    toolExecuted: false,
    pausedForTool: false,
    pausedForPermission: false,
    failoverInFlight: false,
    userMessageID: lastPrompt?.userMessageID ?? null,
  }
  armTtftWatchdog()
}

/** Called on message.part.updated — clears TTFT and (re)arms stall. */
function touchActiveAttempt(sessionID: string): void {
  if (!activeAttempt || activeAttempt.sessionID !== sessionID) return
  if (activeAttempt.ttftTimer) {
    clearTimeout(activeAttempt.ttftTimer)
    activeAttempt.ttftTimer = null
  }
  activeAttempt.hasStreamed = true
  armStallWatchdog()
}

/** Called when a tool part enters running state — pauses stall. */
function markToolStarted(sessionID: string): void {
  if (!activeAttempt || activeAttempt.sessionID !== sessionID) return
  activeAttempt.toolExecuted = true
  activeAttempt.pausedForTool = true
  if (activeAttempt.stallTimer) {
    clearTimeout(activeAttempt.stallTimer)
    activeAttempt.stallTimer = null
  }
}

function markToolCompleted(sessionID: string): void {
  if (!activeAttempt || activeAttempt.sessionID !== sessionID) return
  activeAttempt.pausedForTool = false
  armStallWatchdog()
}

function markPermissionAsked(sessionID: string): void {
  if (!activeAttempt || activeAttempt.sessionID !== sessionID) return
  activeAttempt.pausedForPermission = true
  if (activeAttempt.stallTimer) {
    clearTimeout(activeAttempt.stallTimer)
    activeAttempt.stallTimer = null
  }
}

function markPermissionReplied(sessionID: string): void {
  if (!activeAttempt || activeAttempt.sessionID !== sessionID) return
  activeAttempt.pausedForPermission = false
  armStallWatchdog()
}

/**
 * Parse Retry-After / X-RateLimit-Reset from ApiError.responseHeaders.
 * Returns milliseconds until the endpoint suggests we retry, or undefined.
 */
function parseRetryAfterMs(headers: Record<string, string> | undefined | null): number | undefined {
  if (!headers) return undefined
  const normalized: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) normalized[k.toLowerCase()] = v

  const retryAfter = normalized['retry-after']
  if (retryAfter) {
    const asInt = parseInt(retryAfter, 10)
    if (Number.isFinite(asInt) && asInt >= 0) return asInt * 1000
    const asDate = Date.parse(retryAfter)
    if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now())
  }

  const rlReset = normalized['x-ratelimit-reset'] ?? normalized['x-ratelimit-reset-after']
  if (rlReset) {
    const asInt = parseInt(rlReset, 10)
    if (Number.isFinite(asInt)) {
      // Heuristic: > 10^10 → epoch seconds, > 10^12 → epoch ms, else duration
      if (asInt > 10_000_000_000) return Math.max(0, asInt - Date.now())
      if (asInt > 1_000_000_000) return Math.max(0, asInt * 1000 - Date.now())
      return asInt * 1000
    }
  }
  return undefined
}

/**
 * Single-entry failover. Reverts the user message, picks the next free model,
 * and re-prompts. Idempotent — a second call while a failover is in flight
 * returns immediately without duplicating work (R3).
 *
 * Returns true if a retry was dispatched, false if the caller should surface
 * the error normally (all fallbacks exhausted or unsafe to retry).
 */
async function beginFailover(
  sessionID: string,
  directory: string,
  text: string,
  parts: PromptPart[] | undefined,
  reason: string,
  failedModelKey?: string,
  failedProviderID?: string,
): Promise<boolean> {
  // Guard: single-entry
  if (activeAttempt?.failoverInFlight) return true
  if (activeAttempt) activeAttempt.failoverInFlight = true

  // Guard: per-exchange retry cap
  if (rotateRetries >= 3) {
    useStore.getState().addSystemNotice(
      `⚠️ **Retry cap reached (3/3).** Auto model rotation gave up after repeated errors. Send again or switch models manually. (${reason})`
    )
    return false
  }

  // Guard: last prompt must be for this session and have a user message id
  const prompt = lastPrompt
  if (!prompt || prompt.sessionID !== sessionID || !prompt.userMessageID) {
    return false
  }

  // R1 guard: only fail over when nothing has committed side effects
  if (activeAttempt && (activeAttempt.toolExecuted || activeAttempt.hasStreamed)) {
    useStore.getState().addSystemNotice(
      `⚠️ **Cannot auto-retry: side effects already committed** (tools run or tokens streamed). Send again to try a different model.`
    )
    return false
  }

  // Rotate to next free model BEFORE revert, so we know we have somewhere to go
  const rotated = useStore.getState().rotateToNextFreeModel(failedModelKey, failedProviderID)
  if (!rotated) return false

  // Transactional: revert on the server before re-prompting
  try {
    await api().revertMessage({ directory, sessionID, messageID: prompt.userMessageID })
  } catch (error) {
    useStore.getState().addSystemNotice(
      `⚠️ **Auto-retry aborted: could not revert to the last user message.** ${errText(error)}`
    )
    return false
  }

  rotateRetries += 1
  useStore.getState().addSystemNotice(
    `⚡ **Failover:** switched to **${rotated.providerName} · ${rotated.modelName}** and retrying (${rotateRetries}/3). Reason: ${reason}`
  )

  lastSendStartTime = Date.now()
  routingLedger = reserveAttempt(routingLedger, `${rotated.providerID}/${rotated.modelID}`, lastSendStartTime)
  saveLedger(routingLedger)
  startActiveAttempt(sessionID, rotated.providerID, rotated.modelID)
  useStore.setState({ busy: true, error: null })

  try {
    await api().prompt({
      directory,
      sessionID,
      providerID: rotated.providerID,
      modelID: rotated.modelID,
      text,
      parts,
    })
    return true
  } catch (error) {
    clearActiveAttempt(sessionID)
    routingLedger = recordFailure(routingLedger, `${rotated.providerID}/${rotated.modelID}`, Date.now())
    routingLedger = releaseAttempt(routingLedger, `${rotated.providerID}/${rotated.modelID}`)
    saveLedger(routingLedger)
    setAttemptFailure(errText(error))
    return true
  }
}

async function recoverHungAttempt(attempt: ActiveAttempt, kind: 'ttft' | 'stall'): Promise<void> {
  if (activeAttempt !== attempt) return
  const state = useStore.getState()
  if (!state.busy || state.activeSessionID !== attempt.sessionID) return
  if (state.routingMode === 'locked' || !state.directory) return

  const now = Date.now()
  const failedKey = `${attempt.providerID}/${attempt.modelID}`
  routingLedger = recordTimeout(routingLedger, failedKey, now)
  saveLedger(routingLedger)

  // R1: if any tool ran or tokens streamed, do NOT auto-retry
  if (attempt.toolExecuted || attempt.hasStreamed) {
    clearActiveAttempt(attempt.sessionID)
    setAttemptFailure(
      kind === 'ttft'
        ? 'Model stopped responding before first token.'
        : 'Model went quiet mid-response. Send again to continue.'
    )
    return
  }

  abortForRecoverySessionID = attempt.sessionID
  try {
    await api().abort(state.directory, attempt.sessionID)
  } catch (error) {
    abortForRecoverySessionID = null
    clearActiveAttempt(attempt.sessionID)
    setAttemptFailure(`Timed-out request could not be safely aborted: ${errText(error)}`)
    return
  }
  clearActiveAttempt(attempt.sessionID)

  const prompt = lastPrompt
  const directory = state.directory
  if (!prompt || !directory) {
    setAttemptFailure('Model request timed out before it could be retried.')
    return
  }

  const reason = kind === 'ttft'
    ? `No response after ${Math.round(getTtftMs() / 1000)}s`
    : `No progress after ${Math.round(getStallMs() / 1000)}s`

  const failedOver = await beginFailover(
    attempt.sessionID,
    directory,
    prompt.text,
    prompt.parts,
    reason,
    failedKey,
  )
  if (!failedOver) {
    setAttemptFailure(`${reason}. No other free model available.`)
  }
}

function setAttemptFailure(error: string): void {
  clearActiveAttempt()
  lastSendStartTime = null
  useStore.setState({ busy: false, error })
}

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
        useStore.setState({ providers: [], defaultModels: {}, linkedProviderIDs: [] })
      }
      // Server just came up (or came back) — refetch providers.
      if (status.running && !prev.running) {
        void (async () => {
          try {
            const result = await bridge.providers()
            useStore.setState({
              providers: result?.providers ?? [],
              defaultModels: result?.default ?? {},
              linkedProviderIDs: result?.linkedProviderIDs ?? []
            })
            const { providerID, modelID, providers, linkedProviderIDs } = useStore.getState()
            const linkedProviders = providers.filter((provider) => linkedProviderIDs.includes(provider.id))
            const showPaid = useStore.getState().showPaidModels
            if (linkedProviders.length > 0 && !restoredSelectionValid(linkedProviders, providerID, modelID, showPaid)) {
              const picked = pickDefaultModel(linkedProviders)
              const nextProvider = picked ? picked.providerID : null
              const nextModel = picked ? picked.modelID : null
              useStore.setState({ providerID: nextProvider, modelID: nextModel })
              savePrefs({
                directory: useStore.getState().directory,
                providerID: nextProvider,
                modelID: nextModel,
                autoRotate: useStore.getState().autoRotate,
                theme: useStore.getState().theme,
                modelPool: useStore.getState().modelPool,
                stickyModel: useStore.getState().stickyModel,
                routingMode: useStore.getState().routingMode,
                showPaidModels: useStore.getState().showPaidModels,
              })
            }
          } catch (e) {
            useStore.setState({ error: errText(e) })
          }
        })()
      }
    })
    bridge.onUpdateStatus((status) => {
      useStore.getState().setUpdateStatus(status)
    })
  } catch (e) {
    subscribed = false
    useStore.setState({ error: errText(e) })
  }
}
