# CONTRACTS.md — interfaces every agent codes against

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
```

### SSE event types (`Event` union) that matter

`message.updated` `{ info: Message }` · `message.removed` · `message.part.updated` `{ part: Part, delta? }` ·
`message.part.removed` · `permission.updated` (properties **are** the `Permission`) · `permission.replied` ·
`session.idle` · `session.error` · `session.created` / `.updated` / `.deleted` `{ info: Session }` ·
`session.status` · `server.connected` (always first) · `file.edited`.

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
                                providerID: string; modelID: string; text: string }) => void
'oc:abort'             (directory: string, sessionID: string) => void
'oc:providers'         () => { providers: Provider[]; default: Record<string, string> }
'oc:permission:reply'  (args: { directory: string; sessionID: string; permissionID: string;
                                response: 'once' | 'always' | 'reject' }) => void
'oc:openExternal'      (url: string) => void
```

### Send channels (main -> renderer, `webContents.send`)

```ts
'oc:event'   (event: { type: string; properties: any })   // every SSE event, verbatim
'oc:server'  (status: { running: boolean; url: string | null; error?: string })
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
  }
  messages(directory: string, sessionID: string): Promise<MessageWithParts[]>
  prompt(a: { directory: string; sessionID: string; providerID: string; modelID: string; text: string }): Promise<void>
  abort(directory: string, sessionID: string): Promise<void>
  providers(): Promise<ProvidersResult>
  replyPermission(a: { directory: string; sessionID: string; permissionID: string; response: PermissionResponse }): Promise<void>
  openExternal(url: string): Promise<void>
  onEvent(cb: (e: OcEvent) => void): () => void    // returns unsubscribe
  onServer(cb: (s: ServerStatus) => void): () => void
}
declare global { interface Window { api: OpencodeApi } }
```

`contextIsolation: true`, `nodeIntegration: false`, `sandbox: false`.

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

  // actions
  init(): Promise<void>                       // status + providers + restore persisted prefs
  pickDirectory(): Promise<void>
  setDirectory(dir: string): Promise<void>    // loads sessions
  newSession(): Promise<void>
  selectSession(id: string): Promise<void>    // loads messages
  deleteSession(id: string): Promise<void>
  send(text: string): Promise<void>
  abort(): Promise<void>
  setModel(providerID: string, modelID: string): void
  replyPermission(id: string, response: PermissionResponse): Promise<void>
  applyEvent(e: OcEvent): void                // SSE reducer
  dismissError(): void
}
```

`applyEvent` rules:
- `message.updated` — upsert `info` by `info.id` into `messages` (append if new, keep order by `time.created`).
- `message.part.updated` — find the message by `part.messageID`; upsert the part by `part.id`. If the
  message is not loaded yet, ignore. Preserve part order by first-seen.
- `message.removed` / `message.part.removed` — remove by id.
- `permission.updated` — push `properties` onto `permissions` if not already present by `id`.
- `permission.replied` — drop the matching permission by `permissionID`.
- `session.idle` — `busy = false` when `properties.sessionID === activeSessionID`.
- `session.error` — set `error` from `properties.error`, `busy = false`.
- `session.created` / `session.updated` / `session.deleted` — sync the `sessions` array.
- Ignore events whose `sessionID` is not the active session (except session list churn).

Persist `directory`, `providerID`, `modelID` to `localStorage` under key `opencode-desktop:prefs`.

## Component contract (props are exact)

Agent C (chat) and Agent D (shell) both import from the store; props stay minimal.

```tsx
// Agent D
<Sidebar />                                    // reads store directly
<ModelPicker />                                // reads store directly
<ProviderPanel open={boolean} onClose={() => void} />

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
`@media (prefers-color-scheme: light)` override.

Class-name namespaces so agents don't collide:
- Agent D: `.app`, `.sidebar`, `.titlebar`, `.modelpicker`, `.providers`, `.banner`
- Agent C: `.chat`, `.msg`, `.tool`, `.composer`, `.perm`

Agent C must **not** edit `index.css`. It writes its own `src/renderer/src/components/chat.css`
and imports it from `Chat.tsx`. Design tokens both use, defined by Agent D in `index.css`:

```
--bg, --bg-alt, --bg-inset, --fg, --fg-dim, --border, --accent, --accent-fg,
--danger, --warn, --ok, --radius, --mono
```

## Conventions

- TypeScript strict. No `any` in exported signatures (`any` inside event payload narrowing is fine).
- React 19 function components, hooks only. No class components.
- Named exports for components; `export function Chat() {}`.
- Node built-ins in main use the `node:` prefix (`node:child_process`, `node:path`).
- No `console.log` left in renderer code paths that run per-event.
- Windows first: spawn OpenCode via `opencode.cmd`; never assume a POSIX shell.
