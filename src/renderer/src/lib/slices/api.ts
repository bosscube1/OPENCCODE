/**
 * The preload bridge surface, plus the error normaliser every slice shares.
 *
 * The renderer never speaks HTTP and never imports SDK runtime code — all traffic
 * goes through `window.api`.
 */

import type {
  AppSettings,
  AppSettingsResult,
  MessageWithParts,
  OcEvent,
  PermissionResponse,
  Provider,
  ServerStatus,
  Session,
  Todo,
  ServerCommand,
  ProjectRecord,
  PromptPart,
  UpdateStatus,
  GeneratedImageMeta,
  NanogptGenerateArgs,
  NanogptGenerateResult,
  NanogptModelsResult,
  NanogptRefreshResult,
  NanoUsage
} from '../types'

export interface OpencodeApi {
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
    listKnowledge(directory: string): Promise<import('../types').KnowledgeFile[]>
    addKnowledge(directory: string, filePaths?: string[]): Promise<import('../types').KnowledgeFile[]>
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

export function api(): OpencodeApi {
  const bridge = (window as unknown as { api?: OpencodeApi }).api
  if (!bridge) {
    throw new Error('Preload bridge unavailable — window.api is not defined.')
  }
  return bridge
}

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
