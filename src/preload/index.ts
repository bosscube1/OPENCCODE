/**
 * The only bridge between renderer and main. `ipcRenderer` itself is never exposed.
 * Shape is fixed by CONTRACTS.md (`window.api`).
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { Message, Part, Permission, Provider, Session } from '@opencode-ai/sdk'

export type ServerStatus = { running: boolean; url: string | null; error?: string }
export type MessageWithParts = { info: Message; parts: Part[] }
export type PermissionResponse = 'once' | 'always' | 'reject'
export type OcEvent = { type: string; properties: unknown }
export type ProvidersResult = { providers: Provider[]; default: Record<string, string> }

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
  onEvent(cb: (e: OcEvent) => void): () => void
  onServer(cb: (s: ServerStatus) => void): () => void
}

/** `Permission` is part of the contract surface (events carry it) — re-exported for the renderer. */
export type { Permission }

function subscribe<T>(channel: 'oc:event' | 'oc:server', callback: (payload: T) => void): () => void {
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
    remove: (directory, id) => ipcRenderer.invoke('oc:sessions:delete', directory, id)
  },
  messages: (directory, sessionID) => ipcRenderer.invoke('oc:messages:list', directory, sessionID),
  prompt: (a) => ipcRenderer.invoke('oc:prompt', a),
  abort: (directory, sessionID) => ipcRenderer.invoke('oc:abort', directory, sessionID),
  providers: () => ipcRenderer.invoke('oc:providers'),
  replyPermission: (a) => ipcRenderer.invoke('oc:permission:reply', a),
  openExternal: (url) => ipcRenderer.invoke('oc:openExternal', url),
  onEvent: (cb) => subscribe<OcEvent>('oc:event', cb),
  onServer: (cb) => subscribe<ServerStatus>('oc:server', cb)
}

try {
  contextBridge.exposeInMainWorld('api', api)
} catch {
  // contextIsolation disabled (should not happen with our webPreferences) — fall back to a global.
  ;(globalThis as unknown as { api: OpencodeApi }).api = api
}
