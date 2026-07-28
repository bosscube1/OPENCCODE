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
  /**
   * Per-request tool policy. Compare runs pass `{ write: false, edit: false, … }` so N concurrent
   * columns cannot race on one working tree. Omit for normal chat.
   */
  tools?: Record<string, boolean>
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
  showPaidModels: boolean
  ttftMs: number
  stallMs: number
  /** Refuse NanoGPT image generation on models observed to bill balance. Default true. */
  nanogptSubscriptionOnly: boolean
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
export type GeminiLiveInput = {
  audio?: { data: string; mimeType: 'audio/pcm;rate=16000' }
  video?: { data: string; mimeType: 'image/jpeg' }
  text?: string
}
export type GeminiLiveEvent =
  | { type: 'message'; data: unknown }
  | { type: 'error'; message: string }
  | { type: 'closed'; code: number; reason: string }

/* --- NanoGPT (subscription provider + image sidecar) ---------------------- */

export type NanoChatModel = {
  id: string
  name?: string
  description?: string
  context_length?: number
  max_output_tokens?: number
  capabilities?: { vision?: boolean; tool_calling?: boolean }
}
export type NanoImageModel = {
  id: string
  name?: string
  description?: string
  pricing?: unknown
  supported_parameters?: string[]
  tags?: string[]
}
export type NanogptModelsResult = {
  chat: NanoChatModel[]
  image: NanoImageModel[]
  /** Image model ids observed to bill balance rather than the subscription. */
  balanceBilled: string[]
  fetchedAt: number
}
export type NanogptRefreshResult = {
  chatCount: number
  imageCount: number
  /** True when the chat model set changed — the OpenCode server must restart to see it. */
  restartRequired: boolean
  fetchedAt: number
}
export type NanoUsage = {
  active: boolean
  limits: { daily: number; monthly: number }
  enforceDailyLimit?: boolean
  daily: { used: number; remaining: number; percentUsed: number; resetAt: number }
  monthly: { used: number; remaining: number; percentUsed: number; resetAt: number }
  state: string
  graceUntil?: string | null
}
export type GeneratedImageMeta = {
  id: string
  sessionID: string | null
  prompt: string
  model: string
  size?: string
  paymentSource?: string
  cost?: number
  createdAt: number
  bytes: number
}
export type NanogptGenerateArgs = {
  prompt: string
  model: string
  n?: number
  size?: string
  /** Attach the generation to a chat session so the transcript can be rehydrated. */
  sessionID?: string
  /** Explicit per-call consent to bill the pay-as-you-go balance. Never defaults to true. */
  allowBalance?: boolean
}
export type NanogptGenerateResult = {
  images: Array<{ meta: GeneratedImageMeta; base64: string }>
  billing: 'subscription' | 'balance' | 'unknown'
  paymentSource?: string
  cost?: number
  remainingBalance?: number
  route: 'subscription' | 'standard'
  /** True when this call caused the model to be recorded as balance-billing. */
  blacklisted: boolean
}

/* --- Phase 1 code surface (fs / git / terminal / editor deep-links) -------
 * Deliberately duplicated rather than imported from src/main/fsService.ts / gitService.ts
 * (main must not be imported by preload — see CONTRACTS.md "Phase 1 — Code surface"). Kept
 * structurally identical to the main-process service definitions. */

export type GitFileStatus =
  | 'untracked'
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'conflicted'
  | 'ignored'

export type FileNode = {
  name: string
  /** POSIX-separated, ALWAYS relative to the session directory. */
  path: string
  kind: 'file' | 'dir'
  gitStatus: GitFileStatus | null
  /** Edited by the agent during this session. */
  touched: boolean
}

export type FileContent = {
  path: string
  text: string
  bytes: number
  /** True when the file exceeded MAX_READ_BYTES. */
  truncated: boolean
  /** sha256 of the on-disk bytes; the optimistic-concurrency token. */
  sha: string
  /** Monaco language id, inferred from extension. */
  language: string | null
}

export type DiffLine = { kind: 'ctx' | 'add' | 'del'; text: string }

export type Hunk = {
  /** Stable within one FileDiff: `${oldStart}-${newStart}`. */
  id: string
  /** "@@ -a,b +c,d @@" */
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
  /**
   * Set when that side ends without a trailing newline ("\ No newline at end of
   * file"). Load-bearing: without it, applying a file's final hunk silently adds a
   * newline that was never in the source.
   */
  oldNoEofNewline?: boolean
  newNoEofNewline?: boolean
}

export type FileDiff = {
  path: string
  /** Set on renames. */
  oldPath?: string
  /** When true, `hunks` is empty. */
  binary: boolean
  /**
   * True when the diff exceeded the 5000-line cap and hunks were dropped.
   * The UI MUST surface this — a partial diff that looks complete lets the
   * user stage "all hunks" and silently lose everything past the cap.
   */
  truncated: boolean
  hunks: Hunk[]
}

export type GitStatusEntry = {
  path: string
  /** Staged side. */
  index: GitFileStatus | null
  /** Unstaged side. */
  worktree: GitFileStatus | null
  renamedFrom?: string
}

export type GitStatus = {
  branch: string
  upstream: string | null
  ahead: number
  behind: number
  entries: GitStatusEntry[]
  clean: boolean
}

export type GitBranch = { name: string; current: boolean; remote: boolean }

export type TermId = string

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
  live: {
    start(): Promise<void>
    send(input: GeminiLiveInput): void
    stop(): Promise<void>
    onMessage(cb: (event: GeminiLiveEvent) => void): () => void
  }
  nanogpt: {
    /** Cached catalogues — no network call. */
    models(): Promise<NanogptModelsResult>
    /** Re-fetch both catalogues from NanoGPT and rewrite the cache. */
    refresh(): Promise<NanogptRefreshResult>
    usage(): Promise<NanoUsage>
    /** Generate images. Throws when the model is known to bill balance and consent was not given. */
    generate(a: NanogptGenerateArgs): Promise<NanogptGenerateResult>
    images: {
      /** Metadata only — call `read` for the bytes. Omit sessionID for the whole gallery. */
      list(sessionID?: string): Promise<GeneratedImageMeta[]>
      /** Base64 PNG bytes, or null when the file is gone. */
      read(id: string): Promise<string | null>
      remove(id: string): Promise<void>
    }
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
  /** `encoding` defaults to 'utf8'; pass 'base64' to write bytes (e.g. a generated PNG). */
  saveFile(a: { defaultName: string; content: string; encoding?: 'utf8' | 'base64' }): Promise<boolean>
  fs: {
    tree(directory: string, path?: string, depth?: number): Promise<FileNode[]>
    read(directory: string, path: string): Promise<FileContent>
    write(a: { directory: string; path: string; text: string; baseSha: string }): Promise<{ sha: string }>
  }
  git: {
    status(directory: string): Promise<GitStatus>
    diff(a: { directory: string; path: string; staged?: boolean }): Promise<FileDiff>
    stage(directory: string, paths: string[]): Promise<GitStatus>
    unstage(directory: string, paths: string[]): Promise<GitStatus>
    stageHunks(a: { directory: string; path: string; patch: string }): Promise<GitStatus>
    commit(a: { directory: string; message: string; amend?: boolean }): Promise<{ sha: string }>
    branches(directory: string): Promise<GitBranch[]>
    checkout(a: { directory: string; branch: string; create?: boolean }): Promise<GitStatus>
    remoteUrl(directory: string): Promise<string | null>
  }
  term: {
    start(a: { directory: string; cols: number; rows: number }): Promise<{ id: TermId }>
    write(id: TermId, data: string): Promise<void>
    resize(id: TermId, cols: number, rows: number): Promise<void>
    kill(id: TermId): Promise<void>
    onData(cb: (e: { id: TermId; data: string }) => void): () => void
    onExit(cb: (e: { id: TermId; code: number }) => void): () => void
  }
  openEditor(a: { directory: string; path: string; line?: number; column?: number }): Promise<void>
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
