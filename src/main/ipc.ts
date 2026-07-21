/**
 * Every renderer -> main invoke channel. Channel names are fixed by CONTRACTS.md.
 * Handlers unwrap the SDK's `{ data, error }` fields result and throw a readable Error on failure.
 */
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { Message, Part, Provider, Session } from '@opencode-ai/sdk'
import { getClient, getStatus, restartServer, setEventDirectory, type ServerStatus } from './server'

export type MessageWithParts = { info: Message; parts: Part[] }
export type ProvidersResult = { providers: Provider[]; default: Record<string, string> }
export type PermissionResponse = 'once' | 'always' | 'reject'

/** Shape of every SDK call with the default `responseStyle: 'fields'`. */
type FieldsResult<T> = { data: T | undefined; error: unknown; response: Response }

const CHANNELS = [
  'oc:status',
  'oc:restart',
  'oc:pickDirectory',
  'oc:sessions:list',
  'oc:sessions:create',
  'oc:sessions:delete',
  'oc:messages:list',
  'oc:prompt',
  'oc:abort',
  'oc:providers',
  'oc:permission:reply',
  'oc:openExternal'
] as const

/* ------------------------------------------------------------------ */
/* error / argument plumbing                                           */
/* ------------------------------------------------------------------ */

function describeErrorPayload(payload: unknown): string {
  if (payload === null || payload === undefined) return ''
  if (typeof payload === 'string') return payload
  if (payload instanceof Error) return payload.message
  if (typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    const name = typeof record.name === 'string' ? record.name : undefined
    const data = record.data
    let message: string | undefined
    if (typeof record.message === 'string') message = record.message
    if (!message && typeof data === 'object' && data !== null) {
      const inner = (data as Record<string, unknown>).message
      if (typeof inner === 'string') message = inner
    }
    if (name && message) return `${name}: ${message}`
    if (message) return message
    if (name) return name
  }
  try {
    return JSON.stringify(payload)
  } catch {
    return String(payload)
  }
}

async function call<T>(request: Promise<FieldsResult<T>>): Promise<T> {
  const result = await request

  if (result.error !== undefined && result.error !== null) {
    const detail = describeErrorPayload(result.error)
    const statusText = `${result.response.status} ${result.response.statusText}`.trim()
    throw new Error(detail ? `OpenCode: ${detail}` : `OpenCode request failed (${statusText})`)
  }

  if (!result.response.ok) {
    throw new Error(
      `OpenCode request failed: ${result.response.status} ${result.response.statusText}`.trim()
    )
  }

  return result.data as T
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid IPC argument: ${name} must be a non-empty string.`)
  }
  return value
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`Invalid IPC argument: ${name} must be an object.`)
  }
  return value as Record<string, unknown>
}

function requirePermissionResponse(value: unknown): PermissionResponse {
  if (value === 'once' || value === 'always' || value === 'reject') return value
  throw new Error(`Invalid permission response: ${String(value)}`)
}

/* ------------------------------------------------------------------ */
/* registration                                                        */
/* ------------------------------------------------------------------ */

export function registerIpc(): void {
  // Idempotent: a re-register (hot reload in dev) must not throw on duplicates.
  for (const channel of CHANNELS) ipcMain.removeHandler(channel)

  ipcMain.handle('oc:status', (): ServerStatus => getStatus())

  ipcMain.handle('oc:restart', (): Promise<ServerStatus> => restartServer())

  ipcMain.handle('oc:pickDirectory', async (event): Promise<string | null> => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: 'Choose a project folder',
      buttonLabel: 'Open project',
      properties: ['openDirectory']
    }
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled) return null
    const [first] = result.filePaths
    return first ?? null
  })

  ipcMain.handle('oc:sessions:list', async (_event, directoryArg: unknown): Promise<Session[]> => {
    const directory = requireString(directoryArg, 'directory')
    setEventDirectory(directory)
    return call<Session[]>(getClient().session.list({ query: { directory } }))
  })

  ipcMain.handle(
    'oc:sessions:create',
    async (_event, directoryArg: unknown, titleArg: unknown): Promise<Session> => {
      const directory = requireString(directoryArg, 'directory')
      const title = optionalString(titleArg)
      return call<Session>(
        getClient().session.create({
          query: { directory },
          body: title ? { title } : {}
        })
      )
    }
  )

  ipcMain.handle(
    'oc:sessions:delete',
    async (_event, directoryArg: unknown, idArg: unknown): Promise<void> => {
      const directory = requireString(directoryArg, 'directory')
      const id = requireString(idArg, 'id')
      await call<boolean>(getClient().session.delete({ path: { id }, query: { directory } }))
    }
  )

  ipcMain.handle(
    'oc:messages:list',
    async (_event, directoryArg: unknown, sessionArg: unknown): Promise<MessageWithParts[]> => {
      const directory = requireString(directoryArg, 'directory')
      const id = requireString(sessionArg, 'sessionID')
      return call<MessageWithParts[]>(
        getClient().session.messages({ path: { id }, query: { directory } })
      )
    }
  )

  ipcMain.handle('oc:prompt', async (_event, argsArg: unknown): Promise<void> => {
    const args = requireObject(argsArg, 'prompt args')
    const directory = requireString(args.directory, 'directory')
    const id = requireString(args.sessionID, 'sessionID')
    const providerID = requireString(args.providerID, 'providerID')
    const modelID = requireString(args.modelID, 'modelID')
    const text = requireString(args.text, 'text')

    await call<void>(
      getClient().session.promptAsync({
        path: { id },
        query: { directory },
        body: {
          model: { providerID, modelID },
          parts: [{ type: 'text', text }]
        }
      })
    )
  })

  ipcMain.handle(
    'oc:abort',
    async (_event, directoryArg: unknown, sessionArg: unknown): Promise<void> => {
      const directory = requireString(directoryArg, 'directory')
      const id = requireString(sessionArg, 'sessionID')
      await call<boolean>(getClient().session.abort({ path: { id }, query: { directory } }))
    }
  )

  ipcMain.handle('oc:providers', async (): Promise<ProvidersResult> => {
    return call<ProvidersResult>(getClient().config.providers())
  })

  ipcMain.handle('oc:permission:reply', async (_event, argsArg: unknown): Promise<void> => {
    const args = requireObject(argsArg, 'permission args')
    const directory = requireString(args.directory, 'directory')
    const id = requireString(args.sessionID, 'sessionID')
    const permissionID = requireString(args.permissionID, 'permissionID')
    const response = requirePermissionResponse(args.response)

    await call<boolean>(
      getClient().postSessionIdPermissionsPermissionId({
        path: { id, permissionID },
        query: { directory },
        body: { response }
      })
    )
  })

  ipcMain.handle('oc:openExternal', async (_event, urlArg: unknown): Promise<void> => {
    const raw = requireString(urlArg, 'url')
    let parsed: URL
    try {
      parsed = new URL(raw)
    } catch {
      throw new Error(`Refusing to open malformed URL: ${raw}`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Refusing to open non-http(s) URL: ${raw}`)
    }
    await shell.openExternal(parsed.toString())
  })
}

/** Remove every handler this module registered. */
export function unregisterIpc(): void {
  for (const channel of CHANNELS) ipcMain.removeHandler(channel)
}
