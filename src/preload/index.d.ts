/**
 * Typing for the preload bridge. Kept structurally identical to CONTRACTS.md and to
 * `src/renderer/src/lib/types.ts` (which owns the renderer-side copies of these shapes).
 */
import type { Message, Part, Permission, Provider, Session } from '@opencode-ai/sdk'

export type ServerStatus = {
  running: boolean
  url: string | null
  error?: string
}

export type MessageWithParts = {
  info: Message
  parts: Part[]
}

export type PermissionResponse = 'once' | 'always' | 'reject'

export type OcEvent = {
  type: string
  properties: unknown
}

export type ProvidersResult = {
  providers: Provider[]
  default: Record<string, string>
  linkedProviderIDs: string[]
}

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

/** One masked BYOK key row from `oc:keys:list`. Never carries the full key. */
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
  /** Registers an SSE listener; call the returned function to unsubscribe. */
  onEvent(cb: (e: OcEvent) => void): () => void
  /** Registers a server-status listener; call the returned function to unsubscribe. */
  onServer(cb: (s: ServerStatus) => void): () => void
  /** Registers a main-menu new-session listener; call the returned function to unsubscribe. */
  onMainMenuNewSession(cb: () => void): () => void
  /** Registers a quick-entry prompt listener; call the returned function to unsubscribe. */
  onQuickEntryPrompt(cb: (text: string) => void): () => void
  /** Registers an updater-status listener; call the returned function to unsubscribe. */
  onUpdateStatus(cb: (status: UpdateStatus) => void): () => void
}

export type { Message, Part, Permission, Provider, Session }

declare global {
  interface Window {
    api: OpencodeApi
  }
}
