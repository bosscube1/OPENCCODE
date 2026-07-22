# CONTRACTS.md — interfaces every agent codes against (CURRENT)

Binding. Do not invent alternatives. If something is missing, follow the nearest pattern here.

## Architecture

Electron app. **Main process owns the OpenCode server and the SDK client.** Renderer never talks HTTP
(avoids CORS on `file://`). All traffic goes over IPC. Main subscribes once to the SSE event stream and
rebroadcasts every event to the renderer.

```
renderer (React)  <--IPC-->  main (Electron)  <--HTTP/SSE-->  `opencode serve` child process
```

Renderer imports SDK **types only** (`import type { ... } from '@opencode-ai/sdk'`) — never runtime SDK code.

## Ground truth: OpenCode SDK 1.18.4

Verified from installed `.d.ts`. Response style is `"fields"` — every call resolves to
`{ data?, error?, request, response }`. Always read `.data`.

```ts
import { createOpencodeClient } from '@opencode-ai/sdk'
const client = createOpencodeClient({ baseUrl: 'http://127.0.0.1:4599' })
```

Methods used by this app:

| Call | Signature |
|---|---|
| list sessions | `client.session.list({ query: { directory } })` -> `data: Session[]` |
| create session | `client.session.create({ body: { title? }, query: { directory } })` -> `data: Session` |
| delete session | `client.session.delete({ path: { id }, query: { directory } })` |
| messages | `client.session.messages({ path: { id }, query: { directory } })` -> `data: { info: Message, parts: Part[] }[]` |
| send prompt | `client.session.promptAsync({ path: { id }, query: { directory }, body: { model: { providerID, modelID }, parts: [{ type: 'text', text }] } })` |
| abort | `client.session.abort({ path: { id }, query: { directory } })` |
| providers | `client.config.providers()` -> `data: { providers: Provider[], default: Record<string,string> }` |
| permission reply | `client.postSessionIdPermissionsPermissionId({ path: { id, permissionID }, body: { response: 'once' \| 'always' \| 'reject' } })` |
| events | `client.event.subscribe()` -> `{ stream: AsyncIterable<Event> }` |

Use `promptAsync` (fire-and-forget) — the reply arrives as SSE events. Never `prompt` (blocks).

`directory` = the session's project folder; pass it on every call.

### Types (abridged, exact field names)

```ts
type Session = { id, projectID, directory, parentID?, title, version,
                 time: { created, updated }, share?: { url } }

type UserMessage      = { id, sessionID, role: 'user', time: { created }, agent,
                          model: { providerID, modelID } }
type AssistantMessage = { id, sessionID, role: 'assistant', time: { created, completed? },
                          error?, parentID, modelID, providerID, mode, cost,
                          tokens: { input, output, reasoning, cache: { read, write } }, finish? }
type Message = UserMessage | AssistantMessage

type TextPart      = { id, sessionID, messageID, type: 'text', text, synthetic?, time?: { start, end? } }
type ReasoningPart = { id, sessionID, messageID, type: 'reasoning', text, time: { start, end? } }
type FilePart      = { id, sessionID, messageID, type: 'file', mime, filename?, url }
type ToolPart      = { id, sessionID, messageID, type: 'tool', callID, tool, state: ToolState }
type ToolState =
  | { status: 'pending',   input, raw }
  | { status: 'running',   input, title?, metadata?, time: { start } }
  | { status: 'completed', input, output, title, metadata, time: { start, end } }
  | { status: 'error',     input, error, metadata?, time: { start, end } }
// Part union also includes: subtask | step-start | step-finish | snapshot | patch | agent | retry | compaction
// Render only text / reasoning / tool / file; ignore the rest.

type Permission = { id, type, pattern?, sessionID, messageID, callID?, title, metadata,
                    time: { created } }

type Provider = { id, name, source: 'env'|'config'|'custom'|'api', env: string[], key?,
                  options, models: Record<string, Model> }
type Model = { id, providerID, name, capabilities: { temperature, reasoning, attachment, toolcall,
               input: {...}, output: {...} }, cost: { input, output, cache: { read, write } },
               limit: { context, output }, status: 'alpha'|'beta'|'deprecated'|'active' }

type Todo     = { id: string; content: string;
                  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
                  priority: 'high' | 'medium' | 'low' }
type Command  = { name: string; description?: string; agent?: string; model?: string;
                  template: string; subtask?: boolean }
type Project  = { id: string; worktree: string; vcsDir?: string; vcs?: 'git';
                  time: { created: number; initialized?: number } }
type VcsInfo  = { branch: string }
```

### SSE event types (`Event` union) that matter

`message.updated` `{ info: Message }` · `message.removed` · `message.part.updated` `{ part: Part, delta? }` ·
`message.part.removed` · `permission.updated` (properties **are** the `Permission`) · `permission.replied` ·
`session.idle` · `session.error` · `session.created` / `.updated` / `.deleted` `{ info: Session }` ·
`session.status` · `server.connected` (always first) · `file.edited` ·
`todo.updated` · `vcs.branch.updated` · `session.compacted`.

Every event is `{ type: string, properties: {...} }`.

## IPC contract

Channel names are literal strings. Renderer calls them through `window.api` (preload bridge).

### Invoke channels (renderer -> main, `ipcMain.handle`)

Every handler returns `Promise<T>` and **throws** on failure (renderer catches).

```ts
'oc:status'            () => { running: boolean; url: string | null; error?: string }
'oc:restart'           () => { running: boolean; url: string | null; error?: string }
'oc:pickDirectory'     () => string | null              // native folder dialog
'oc:sessions:list'     (directory: string) => Session[]
'oc:sessions:create'   (directory: string, title?: string) => Session
'oc:sessions:delete'   (directory: string, id: string) => void
'oc:messages:list'     (directory: string, sessionID: string) => { info: Message; parts: Part[] }[]
'oc:prompt'            (args: { directory: string; sessionID: string;
                                providerID: string; modelID: string; text: string;
                                parts?: PromptPart[] }) => void
'oc:abort'             (directory: string, sessionID: string) => void
'oc:providers'         () => { providers: Provider[]; default: Record<string, string> }
'oc:permission:reply'  (args: { directory: string; sessionID: string; permissionID: string;
                                response: 'once' | 'always' | 'reject' }) => void
'oc:openExternal'      (url: string) => void
'oc:sessions:update'   (directory: string, id: string, title: string) => Session
'oc:sessions:summarize' (args: { directory: string; sessionID: string;
                                 providerID: string; modelID: string }) => boolean
'oc:sessions:init'      (args: { directory: string; sessionID: string;
                                 providerID: string; modelID: string;
                                 messageID: string }) => boolean
'oc:sessions:todos'     (directory: string, sessionID: string) => Todo[]
'oc:sessions:command'   (args: { directory: string; sessionID: string;
                                 command: string; arguments: string }) => void
'oc:commands:list'      (directory: string) => Command[]
'oc:find:files'         (directory: string, query: string) => string[]
'oc:vcs:get'            (directory: string) => VcsInfo | null   // 404 → null
'oc:projects:list'      () => ProjectRecord[]
'oc:projects:create'    (args: { name: string }) => ProjectRecord
'oc:projects:instructions:get' (directory: string) => string
'oc:projects:instructions:set' (args: { directory: string; text: string }) => void
'oc:projects:knowledge:list' (directory: string) => KnowledgeFile[]
'oc:projects:knowledge:add' (args: { directory: string; filePaths: string[] }) => KnowledgeFile[]
                        // an empty filePaths array opens the native multi-file picker
'oc:projects:knowledge:remove' (args: { directory: string; filename: string }) => void
'oc:mcp:status'         (directory: string) => McpSnapshot
'oc:mcp:add'            (args: { directory: string; name: string; config: McpConfig }) => McpSnapshot
'oc:mcp:remove'         (args: { directory: string; name: string }) => McpSnapshot
'oc:mcp:connect'        (args: { directory: string; name: string }) => McpSnapshot
'oc:mcp:disconnect'     (args: { directory: string; name: string }) => McpSnapshot
'oc:mcp:auth'           (args: { directory: string; name: string }) => McpSnapshot
'oc:quick:submit'       (text: string) => void
'oc:appSettings:get'    () => AppSettingsResult
'oc:appSettings:set'    (patch: Partial<AppSettings>) => AppSettingsResult
'oc:exportChat'         (defaultName: string, content: string) => Promise<boolean>
'oc:messages:revert'    (args: { directory: string; sessionID: string;
                                 messageID: string }) => void
                        // reverts server to before messageID; ALSO restores
                        // workspace file snapshots (renderer confirms first).
'oc:search:chats'       (directory: string, query: string) => ChatSearchHit[]
                        // global chat-content search, runs in main with a
                        // bounded (concurrency 4) message-fetch pool + LRU cache.
'oc:saveFile'           (args: { defaultName: string; content: string }) => boolean
                        // generalized save dialog for artifact export/download

// --- BYOK: encrypted API-key management (Stream 3A) ---
'oc:keys:list'          () => KeyRow[]        // masked rows only; NEVER the full key
'oc:keys:set'           (args: { providerID: string; key: string }) => void
                        // full key crosses IPC ONLY here (renderer -> main).
                        // On error, throws a message that excludes the key.
'oc:keys:delete'        (providerID: string) => void   // note the channel is :delete
'oc:keys:test'          (providerID: string) =>
                          { ok: boolean; status?: number; detail?: string }
                        // live-pings the provider's test endpoint with the
                        // decrypted key; key never logged or returned.
```

`KeyRow` (exported from `src/preload/index.ts`, importable by the renderer):

```ts
export type KeyRow = { providerID: string; envVar: string; maskedTail: string | null }
```

The full key **never** crosses IPC back to the renderer. `oc:keys:list` returns only the last-4
tail (or `null`). The renderer sends the plaintext once, on `oc:keys:set`; it is encrypted in main
and never read back in the clear across the bridge.

`ChatSearchHit` (exported from `src/preload/index.ts`, importable by the renderer):

```ts
export type ChatSearchHit = {
  sessionID: string; title: string; messageID: string; snippet: string; time: number
}
```

Module 6 project records are owned by the desktop app (not the OpenCode SDK) and persisted in
`userData/projects-registry.json`:

```ts
export type ProjectRecord = {
  id: string
  name: string
  directory: string
  createdAt: number
  updatedAt: number
}
export type KnowledgeFile = { filename: string; size: number; updatedAt: number }

export type McpLocalConfig = {
  type: 'local'; command: string[]; environment?: Record<string, string>;
  enabled?: boolean; timeout?: number
}
export type McpRemoteConfig = {
  type: 'remote'; url: string; enabled?: boolean; headers?: Record<string, string>;
  oauth?: { clientId?: string; clientSecret?: string; scope?: string } | false;
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
```

### Send channels (main -> renderer, `webContents.send`)

```ts
'oc:event'                 (event: { type: string; properties: any })   // every SSE event, verbatim
'oc:server'                (status: { running: boolean; url: string | null; error?: string })
'main-menu:new-session'    ()   // File > New Session menu / Ctrl+N accelerator
```

### Preload bridge shape (`window.api`)

```ts
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
    todos(directory: string, sessionID: string): Promise<Todo[]>
    command(a: CommandArgs): Promise<void>
  }
  commands: { list(directory: string): Promise<Command[]> }
  find: { files(directory: string, query: string): Promise<string[]> }
  vcs: { get(directory: string): Promise<VcsInfo | null> }
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
  quick: { submit(text: string): Promise<void> }
  appSettings: {
    get(): Promise<AppSettingsResult>
    set(patch: Partial<AppSettings>): Promise<AppSettingsResult>
  }
  keys: {
    list(): Promise<KeyRow[]>                                   // masked rows only
    set(a: { providerID: string; key: string }): Promise<void> // plaintext one-way in
    remove(providerID: string): Promise<void>                  // -> 'oc:keys:delete'
    test(providerID: string): Promise<{ ok: boolean; status?: number; detail?: string }>
  }
  messages(directory: string, sessionID: string): Promise<MessageWithParts[]>
  revertMessage(a: { directory: string; sessionID: string; messageID: string }): Promise<void>
  searchChats(directory: string, query: string): Promise<ChatSearchHit[]>
  prompt(a: { directory: string; sessionID: string; providerID: string; modelID: string; text: string; parts?: PromptPart[] }): Promise<void>
  abort(directory: string, sessionID: string): Promise<void>
  providers(): Promise<ProvidersResult>
  replyPermission(a: { directory: string; sessionID: string; permissionID: string; response: PermissionResponse }): Promise<void>
  openExternal(url: string): Promise<void>
  exportChat(defaultName: string, content: string): Promise<boolean>
  saveFile(a: { defaultName: string; content: string }): Promise<boolean>
  pathForFile(file: File): string     // wraps electron.webUtils.getPathForFile for drag-drop
  onEvent(cb: (e: OcEvent) => void): () => void            // returns unsubscribe
  onServer(cb: (s: ServerStatus) => void): () => void
  onMainMenuNewSession(cb: () => void): () => void
  onQuickEntryPrompt(cb: (text: string) => void): () => void
  onUpdateStatus(cb: (status: UpdateStatus) => void): () => void
}
declare global { interface Window { api: OpencodeApi } }
```

`contextIsolation: true`, `nodeIntegration: false`, `sandbox: false`.

## BYOK — bring-your-own-key (Stream 3A, security-critical)

Users store LLM-provider API keys in-app; keys are encrypted at rest and injected into the
`opencode serve` child process env at spawn.

**Store.** `src/main/keys.ts` is the ONLY module that touches Electron `safeStorage`. Keys live in
`userData/byok-keys.json`:

```json
{ "version": 1, "keys": { "GROQ_API_KEY": "<base64 of safeStorage.encryptString(value)>" } }
```

One entry per canonical env var (resolved from the provider catalog). Written pretty, mode `0o600`
best-effort. A missing/corrupt file reads as `{ version: 1, keys: {} }`. `setKey` **throws** if
`safeStorage.isEncryptionAvailable()` is false — it never writes plaintext.

**Env injection at spawn.** `server.ts` `doStart()` calls `loadByokEnv()` (decrypts all keys, applies
the same ALIAS expansion as `env.ts`) and merges **BYOK on top of the `.env` vars — BYOK wins on
conflict** — before `buildChildEnv`. `loadByokEnv` never throws: undecryptable/unavailable keys are
skipped so the server still starts. The existing `.env` log line is kept; a second `record()` line
logs `loaded N BYOK keys (encrypted store): <names>` using `redactedSummary` (key NAMES only).

`env.ts` now `export`s `ALLOWLIST` and `ALIASES` (contents unchanged) so `keys.ts` validates every
env var against the allowlist and reuses the alias logic. Existing blocklist/allowlist/CVE hardening
is untouched.

**DECISION — env-injection, NOT the SDK `auth.set`.** opencode's `auth.set` persists the raw key in
**plaintext** to opencode's `auth.json`. We reject that: the only at-rest copy must be under OS
encryption (`safeStorage`). Env-injection keeps the plaintext transient (decrypted in main, handed to
the child process, never written to disk by us).

**Key never crosses IPC back to the renderer.** The plaintext enters main once via `oc:keys:set`.
`oc:keys:list` returns `KeyRow[]` (last-4 tail or `null`). No key value is ever written to any log,
error message, or crash file — errors reference only the providerID/envVar.

**Catalog dependency.** `keys.ts` imports `PROVIDER_CATALOG`, `catalogByProvider` from
`src/main/providerCatalog.ts` (Stream 3C) for the providerID → envVar mapping and per-provider
`test` endpoints.

## Shared renderer types — `src/renderer/src/lib/types.ts` (Agent B owns)

```ts
export type MessageWithParts = { info: Message; parts: Part[] }
export type ServerStatus = { running: boolean; url: string | null; error?: string }
export type PermissionResponse = 'once' | 'always' | 'reject'
export type OcEvent = { type: string; properties: any }
```

## Renderer store — `src/renderer/src/lib/store.ts` (Agent B owns, zustand)

Single store. Components read via selectors; they never hold their own copy of server state.

```ts
interface AppState {
  // connection
  server: ServerStatus
  // project
  directory: string | null
  // sessions
  sessions: Session[]
  activeSessionID: string | null
  // messages for the active session, ordered oldest -> newest
  messages: MessageWithParts[]
  busy: boolean                      // assistant currently working
  // model
  providers: Provider[]
  defaultModels: Record<string, string>
  providerID: string | null
  modelID: string | null
  // permissions awaiting user answer, oldest first
  permissions: Permission[]
  // last error banner text, null when clear
  error: string | null

  // todos for the active session
  todos: Todo[]
  // current git branch
  branch: string | null
  // prompts waiting to be sent when session goes idle
  queuedPrompts: Array<{ text: string; parts?: PromptPart[] }>
  // commands from the server (project-level slash commands)
  serverCommands: Command[]
  // desktop-managed projects, each mapped to an isolated directory
  projects: ProjectRecord[]
  activeView: 'chats' | 'projects'
  appSettings: AppSettings
  shortcutRegistered: boolean
  shortcutError: string | null
  updateStatus: UpdateStatus
  // ui theme
  theme: 'auto' | 'dark' | 'light'

  // actions
  init(): Promise<void>                       // status + providers + restore persisted prefs
  pickDirectory(): Promise<void>
  setDirectory(dir: string): Promise<void>    // loads sessions
  loadProjects(): Promise<void>
  createProject(name: string): Promise<ProjectRecord>
  openProject(project: ProjectRecord): Promise<void> // delegates to setDirectory(project.directory)
  setActiveView(view: 'chats' | 'projects'): void
  loadAppSettings(): Promise<void>
  updateAppSettings(patch: Partial<AppSettings>): Promise<void>
  setUpdateStatus(status: UpdateStatus): void
  newSession(): Promise<void>
  selectSession(id: string): Promise<void>    // loads messages
  deleteSession(id: string): Promise<void>
  send(text: string, parts?: PromptPart[]): Promise<void>
  queuePrompt(text: string, parts?: PromptPart[]): void
  abort(): Promise<void>
  setModel(providerID: string, modelID: string): void
  replyPermission(id: string, response: PermissionResponse): Promise<void>
  applyEvent(e: OcEvent): void                // SSE reducer
  dismissError(): void
  renameSession(id: string, title: string): Promise<void>
  setTheme(t: 'auto' | 'dark' | 'light'): void
  queuePrompt(text: string, parts?: PromptPart[]): void
  removeQueued(index: number): void
  retryExchange(messageID: string): Promise<void>
  // Edit a prior USER message and resend: reverts the server to before that
  // message (also restoring workspace file snapshots), optimistically truncates
  // local messages to before it, then reuses send() so routing/rotation/queueing
  // all apply. No-op if the id is not a loaded user message.
  editAndResend(messageID: string, newText: string): Promise<void>
  // Smart routing v2 (Module 4)
  modelPool: string[] | null               // candidate "providerID/modelID" pairs; null = default pool
  stickyModel: boolean                     // keep selected model if healthy
  toggleStickyModel(): void
  setModelPool(pool: string[] | null): void
}
```

`applyEvent` rules:
- `message.updated` — upsert `info` by `info.id` into `messages` (append if new, keep order by `time.created`).
- `message.part.updated` — find the message by `part.messageID`; upsert the part by `part.id`. If the
  message is not loaded yet, ignore. Preserve part order by first-seen.
- `message.removed` / `message.part.removed` — remove by id.
- `permission.updated` — push `properties` onto `permissions` if not already present by `id`.
- `permission.replied` — drop the matching permission by `permissionID`.
- `session.idle` — `busy = false` when `properties.sessionID === activeSessionID`. Record success in routing ledger.
- `session.error` — set `error` from `properties.error`, `busy = false`. Record 429 in routing ledger if rate limit error.
- `session.created` / `session.updated` / `session.deleted` — sync the `sessions` array.
- Ignore events whose `sessionID` is not the active session (except session list churn).

Persist `directory`, `providerID`, `modelID`, `autoRotate`, `theme`, `modelPool`, `stickyModel` to `localStorage` under key `opencode-desktop:prefs`.

## Projects (Module 6)

- Managed roots live at `app.getPath('userData')/Projects/<slug>/`; the registry is versioned JSON
  at `app.getPath('userData')/projects-registry.json` and malformed records are ignored.
- Custom instructions occupy only the marker-delimited block in `<project>/AGENTS.md` between
  `<!-- OPENCODE-DESKTOP-INSTRUCTIONS-START -->` and
  `<!-- OPENCODE-DESKTOP-INSTRUCTIONS-END -->`; unrelated user content is preserved.
- Knowledge files are copied into `<project>/knowledge/`. Only Markdown knowledge formats are
  accepted, duplicate basenames are replaced, and all list/add/remove targets are containment-checked.
- `<project>/opencode.json` is merged without discarding existing keys and always includes
  `knowledge/**/*.md` in its `instructions` array.
- `assertSubpath(baseDir, candidate)` rejects the base directory itself, traversal, absolute paths
  outside the base, and any existing symlink/reparse-point segment. Filesystem-changing operations
  also validate the registered project directory before use.
- `.projects` owns Module 6 styling in `src/renderer/src/components/projects.css`; no new CSS tokens.

## MCP connectors (Module 7)

- Main owns all MCP SDK/config calls. Every call is scoped by `directory`; the renderer imports only
  `McpLocalConfig`, `McpRemoteConfig`, `McpStatus`, and `McpSnapshot` types.
- `oc:mcp:add` validates the name/config, calls `mcp.add`, then persists the merged `Config.mcp`
  through `config.get` + `config.update`. Remove persists the map without that entry and disconnects
  the live server best-effort. If `config.update` fails at runtime, main safely merges the same map
  into `<directory>/opencode.json` and restarts the local OpenCode server.
- OAuth calls `mcp.auth.start`, opens only the returned HTTP(S) authorization URL through Electron,
  and returns a refreshed snapshot. Credentials never pass through the renderer.
- Snapshot configs are display-safe: local `environment`, remote `headers`, and OAuth
  `clientSecret` values are omitted in main before crossing IPC.
- Local command strings are split in the renderer with the tested quote-aware `splitCommandLine`
  helper. Environment/header rows become trimmed key-value maps; empty or duplicate keys are rejected.
- MCP styling uses the `.mcp` namespace in `src/renderer/src/components/mcp.css`; no new CSS tokens.

## OS integration (Module 8)

- App settings are versioned JSON at `userData/app-settings.json`. Main validates all patches and
  owns registration of the configurable global shortcut (default `Ctrl+Alt+Space`); conflicts are
  returned as `shortcutError` and never crash startup.
- Closing the main window hides it when `closeToTray` is enabled. Explicit Quit from tray/menu sets
  the quitting flag, unregisters shortcuts, destroys tray/quick-entry windows, and stops the server.
- The tray offers Show/Hide, New Chat, Quick Entry, and Quit. `resources/tray-icon.svg/.png/.ico`
  contain an original neutral geometric mark; no third-party branding.
- Quick Entry is a frameless always-on-top window loading the same renderer at `#/quick`.
  `oc:quick:submit` accepts non-empty text in main, hides the quick window, focuses/creates the main
  window, and sends `quick-entry:prompt`; the main renderer calls the existing Zustand `send()` so
  smart routing and the single SSE pipeline remain unchanged.
- `electron-updater` is a runtime dependency. Main owns update checks and emits sanitized
  `update:status` events. The application menu exposes `Check for Updates...`; downloaded updates
  require explicit user confirmation before `quitAndInstall()`.
- GitHub publishing targets `bosscube1/OPENCCODE`; NSIS is the update-capable target. Portable builds
  remain available but are not auto-updated. Unsigned builds may trigger Windows SmartScreen.
- Quick Entry uses the `.quick-entry` CSS namespace. No new global CSS tokens.

## Smart Routing v2 — `src/renderer/src/lib/routing.ts` (Module 4)

Pure module for proactive health tracking and model selection.

```ts
export type ModelKey = string // format "providerID/modelID"

export type ModelHealth = {
  cooldownUntil: number
  cooldownMs: number
  success: number
  error: number
  last429: number | null
  latencyEwma: number | null
  sends: number[] // epoch-ms timestamps, pruned to last 24h
}

export type Ledger = Record<ModelKey, ModelHealth>

export type ProviderCaps = { rpm?: number; rpd?: number }
export type ModelCapsMap = Record<string, ProviderCaps>

export const DEFAULT_PROVIDER_CAPS: ModelCapsMap

export function record429(ledger: Ledger, key: ModelKey, now: number): Ledger
export function recordSuccess(ledger: Ledger, key: ModelKey, latencyMs: number, now: number): Ledger
export function recordFailure(ledger: Ledger, key: ModelKey, now: number): Ledger
export function underRateCaps(ledger: Ledger, key: ModelKey, caps: ModelCapsMap, now: number): boolean
export function selectModel(
  pool: ModelKey[] | null,
  ledger: Ledger,
  caps: ModelCapsMap,
  now: number,
  opts: { sticky: boolean; current: ModelKey | null; available: Set<ModelKey> }
): ModelKey | null
export function loadLedger(): Ledger
export function saveLedger(ledger: Ledger): void
```

Storage: `localStorage` key `opencode-desktop:routing-ledger`.

## Artifacts Side Panel — `src/renderer/src/lib/artifacts.ts` (Module 5)

Pure module for extracting, versioning, and managing code/renderable artifacts from chat messages.

```ts
export type ArtifactType = 'code' | 'html' | 'svg' | 'mermaid' | 'markdown'

export type ArtifactVersion = {
  version: number
  content: string
  messageID: string
}

export type Artifact = {
  id: string
  title: string
  type: ArtifactType
  language?: string
  version: number
  versions: ArtifactVersion[]
  currentContent: string
  messageID: string
}

export function extractArtifactsFromMessages(messages: MessageWithParts[]): Artifact[]
export function getArtifactTitle(type: ArtifactType, lang?: string, filename?: string): string
```

Store additions in `AppState`:
- `activeArtifactID: string | null`
- `setActiveArtifactID(id: string | null): void`

Security model:
- Sandboxed iframe host for HTML/SVG previews: `<iframe sandbox="allow-scripts" referrerpolicy="no-referrer">`
- **NEVER** set `allow-same-origin` on artifact previews to prevent renderer context leakage.
- Main process `will-navigate` / `will-frame-navigate` / `setWindowOpenHandler` blocks external frame navigation.


Agent C (chat) and Agent D (shell) both import from the store; props stay minimal.

```tsx
// Agent D
<Sidebar />                                    // reads store directly
<ModelPicker />                                // reads store directly
<ProviderPanel open={boolean} onClose={() => void} />
<SettingsPanel open={boolean} onClose={() => void} />

// Agent C
<Chat />                                       // reads store directly
<MessageView message={MessageWithParts} />
<ToolCall part={ToolPart} />
<Composer />
<PermissionPrompt permission={Permission}
                  onRespond={(r: PermissionResponse) => void} />
```

## Styling

One stylesheet: `src/renderer/src/index.css` (Agent D owns). No Tailwind, no CSS-in-JS.
Plain CSS with custom properties + BEM-ish class names. Dark theme by default,
`@media (prefers-color-scheme: light)` override (and `[data-theme='light']` for explicit
user choice).

Visual language: warm charcoal dark theme / warm ivory light theme, terracotta-clay accent,
serif display headings on top of a sans body. No blue/green accents anywhere.

Class-name namespaces so agents don't collide:
- Agent D: `.app`, `.sidebar`, `.titlebar`, `.modelpicker`, `.providers`, `.banner`
- Agent C: `.chat`, `.msg`, `.tool`, `.composer`, `.perm`

Agent C must **not** edit `index.css`. It writes its own `src/renderer/src/components/chat.css`
and imports it from `Chat.tsx`. Design tokens both use, defined by Agent D in `index.css`:

```
--bg, --bg-alt, --bg-inset, --fg, --fg-dim, --border, --accent, --accent-fg,
--danger, --warn, --ok, --radius, --mono
```

Additional tokens (Agent D owns, added on top of the contract set above — do not remove
any of the names above, only these are new):

```
--serif        display/heading font stack (system serif — Georgia/Iowan/Times), used only
               on .app__boot-title / .app__card-title style headings. Body text stays --sans.
--bg-sunken    darkest/lightest well surface, one step past --bg-inset (e.g. code wells)
--accent-soft  low-opacity accent tint for subtle highlight backgrounds
--card-radius  ~14px, rounder radius for card-like surfaces (.app__card, boot card).
               --radius (~8px) is unchanged and still used for buttons/inputs/etc.
--chat-max-w   ~48rem, the max width of the centered chat column. Agent D defines the
               token only; Agent C (messages.css) is responsible for applying it to
               center the chat content — Agent D's index.css does not reach into chat markup.
```

Palette (dark is default; light applies under `[data-theme='light']` and under
`@media (prefers-color-scheme: light)` for `:root:not([data-theme])` / `[data-theme='auto']`):

- Dark: `--bg #1f1e1d` `--bg-alt #262624` `--bg-inset #30302e` `--bg-sunken #1a1917`
  `--fg #f5f4ee` `--fg-dim #9a968c` `--border #3a3936` `--accent #d97757`
  `--accent-fg #1a1917` `--accent-soft rgba(217,119,87,0.14)`
- Light: `--bg #faf9f5` `--bg-alt #f0eee6` `--bg-inset #e9e6dc` `--bg-sunken #f5f3ec`
  `--fg #2b2a27` `--fg-dim #6b6862` `--border #ddd9cd` `--accent #c96442`
  `--accent-fg #ffffff` `--accent-soft rgba(201,100,66,0.12)`

Reserved right panel: `.app` grid has a 4th `panel` column, collapsed to `0px` width by
default. Adding the `.app--panel` class to the root `.app` element expands that column
(currently unused — reserved for a future Artifacts panel). No component renders into it yet.

## Conventions

- TypeScript strict. No `any` in exported signatures (`any` inside event payload narrowing is fine).
- React 19 function components, hooks only. No class components.
- Named exports for components; `export function Chat() {}`.
- Node built-ins in main use the `node:` prefix (`node:child_process`, `node:path`).
- No `console.log` left in renderer code paths that run per-event.
- Windows first: spawn OpenCode via `opencode.cmd`; never assume a POSIX shell.
