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
}

export type PromptArgs = {
  directory: string
  sessionID: string
  providerID: string
  modelID: string
  text: string
}

export type PermissionReplyArgs = {
  directory: string
  sessionID: string
  permissionID: string
  response: PermissionResponse
}

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
  prompt(a: PromptArgs): Promise<void>
  abort(directory: string, sessionID: string): Promise<void>
  providers(): Promise<ProvidersResult>
  replyPermission(a: PermissionReplyArgs): Promise<void>
  openExternal(url: string): Promise<void>
  /** Registers an SSE listener; call the returned function to unsubscribe. */
  onEvent(cb: (e: OcEvent) => void): () => void
  /** Registers a server-status listener; call the returned function to unsubscribe. */
  onServer(cb: (s: ServerStatus) => void): () => void
}

export type { Message, Part, Permission, Provider, Session }

declare global {
  interface Window {
    api: OpencodeApi
  }
}
