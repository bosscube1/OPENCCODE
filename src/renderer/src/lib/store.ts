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
import { loadPrefs, savePrefs, type Theme } from './prefs'
import { pickDefaultModel, restoredSelectionValid, isRateLimitError } from './rotation'
import { loadLedger, saveLedger, record429, recordSuccess, recordFailure, recordTimeout, reserveAttempt, selectModel, DEFAULT_PROVIDER_CAPS, parseModelKey, type Ledger } from './routing'
import { sortMessages, upsertMessage, removeMessage, upsertPart, removePart, sortSessions, upsertSession, samePath, compareIds, makeNotice } from './collections'
import { getMatchingCommands } from './commands'
import type { AppSettings, AppSettingsResult, Message, MessageWithParts, OcEvent, Part, Permission, PermissionResponse, Provider, ServerStatus, Session, Todo, ServerCommand, ProjectRecord, PromptPart, UpdateStatus } from './types'

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
  messages(directory: string, sessionID: string): Promise<MessageWithParts[]>
  revertMessage(a: { directory: string; sessionID: string; messageID: string }): Promise<void>
  prompt(a: {
    directory: string
    sessionID: string
    providerID: string
    modelID: string
    text: string
    parts?: PromptPart[]
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

let lastPrompt: { text: string; parts?: PromptPart[]; sessionID: string } | null = null
let rotateRetries = 0
let routingLedger: Ledger = {}
let lastSendStartTime: number | null = null
const HANG_TIMEOUT_MS = 90_000
type ActiveAttempt = {
  sessionID: string
  providerID: string
  modelID: string
  startedAt: number
  timer: ReturnType<typeof setTimeout> | null
}
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
  autoRotate: boolean
  modelPool: string[] | null
  stickyModel: boolean
  // permissions awaiting user answer, oldest first
  permissions: Permission[]
  // last error banner text, null when clear
  error: string | null

  todos: Todo[]
  branch: string | null
  queuedPrompts: Array<{ text: string, parts?: PromptPart[] }>
  serverCommands: ServerCommand[]
  projects: ProjectRecord[]
  activeView: 'chats' | 'projects'
  appSettings: AppSettings
  shortcutRegistered: boolean
  shortcutError: string | null
  updateStatus: UpdateStatus
  theme: Theme
  activeArtifactID: string | null

  // actions
  init(): Promise<void>
  pickDirectory(): Promise<void>
  setDirectory(dir: string): Promise<void>
  loadProjects(): Promise<void>
  createProject(name: string): Promise<ProjectRecord>
  openProject(project: ProjectRecord): Promise<void>
  setActiveView(view: 'chats' | 'projects'): void
  loadAppSettings(): Promise<void>
  updateAppSettings(patch: Partial<AppSettings>): Promise<void>
  setUpdateStatus(status: UpdateStatus): void
  newSession(): Promise<void>
  selectSession(id: string): Promise<void>
  deleteSession(id: string): Promise<void>
  send(text: string, parts?: PromptPart[]): Promise<void>
  abort(): Promise<void>
  setModel(providerID: string, modelID: string): void
  toggleAutoRotate(): void
  toggleStickyModel(): void
  setModelPool(pool: string[] | null): void
  rotateToNextFreeModel(): { providerID: string; modelID: string; providerName: string; modelName: string } | null
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
  autoRotate: true,
  modelPool: null,
  stickyModel: false,
  permissions: [],
  error: null,
  todos: [],
  branch: null,
  queuedPrompts: [],
  serverCommands: [],
  projects: [],
  activeView: 'chats',
  appSettings: { closeToTray: true, globalShortcut: 'Ctrl+Alt+Space' },
  shortcutRegistered: false,
  shortcutError: null,
  updateStatus: { state: 'idle' },
  theme: 'auto' as Theme,
  activeArtifactID: null,

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
    if (linkedProviders.length > 0 && !restoredSelectionValid(linkedProviders, providerID, modelID)) {
      const picked = pickDefaultModel(linkedProviders)
      providerID = picked ? picked.providerID : null
      modelID = picked ? picked.modelID : null
    }

    set({ providerID, modelID, autoRotate: prefs.autoRotate, theme: prefs.theme, modelPool: prefs.modelPool, stickyModel: prefs.stickyModel })
    savePrefs({ directory: prefs.directory, providerID, modelID, autoRotate: prefs.autoRotate, theme: prefs.theme, modelPool: prefs.modelPool, stickyModel: prefs.stickyModel })

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

  setActiveView(view: 'chats' | 'projects'): void {
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
    const { directory, providerID, modelID, autoRotate, theme, modelPool } = get()
    savePrefs({ directory, providerID, modelID, autoRotate, theme, modelPool, stickyModel: next })
  },

  setModelPool(pool: string[] | null): void {
    set({ modelPool: pool })
    const { directory, providerID, modelID, autoRotate, theme, stickyModel } = get()
    savePrefs({ directory, providerID, modelID, autoRotate, theme, modelPool: pool, stickyModel })
  },

  rotateToNextFreeModel(): { providerID: string; modelID: string; providerName: string; modelName: string } | null {
    const { providers, linkedProviderIDs, providerID: currentP, modelID: currentM, modelPool, stickyModel, autoRotate, theme, directory } = get()
    if (providers.length === 0) return null

    const available = new Set<string>()
    for (const p of providers) {
      if (!linkedProviderIDs.includes(p.id)) continue
      for (const m of Object.values(p.models ?? {})) {
        if (isAgentModel(m)) available.add(`${p.id}/${m.id}`)
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
        set({ providerID: nextP, modelID: nextM })
        savePrefs({ directory, providerID: nextP, modelID: nextM, autoRotate, theme, modelPool, stickyModel })
        return {
          providerID: nextP,
          modelID: nextM,
          providerName: provider.name,
          modelName: model.name ?? nextM
        }
      }
    }

    // No generic fallback: it could select a provider without a linked key,
    // a model outside the configured pool, or one still in cooldown.
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
| \`/cost\` | Display session message statistics and provider metrics |`
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

    const { directory, autoRotate, modelPool, stickyModel, providers, linkedProviderIDs } = get()
    let { providerID, modelID } = get()

    if (!directory) {
      set({ error: 'Pick a project folder first.' })
      return
    }

    if (autoRotate && providers.length > 0) {
      const available = new Set<string>()
      for (const p of providers) {
        if (!linkedProviderIDs.includes(p.id)) continue
        for (const m of Object.values(p.models ?? {})) {
          if (isAgentModel(m)) available.add(`${p.id}/${m.id}`)
        }
      }

      const currentKey = providerID && modelID ? `${providerID}/${modelID}` : null
      const chosenKey = selectModel(modelPool, routingLedger, DEFAULT_PROVIDER_CAPS, Date.now(), {
        sticky: stickyModel,
        current: currentKey,
        available,
        authenticatedProviders: new Set(linkedProviderIDs)
      })

      if (chosenKey && chosenKey !== currentKey) {
        const parsed = parseModelKey(chosenKey)
        if (!parsed) {
          set({ error: 'The selected model route is malformed.' })
          return
        }
        const { providerID: nextP, modelID: nextM } = parsed
        providerID = nextP
        modelID = nextM
        set({ providerID: nextP, modelID: nextM })
        savePrefs({ directory, providerID: nextP, modelID: nextM, autoRotate, theme: get().theme, modelPool, stickyModel })

        const pName = providers.find((p) => p.id === nextP)?.name ?? nextP
        const mName = providers.find((p) => p.id === nextP)?.models?.[nextM]?.name ?? nextM
        get().addSystemNotice(`⚡ **Proactive routing selected optimal healthy model:** **${pName} · ${mName}**`)
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

    lastPrompt = { text: trimmed, parts, sessionID }
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
      if (providerID && modelID) {
        if (isRateLimitError(errString)) {
          routingLedger = record429(routingLedger, `${providerID}/${modelID}`, now)
          saveLedger(routingLedger)
        } else {
          routingLedger = recordFailure(routingLedger, `${providerID}/${modelID}`, now)
          saveLedger(routingLedger)
        }
      }
      if (get().autoRotate && isRateLimitError(errString)) {
        const rotated = get().rotateToNextFreeModel()
        if (rotated) {
          get().addSystemNotice(
            `⚡ **Rate limit (429) encountered on \`${providerID}/${modelID}\`.** Automatically rotated to **${rotated.providerName} · ${rotated.modelName}** and retrying...`
          )
          try {
            lastSendStartTime = Date.now()
            routingLedger = reserveAttempt(routingLedger, `${rotated.providerID}/${rotated.modelID}`, lastSendStartTime)
            saveLedger(routingLedger)
            startActiveAttempt(sessionID, rotated.providerID, rotated.modelID)
            await api().prompt({
              directory,
              sessionID,
              providerID: rotated.providerID,
              modelID: rotated.modelID,
              text: trimmed,
              parts
            })
            return
          } catch (retryErr) {
            clearActiveAttempt(sessionID)
            routingLedger = recordFailure(routingLedger, `${rotated.providerID}/${rotated.modelID}`, Date.now())
            saveLedger(routingLedger)
            set({ busy: false, error: errText(retryErr) })
            return
          }
        }
      }
      set({ busy: false, error: errString })
    }
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
    set({ providerID, modelID })
    const { directory, autoRotate, theme, modelPool, stickyModel } = get()
    savePrefs({ directory, providerID, modelID, autoRotate, theme, modelPool, stickyModel })
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
        touchActiveAttempt(part.sessionID)
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
        rotateRetries = 0

        const now = Date.now()
        const attempt = activeAttempt
        if (attempt?.sessionID === sessionID) {
          const latencyMs = Math.max(50, now - attempt.startedAt)
          clearActiveAttempt(sessionID)
          lastSendStartTime = null
          routingLedger = recordSuccess(routingLedger, `${attempt.providerID}/${attempt.modelID}`, latencyMs, now)
          saveLedger(routingLedger)
        }
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
        const error = props.error as
          | { name?: string; data?: { message?: string } }
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
        const attempt = activeAttempt?.sessionID === sessionID ? activeAttempt : null
        clearActiveAttempt(sessionID)
        lastSendStartTime = null
        if (attempt) {
          if (isRateLimitError(message)) {
            routingLedger = record429(routingLedger, `${attempt.providerID}/${attempt.modelID}`, now)
            saveLedger(routingLedger)
          } else {
            routingLedger = recordFailure(routingLedger, `${attempt.providerID}/${attempt.modelID}`, now)
            saveLedger(routingLedger)
          }
        }

        // Capture into a `const` (rather than reading the module-scoped `let lastPrompt`
        // repeatedly) so TypeScript can narrow it past the `rotateToNextFreeModel()` call below.
        const capturedPrompt = lastPrompt?.sessionID === sessionID ? lastPrompt : null

        if (
          state.autoRotate &&
          isRateLimitError(message) &&
          capturedPrompt &&
          capturedPrompt.sessionID === state.activeSessionID
        ) {
          if (rotateRetries < 3) {
            rotateRetries += 1
            const rotated = state.rotateToNextFreeModel()
            if (rotated && state.directory) {
              state.addSystemNotice(
                `⚡ **Rate limit (429) reported by session.** Automatically rotated to **${rotated.providerName} · ${rotated.modelName}** and retrying (${rotateRetries}/3)...`
              )
              const dir = state.directory
              const promptData = capturedPrompt
              const sessID = promptData.sessionID
              // Re-capture on this retry itself so a further session.error for the
              // same exchange keeps retrying against the same original prompt.
              lastPrompt = { text: promptData.text, parts: promptData.parts, sessionID: sessID }
              void (async () => {
                try {
                  const retryStarted = Date.now()
                  routingLedger = reserveAttempt(routingLedger, `${rotated.providerID}/${rotated.modelID}`, retryStarted)
                  saveLedger(routingLedger)
                  lastSendStartTime = retryStarted
                  startActiveAttempt(sessID, rotated.providerID, rotated.modelID)
                  set({ busy: true, error: null })
                  await api().prompt({
                    directory: dir,
                    sessionID: sessID,
                    providerID: rotated.providerID,
                    modelID: rotated.modelID,
                    text: promptData.text,
                    parts: promptData.parts
                  })
                } catch (e) {
                  clearActiveAttempt(sessID)
                  routingLedger = recordFailure(routingLedger, `${rotated.providerID}/${rotated.modelID}`, Date.now())
                  saveLedger(routingLedger)
                  set({ busy: false, error: errText(e) })
                }
              })()
              return
            }
          } else {
            state.addSystemNotice(
              `⚠️ **Retry cap reached (3/3).** Automatic model rotation gave up after repeated rate-limit errors on \`${state.providerID ?? 'unknown'}/${state.modelID ?? 'unknown'}\`. Send the message again or switch models manually.`
            )
          }
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

function clearActiveAttempt(sessionID?: string): void {
  if (!activeAttempt || (sessionID && activeAttempt.sessionID !== sessionID)) return
  if (activeAttempt.timer) clearTimeout(activeAttempt.timer)
  activeAttempt = null
}

function armHangWatchdog(): void {
  if (!activeAttempt) return
  if (activeAttempt.timer) clearTimeout(activeAttempt.timer)
  const watched = activeAttempt
  watched.timer = setTimeout(() => {
    void recoverHungAttempt(watched)
  }, HANG_TIMEOUT_MS)
}

function startActiveAttempt(sessionID: string, providerID: string, modelID: string): void {
  clearActiveAttempt()
  activeAttempt = { sessionID, providerID, modelID, startedAt: Date.now(), timer: null }
  armHangWatchdog()
}

function touchActiveAttempt(sessionID: string): void {
  if (activeAttempt?.sessionID === sessionID) armHangWatchdog()
}

async function recoverHungAttempt(attempt: ActiveAttempt): Promise<void> {
  if (activeAttempt !== attempt) return
  const state = useStore.getState()
  if (!state.busy || state.activeSessionID !== attempt.sessionID || !state.autoRotate || !state.directory) return

  const now = Date.now()
  const failedKey = `${attempt.providerID}/${attempt.modelID}`
  routingLedger = recordTimeout(routingLedger, failedKey, now)
  saveLedger(routingLedger)

  if (!lastPrompt || lastPrompt.sessionID !== attempt.sessionID || rotateRetries >= 3) {
    clearActiveAttempt(attempt.sessionID)
    setAttemptFailure('Model request timed out and no eligible retry remains.')
    return
  }

  abortForRecoverySessionID = attempt.sessionID
  try {
    await api().abort(state.directory, attempt.sessionID)
  } catch (error) {
    abortForRecoverySessionID = null
    clearActiveAttempt(attempt.sessionID)
    // Retrying while the original request might still be running can duplicate
    // tool calls or code changes.  Leave recovery to the user in this case.
    setAttemptFailure(`Timed-out request could not be safely aborted: ${errText(error)}`)
    return
  }
  clearActiveAttempt(attempt.sessionID)

  const rotated = useStore.getState().rotateToNextFreeModel()
  if (!rotated) {
    setAttemptFailure('Model request timed out; no other linked, healthy model is available.')
    return
  }

  rotateRetries += 1
  const prompt = lastPrompt
  const directory = useStore.getState().directory
  if (!prompt || !directory) {
    setAttemptFailure('Model request timed out before it could be retried.')
    return
  }

  useStore.getState().addSystemNotice(
    `⚡ **No response after ${Math.round(HANG_TIMEOUT_MS / 1000)} seconds.** Switched to **${rotated.providerName} · ${rotated.modelName}** and retrying (${rotateRetries}/3)…`
  )
  lastSendStartTime = Date.now()
  routingLedger = reserveAttempt(routingLedger, `${rotated.providerID}/${rotated.modelID}`, lastSendStartTime)
  saveLedger(routingLedger)
  startActiveAttempt(prompt.sessionID, rotated.providerID, rotated.modelID)
  useStore.setState({ busy: true, error: null })
  try {
    await api().prompt({
      directory,
      sessionID: prompt.sessionID,
      providerID: rotated.providerID,
      modelID: rotated.modelID,
      text: prompt.text,
      parts: prompt.parts
    })
  } catch (error) {
    clearActiveAttempt(prompt.sessionID)
    routingLedger = recordFailure(routingLedger, `${rotated.providerID}/${rotated.modelID}`, Date.now())
    saveLedger(routingLedger)
    setAttemptFailure(errText(error))
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
            if (linkedProviders.length > 0 && !restoredSelectionValid(linkedProviders, providerID, modelID)) {
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
                stickyModel: useStore.getState().stickyModel
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
