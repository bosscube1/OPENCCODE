/**
 * The only bridge between renderer and main. `ipcRenderer` itself is never exposed.
 * Shape is fixed by CONTRACTS.md (`window.api`).
 */
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { Message, Part, Permission, Provider, Session } from '@opencode-ai/sdk'

export type ServerStatus = { running: boolean; url: string | null; error?: string }
export type MessageWithParts = { info: Message; parts: Part[] }
export type PermissionResponse = 'once' | 'always' | 'reject'
export type OcEvent = { type: string; properties: unknown }
export type ProvidersResult = { providers: Provider[]; default: Record<string, string>; linkedProviderIDs: string[] }

export type PromptPart =
  | { type: 'text'; text: string }
  | { type: 'file'; mime: string; filename: string; url: string }

export type PromptArgs = {
  directory: string
  sessionID: string
  providerID: string
  modelID: string
  text: string
  parts?: PromptPart[]
}

export type PermissionReplyArgs = {
  directory: string
  sessionID: string
  permissionID: string
  response: PermissionResponse
}

export type SummarizeArgs = {
  directory: string
  sessionID: string
  providerID: string
  modelID: string
}

export type InitArgs = {
  directory: string
  sessionID: string
  providerID: string
  modelID: string
  messageID: string
}

export type CommandArgs = {
  directory: string
  sessionID: string
  command: string
  arguments: string
}

export type RevertArgs = {
  directory: string
  sessionID: string
  messageID: string
}

/** One result row from `oc:search:chats`. Importable by renderer streams. */
export type ChatSearchHit = {
  sessionID: string
  title: string
  messageID: string
  snippet: string
  time: number
}

/** One masked BYOK key row from `oc:keys:list`. Never carries the full key. Importable by renderer. */
export type KeyRow = {
  providerID: string
  envVar: string
  maskedTail: string | null
}

export type ProjectRecord = {
  id: string
  name: string
  directory: string
  createdAt: number
  updatedAt: number
}

export type KnowledgeFile = { filename: string; size: number; updatedAt: number }

export type McpLocalConfig = {
  type: 'local'
  command: string[]
  environment?: Record<string, string>
  enabled?: boolean
  timeout?: number
}
export type McpRemoteConfig = {
  type: 'remote'
  url: string
  enabled?: boolean
  headers?: Record<string, string>
  oauth?: { clientId?: string; clientSecret?: string; scope?: string } | false
  timeout?: number
}
export type McpConfig = McpLocalConfig | McpRemoteConfig
export type McpStatus =
  | { status: 'connected' | 'disabled' | 'needs_auth' }
  | { status: 'failed' | 'needs_client_registration'; error: string }
export type McpSnapshot = {
  configs: Record<string, McpConfig>
  statuses: Record<string, McpStatus>
}

export type AppSettings = {
  closeToTray: boolean
  globalShortcut: string
}
export type AppSettingsResult = {
  settings: AppSettings
  shortcutRegistered: boolean
  shortcutError?: string
}
export type UpdateStatus =
  | { state: 'idle' | 'checking' | 'not-available' | 'downloaded' }
  | { state: 'available'; version: string }
  | { state: 'progress'; percent: number }
  | { state: 'error'; message: string }

export interface OpencodeApi {
  status(): Promise<ServerStatus>
  restart(): Promise<ServerStatus>
  pickDirectory(): Promise<string | null>
  sessions: {
    list(directory: string): Promise<Session[]>
    create(directory: string, title?: string): Promise<Session>
    remove(directory: string, id: string): Promise<void>
    update(directory: string, id: string, title: string): Promise<Session>
    summarize(a: SummarizeArgs): Promise<boolean>
    init(a: InitArgs): Promise<boolean>
    todos(directory: string, sessionID: string): Promise<unknown[]>
    command(a: CommandArgs): Promise<void>
  }
  commands: {
    list(directory: string): Promise<unknown[]>
  }
  find: {
    files(directory: string, query: string): Promise<string[]>
  }
  vcs: {
    get(directory: string): Promise<{ branch: string } | null>
  }
  projects: {
    list(): Promise<ProjectRecord[]>
    create(name: string): Promise<ProjectRecord>
    getInstructions(directory: string): Promise<string>
    setInstructions(directory: string, text: string): Promise<void>
    listKnowledge(directory: string): Promise<KnowledgeFile[]>
    addKnowledge(directory: string, filePaths?: string[]): Promise<KnowledgeFile[]>
    removeKnowledge(directory: string, filename: string): Promise<void>
  }
  mcp: {
    status(directory: string): Promise<McpSnapshot>
    add(a: { directory: string; name: string; config: McpConfig }): Promise<McpSnapshot>
    remove(directory: string, name: string): Promise<McpSnapshot>
    connect(directory: string, name: string): Promise<McpSnapshot>
    disconnect(directory: string, name: string): Promise<McpSnapshot>
    auth(directory: string, name: string): Promise<McpSnapshot>
  }
  quick: {
    submit(text: string): Promise<void>
  }
  appSettings: {
    get(): Promise<AppSettingsResult>
    set(patch: Partial<AppSettings>): Promise<AppSettingsResult>
  }
  keys: {
    list(): Promise<KeyRow[]>
    set(a: { providerID: string; key: string }): Promise<void>
    remove(providerID: string): Promise<void>
    test(providerID: string): Promise<{ ok: boolean; status?: number; detail?: string }>
  }
  messages(directory: string, sessionID: string): Promise<MessageWithParts[]>
  revertMessage(a: RevertArgs): Promise<void>
  searchChats(directory: string, query: string): Promise<ChatSearchHit[]>
  prompt(a: PromptArgs): Promise<void>
  abort(directory: string, sessionID: string): Promise<void>
  providers(): Promise<ProvidersResult>
  replyPermission(a: PermissionReplyArgs): Promise<void>
  openExternal(url: string): Promise<void>
  pathForFile(file: File): string
  exportChat(defaultName: string, content: string): Promise<boolean>
  saveFile(a: { defaultName: string; content: string }): Promise<boolean>
  onEvent(cb: (e: OcEvent) => void): () => void
  onServer(cb: (s: ServerStatus) => void): () => void
  onMainMenuNewSession(cb: () => void): () => void
  onQuickEntryPrompt(cb: (text: string) => void): () => void
  onUpdateStatus(cb: (status: UpdateStatus) => void): () => void
}

/** `Permission` is part of the contract surface (events carry it) — re-exported for the renderer. */
export type { Permission }

function subscribe<T>(
  channel: 'oc:event' | 'oc:server' | 'quick-entry:prompt' | 'update:status',
  callback: (payload: T) => void
): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => {
    callback(payload)
  }
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: OpencodeApi = {
  status: () => ipcRenderer.invoke('oc:status'),
  restart: () => ipcRenderer.invoke('oc:restart'),
  pickDirectory: () => ipcRenderer.invoke('oc:pickDirectory'),
  sessions: {
    list: (directory) => ipcRenderer.invoke('oc:sessions:list', directory),
    create: (directory, title) => ipcRenderer.invoke('oc:sessions:create', directory, title),
    remove: (directory, id) => ipcRenderer.invoke('oc:sessions:delete', directory, id),
    update: (directory, id, title) => ipcRenderer.invoke('oc:sessions:update', directory, id, title),
    summarize: (a) => ipcRenderer.invoke('oc:sessions:summarize', a),
    init: (a) => ipcRenderer.invoke('oc:sessions:init', a),
    todos: (directory, sessionID) => ipcRenderer.invoke('oc:sessions:todos', directory, sessionID),
    command: (a) => ipcRenderer.invoke('oc:sessions:command', a)
  },
  commands: {
    list: (directory) => ipcRenderer.invoke('oc:commands:list', directory)
  },
  find: {
    files: (directory, query) => ipcRenderer.invoke('oc:find:files', directory, query)
  },
  vcs: {
    get: (directory) => ipcRenderer.invoke('oc:vcs:get', directory)
  },
  projects: {
    list: () => ipcRenderer.invoke('oc:projects:list'),
    create: (name) => ipcRenderer.invoke('oc:projects:create', { name }),
    getInstructions: (directory) => ipcRenderer.invoke('oc:projects:instructions:get', directory),
    setInstructions: (directory, text) => ipcRenderer.invoke('oc:projects:instructions:set', { directory, text }),
    listKnowledge: (directory) => ipcRenderer.invoke('oc:projects:knowledge:list', directory),
    addKnowledge: (directory, filePaths = []) => ipcRenderer.invoke('oc:projects:knowledge:add', { directory, filePaths }),
    removeKnowledge: (directory, filename) => ipcRenderer.invoke('oc:projects:knowledge:remove', { directory, filename })
  },
  mcp: {
    status: (directory) => ipcRenderer.invoke('oc:mcp:status', directory),
    add: (a) => ipcRenderer.invoke('oc:mcp:add', a),
    remove: (directory, name) => ipcRenderer.invoke('oc:mcp:remove', { directory, name }),
    connect: (directory, name) => ipcRenderer.invoke('oc:mcp:connect', { directory, name }),
    disconnect: (directory, name) => ipcRenderer.invoke('oc:mcp:disconnect', { directory, name }),
    auth: (directory, name) => ipcRenderer.invoke('oc:mcp:auth', { directory, name })
  },
  quick: {
    submit: (text) => ipcRenderer.invoke('oc:quick:submit', text)
  },
  appSettings: {
    get: () => ipcRenderer.invoke('oc:appSettings:get'),
    set: (patch) => ipcRenderer.invoke('oc:appSettings:set', patch)
  },
  keys: {
    list: () => ipcRenderer.invoke('oc:keys:list'),
    set: (a) => ipcRenderer.invoke('oc:keys:set', a),
    remove: (providerID) => ipcRenderer.invoke('oc:keys:delete', providerID),
    test: (providerID) => ipcRenderer.invoke('oc:keys:test', providerID)
  },
  messages: (directory, sessionID) => ipcRenderer.invoke('oc:messages:list', directory, sessionID),
  revertMessage: (a) => ipcRenderer.invoke('oc:messages:revert', a),
  searchChats: (directory, query) => ipcRenderer.invoke('oc:search:chats', directory, query),
  prompt: (a) => ipcRenderer.invoke('oc:prompt', a),
  abort: (directory, sessionID) => ipcRenderer.invoke('oc:abort', directory, sessionID),
  providers: () => ipcRenderer.invoke('oc:providers'),
  replyPermission: (a) => ipcRenderer.invoke('oc:permission:reply', a),
  openExternal: (url) => ipcRenderer.invoke('oc:openExternal', url),
  pathForFile: (file) => webUtils.getPathForFile(file),
  exportChat: (defaultName, content) => ipcRenderer.invoke('oc:exportChat', defaultName, content),
  saveFile: (a) => ipcRenderer.invoke('oc:saveFile', a),
  onEvent: (cb) => subscribe<OcEvent>('oc:event', cb),
  onServer: (cb) => subscribe<ServerStatus>('oc:server', cb),
  onMainMenuNewSession: (cb) => {
    const listener = (): void => cb()
    ipcRenderer.on('main-menu:new-session', listener)
    return () => ipcRenderer.removeListener('main-menu:new-session', listener)
  },
  onQuickEntryPrompt: (cb) => subscribe<string>('quick-entry:prompt', cb),
  onUpdateStatus: (cb) => subscribe<UpdateStatus>('update:status', cb)
}

try {
  contextBridge.exposeInMainWorld('api', api)
} catch {
  // contextIsolation disabled (should not happen with our webPreferences) — fall back to a global.
  ;(globalThis as unknown as { api: OpencodeApi }).api = api
}
