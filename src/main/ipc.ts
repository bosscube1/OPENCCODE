/**
 * Every renderer -> main invoke channel. Channel names are fixed by CONTRACTS.md.
 * Handlers unwrap the SDK's `{ data, error }` fields result and throw a readable Error on failure.
 */
import { writeFile } from 'node:fs/promises'
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { Message, Part, Provider, Session } from '@opencode-ai/sdk'
import { getAuthorizedProviderIDs, getClient, getStatus, isAuthorizedProvider, restartServer, setEventDirectory, type ServerStatus } from './server'
import { deleteKey, listKeys, setKey, testKey, type MaskedKeyRow } from './keys'
import {
  addKnowledge,
  createProject,
  getProjectInstructions,
  listKnowledge,
  listProjects,
  removeKnowledge,
  setProjectInstructions
} from './projects'
import {
  addMcp,
  authMcp,
  connectMcp,
  disconnectMcp,
  getMcpSnapshot,
  removeMcp,
  type McpSnapshot
} from './mcp'
import type { AppSettingsController, AppSettingsResult } from './appSettings'

export type MessageWithParts = { info: Message; parts: Part[] }
export type ProvidersResult = { providers: Provider[]; default: Record<string, string>; linkedProviderIDs: string[] }
export type PermissionResponse = 'once' | 'always' | 'reject'

export type RegisterIpcOptions = {
  appSettings?: Pick<AppSettingsController, 'get' | 'set'>
  onQuickSubmit?: (text: string) => void | Promise<void>
}

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
  'oc:openExternal',
  'oc:sessions:update',
  'oc:sessions:summarize',
  'oc:sessions:init',
  'oc:sessions:todos',
  'oc:sessions:command',
  'oc:commands:list',
  'oc:find:files',
  'oc:vcs:get',
  'oc:projects:list',
  'oc:projects:create',
  'oc:projects:instructions:get',
  'oc:projects:instructions:set',
  'oc:projects:knowledge:list',
  'oc:projects:knowledge:add',
  'oc:projects:knowledge:remove',
  'oc:mcp:status',
  'oc:mcp:add',
  'oc:mcp:remove',
  'oc:mcp:connect',
  'oc:mcp:disconnect',
  'oc:mcp:auth',
  'oc:quick:submit',
  'oc:appSettings:get',
  'oc:appSettings:set',
  'oc:exportChat',
  'oc:saveFile',
  'oc:messages:revert',
  'oc:search:chats',
  'oc:keys:list',
  'oc:keys:set',
  'oc:keys:delete',
  'oc:keys:test'
] as const

/** Result item for `oc:search:chats`. Kept structurally identical to the preload `ChatSearchHit`. */
export type ChatSearchHit = {
  sessionID: string
  title: string
  messageID: string
  snippet: string
  time: number
}

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
/* chat search: bounded pool, extraction, LRU cache                    */
/* ------------------------------------------------------------------ */

/** One searchable message: its id + concatenated text-part content. */
type SearchableMessage = { messageID: string; text: string }

/**
 * Module-scoped extraction cache. Keyed by `${sessionID}:${session.time.updated}`
 * → the session's extracted searchable text. A changed `updated` timestamp yields a
 * new key, so stale entries are simply never hit again (and evicted by capacity).
 * Insertion order = recency of use; oldest entries evict first past the cap.
 */
const SEARCH_CACHE_LIMIT = 200
const searchCache = new Map<string, SearchableMessage[]>()

function searchCacheGet(key: string): SearchableMessage[] | undefined {
  const hit = searchCache.get(key)
  if (hit === undefined) return undefined
  // Refresh recency: re-insert so it becomes the newest entry.
  searchCache.delete(key)
  searchCache.set(key, hit)
  return hit
}

function searchCacheSet(key: string, value: SearchableMessage[]): void {
  if (searchCache.has(key)) searchCache.delete(key)
  searchCache.set(key, value)
  while (searchCache.size > SEARCH_CACHE_LIMIT) {
    const oldest = searchCache.keys().next().value
    if (oldest === undefined) break
    searchCache.delete(oldest)
  }
}

/**
 * Run `worker` over `items` with at most `concurrency` in flight at once.
 * Never rejects: worker failures are the worker's own concern (it swallows them).
 */
async function promisePool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const runners: Promise<void>[] = []
  const width = Math.max(1, Math.min(concurrency, items.length))
  for (let i = 0; i < width; i++) {
    runners.push(
      (async () => {
        for (;;) {
          const index = next
          next += 1
          if (index >= items.length) return
          results[index] = await worker(items[index])
        }
      })()
    )
  }
  await Promise.all(runners)
  return results
}

/** Build a ~60-char snippet centred on the (already-located) match, with ellipses + collapsed whitespace. */
function makeSnippet(text: string, matchIndex: number, queryLen: number): string {
  const collapsed = text.replace(/\s+/g, ' ')
  // Re-locate the match inside the collapsed string (indices shift when whitespace collapses).
  const lower = collapsed.toLowerCase()
  const q = text.substr(matchIndex, queryLen).replace(/\s+/g, ' ').toLowerCase()
  let idx = q.length > 0 ? lower.indexOf(q) : matchIndex
  if (idx < 0) idx = 0
  const radius = 30
  const start = Math.max(0, idx - radius)
  const end = Math.min(collapsed.length, idx + queryLen + radius)
  let snippet = collapsed.slice(start, end).trim()
  if (start > 0) snippet = `…${snippet}`
  if (end < collapsed.length) snippet = `${snippet}…`
  return snippet
}

/* ------------------------------------------------------------------ */
/* registration                                                        */
/* ------------------------------------------------------------------ */

/** Reject model operations unless both the provider credential and model are
 * present in the server started by this desktop process. */
async function requireAuthorizedModel(providerID: string, modelID: string): Promise<void> {
  if (!isAuthorizedProvider(providerID)) {
    throw new Error(`Provider ${providerID} has no API key linked to this OpenCode Desktop server.`)
  }
  const config = await call<{ providers: Provider[] }>(getClient().config.providers())
  const modelExists = config.providers.some(
    (provider) => provider.id === providerID && Object.prototype.hasOwnProperty.call(provider.models ?? {}, modelID)
  )
  if (!modelExists) {
    throw new Error(`Model ${providerID}/${modelID} is not available from the linked provider.`)
  }
}

export function registerIpc(options: RegisterIpcOptions = {}): void {
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

    const parts = Array.isArray(args.parts) && args.parts.length > 0
      ? args.parts
      : [{ type: 'text' as const, text }]

    await requireAuthorizedModel(providerID, modelID)
    await call<void>(
      getClient().session.promptAsync({
        path: { id },
        query: { directory },
        body: {
          model: { providerID, modelID },
          parts
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
    const result = await call<{ providers: Provider[]; default: Record<string, string> }>(getClient().config.providers())
    return { ...result, linkedProviderIDs: getAuthorizedProviderIDs() }
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

  ipcMain.handle(
    'oc:sessions:update',
    async (_event, directoryArg: unknown, idArg: unknown, titleArg: unknown): Promise<Session> => {
      const directory = requireString(directoryArg, 'directory')
      const id = requireString(idArg, 'id')
      const title = requireString(titleArg, 'title')
      return call<Session>(
        getClient().session.update({ path: { id }, query: { directory }, body: { title } })
      )
    }
  )

  ipcMain.handle('oc:sessions:summarize', async (_event, argsArg: unknown): Promise<boolean> => {
    const args = requireObject(argsArg, 'summarize args')
    const directory = requireString(args.directory, 'directory')
    const id = requireString(args.sessionID, 'sessionID')
    const providerID = requireString(args.providerID, 'providerID')
    const modelID = requireString(args.modelID, 'modelID')
    await requireAuthorizedModel(providerID, modelID)
    return call<boolean>(
      getClient().session.summarize({
        path: { id },
        query: { directory },
        body: { providerID, modelID }
      })
    )
  })

  ipcMain.handle('oc:sessions:init', async (_event, argsArg: unknown): Promise<boolean> => {
    const args = requireObject(argsArg, 'init args')
    const directory = requireString(args.directory, 'directory')
    const id = requireString(args.sessionID, 'sessionID')
    const providerID = requireString(args.providerID, 'providerID')
    const modelID = requireString(args.modelID, 'modelID')
    const messageID = requireString(args.messageID, 'messageID')
    await requireAuthorizedModel(providerID, modelID)
    return call<boolean>(
      getClient().session.init({
        path: { id },
        query: { directory },
        body: { providerID, modelID, messageID }
      })
    )
  })

  ipcMain.handle(
    'oc:sessions:todos',
    async (_event, directoryArg: unknown, sessionArg: unknown) => {
      const directory = requireString(directoryArg, 'directory')
      const id = requireString(sessionArg, 'sessionID')
      return call(getClient().session.todo({ path: { id }, query: { directory } }))
    }
  )

  ipcMain.handle('oc:sessions:command', async (_event, argsArg: unknown): Promise<void> => {
    const args = requireObject(argsArg, 'command args')
    const directory = requireString(args.directory, 'directory')
    const id = requireString(args.sessionID, 'sessionID')
    const command = requireString(args.command, 'command')
    const arguments_ = typeof args.arguments === 'string' ? args.arguments : ''
    // Fire-and-forget — errors arrive via SSE
    void call(
      getClient().session.command({
        path: { id },
        query: { directory },
        body: { command, arguments: arguments_ }
      })
    ).catch((err) => { console.error('oc:sessions:command failed', err) })
  })

  ipcMain.handle(
    'oc:commands:list',
    async (_event, directoryArg: unknown) => {
      const directory = requireString(directoryArg, 'directory')
      return call(getClient().command.list({ query: { directory } }))
    }
  )

  ipcMain.handle(
    'oc:find:files',
    async (_event, directoryArg: unknown, queryArg: unknown) => {
      const directory = requireString(directoryArg, 'directory')
      const query = typeof queryArg === 'string' ? queryArg : ''
      return call<string[]>(getClient().find.files({ query: { query, directory } }))
    }
  )

  ipcMain.handle(
    'oc:vcs:get',
    async (_event, directoryArg: unknown) => {
      const directory = requireString(directoryArg, 'directory')
      try {
        return await call(getClient().vcs.get({ query: { directory } }))
      } catch {
        // 404 when no VCS is available — return null instead of throwing.
        return null
      }
    }
  )

  ipcMain.handle('oc:projects:list', async () => listProjects())

  ipcMain.handle('oc:projects:create', async (_event, argsArg: unknown) => {
    const args = requireObject(argsArg, 'project create args')
    return createProject(requireString(args.name, 'name'))
  })

  ipcMain.handle('oc:projects:instructions:get', async (_event, directoryArg: unknown) => {
    return getProjectInstructions(requireString(directoryArg, 'directory'))
  })

  ipcMain.handle('oc:projects:instructions:set', async (_event, argsArg: unknown) => {
    const args = requireObject(argsArg, 'project instructions args')
    const directory = requireString(args.directory, 'directory')
    const text = typeof args.text === 'string' ? args.text : (() => { throw new Error('Invalid IPC argument: text must be a string.') })()
    await setProjectInstructions(directory, text)
  })

  ipcMain.handle('oc:projects:knowledge:list', async (_event, directoryArg: unknown) => {
    return listKnowledge(requireString(directoryArg, 'directory'))
  })

  ipcMain.handle('oc:projects:knowledge:add', async (event, argsArg: unknown) => {
    const args = requireObject(argsArg, 'project knowledge args')
    const directory = requireString(args.directory, 'directory')
    let filePaths: string[] = []
    if (args.filePaths !== undefined) {
      if (!Array.isArray(args.filePaths) || !args.filePaths.every((item) => typeof item === 'string')) {
        throw new Error('Invalid IPC argument: filePaths must be a string array.')
      }
      filePaths = args.filePaths
    }
    if (filePaths.length === 0) {
      const owner = BrowserWindow.fromWebContents(event.sender)
      const options: Electron.OpenDialogOptions = {
        title: 'Add knowledge files',
        buttonLabel: 'Add knowledge',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Markdown', extensions: ['md'] }]
      }
      const result = owner
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled) return listKnowledge(directory)
      filePaths = result.filePaths
    }
    return addKnowledge(directory, filePaths)
  })

  ipcMain.handle('oc:projects:knowledge:remove', async (_event, argsArg: unknown) => {
    const args = requireObject(argsArg, 'project knowledge remove args')
    await removeKnowledge(
      requireString(args.directory, 'directory'),
      requireString(args.filename, 'filename')
    )
  })

  ipcMain.handle('oc:mcp:status', (_event, directoryArg: unknown): Promise<McpSnapshot> => {
    const directory = requireString(directoryArg, 'directory')
    return getMcpSnapshot(getClient(), directory)
  })

  ipcMain.handle('oc:mcp:add', (_event, argsArg: unknown): Promise<McpSnapshot> => {
    const args = requireObject(argsArg, 'mcp.add args')
    const directory = requireString(args.directory, 'directory')
    return addMcp(getClient(), directory, args.name, args.config, restartServer, getClient)
  })

  ipcMain.handle('oc:mcp:remove', (_event, argsArg: unknown): Promise<McpSnapshot> => {
    const args = requireObject(argsArg, 'mcp.remove args')
    const directory = requireString(args.directory, 'directory')
    return removeMcp(getClient(), directory, args.name, restartServer, getClient)
  })

  ipcMain.handle('oc:mcp:connect', (_event, argsArg: unknown): Promise<McpSnapshot> => {
    const args = requireObject(argsArg, 'mcp.connect args')
    const directory = requireString(args.directory, 'directory')
    return connectMcp(getClient(), directory, args.name)
  })

  ipcMain.handle('oc:mcp:disconnect', (_event, argsArg: unknown): Promise<McpSnapshot> => {
    const args = requireObject(argsArg, 'mcp.disconnect args')
    const directory = requireString(args.directory, 'directory')
    return disconnectMcp(getClient(), directory, args.name)
  })

  ipcMain.handle('oc:mcp:auth', (_event, argsArg: unknown): Promise<McpSnapshot> => {
    const args = requireObject(argsArg, 'mcp.auth args')
    const directory = requireString(args.directory, 'directory')
    return authMcp(getClient(), directory, args.name, (url) => shell.openExternal(url))
  })

  ipcMain.handle('oc:quick:submit', async (_event, textArg: unknown): Promise<void> => {
    const text = requireString(textArg, 'text').trim()
    if (!options.onQuickSubmit) throw new Error('Quick Entry is not initialized.')
    await options.onQuickSubmit(text)
  })

  ipcMain.handle('oc:appSettings:get', (): AppSettingsResult => {
    if (!options.appSettings) throw new Error('App settings are not initialized.')
    return options.appSettings.get()
  })

  ipcMain.handle('oc:appSettings:set', (_event, patchArg: unknown): AppSettingsResult => {
    if (!options.appSettings) throw new Error('App settings are not initialized.')
    return options.appSettings.set(patchArg)
  })

  ipcMain.handle(
    'oc:exportChat',
    async (_event, defaultNameArg: unknown, contentArg: unknown): Promise<boolean> => {
      const defaultName = requireString(defaultNameArg, 'defaultName')
      const content = requireString(contentArg, 'content')
      const win = BrowserWindow.getFocusedWindow()
      const options = {
        title: 'Export Chat History to Markdown',
        defaultPath: defaultName,
        filters: [{ name: 'Markdown Files', extensions: ['md'] }]
      }
      const { filePath, canceled } = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options)
      if (canceled || !filePath) return false
      await writeFile(filePath, content, 'utf8')
      return true
    }
  )

  ipcMain.handle(
    'oc:saveFile',
    async (_event, argsArg: unknown): Promise<boolean> => {
      const args = requireObject(argsArg, 'saveFile args')
      const defaultName = requireString(args.defaultName, 'defaultName')
      const content = requireString(args.content, 'content')
      const ext = defaultName.includes('.') ? defaultName.split('.').pop()! : 'txt'
      const win = BrowserWindow.getFocusedWindow()
      const options = {
        title: 'Save File',
        defaultPath: defaultName,
        filters: [{ name: `${ext.toUpperCase()} File`, extensions: [ext] }, { name: 'All Files', extensions: ['*'] }]
      }
      const { filePath, canceled } = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options)
      if (canceled || !filePath) return false
      await writeFile(filePath, content, 'utf8')
      return true
    }
  )

  ipcMain.handle('oc:messages:revert', async (_event, argsArg: unknown): Promise<void> => {
    const args = requireObject(argsArg, 'revert args')
    const directory = requireString(args.directory, 'directory')
    const sessionID = requireString(args.sessionID, 'sessionID')
    const messageID = requireString(args.messageID, 'messageID')
    await call<Session>(
      getClient().session.revert({
        path: { id: sessionID },
        query: { directory },
        body: { messageID }
      })
    )
  })

  ipcMain.handle(
    'oc:search:chats',
    async (_event, directoryArg: unknown, queryArg: unknown): Promise<ChatSearchHit[]> => {
      const directory = requireString(directoryArg, 'directory')
      const query = typeof queryArg === 'string' ? queryArg : ''
      const needle = query.trim().toLowerCase()
      if (needle.length === 0) return []

      const sessions = await call<Session[]>(getClient().session.list({ query: { directory } }))

      const perSession = await promisePool(sessions, 4, async (session): Promise<ChatSearchHit[]> => {
        const updated = session.time?.updated ?? 0
        const cacheKey = `${session.id}:${updated}`

        let searchable = searchCacheGet(cacheKey)
        if (searchable === undefined) {
          try {
            const messages = await call<MessageWithParts[]>(
              getClient().session.messages({ path: { id: session.id }, query: { directory } })
            )
            searchable = messages.map((m) => ({
              messageID: m.info.id,
              text: m.parts
                .filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text')
                .map((p) => p.text)
                .join('\n')
            }))
            searchCacheSet(cacheKey, searchable)
          } catch {
            // One session failing to load must never fail the whole search.
            return []
          }
        }

        const title = session.title ?? '(untitled)'
        const out: ChatSearchHit[] = []
        for (const entry of searchable) {
          const matchIndex = entry.text.toLowerCase().indexOf(needle)
          if (matchIndex >= 0) {
            out.push({
              sessionID: session.id,
              title,
              messageID: entry.messageID,
              snippet: makeSnippet(entry.text, matchIndex, needle.length),
              time: updated
            })
          }
        }
        return out
      })

      return perSession
        .flat()
        .sort((a, b) => b.time - a.time)
        .slice(0, 100)
    }
  )

  /* ---------------------------------------------------------------- */
  /* BYOK key management (Stream 3A)                                  */
  /* The full key crosses IPC only renderer -> main on 'oc:keys:set'. */
  /* It is NEVER returned to the renderer; list yields masked rows.   */
  /* ---------------------------------------------------------------- */

  ipcMain.handle('oc:keys:list', (): MaskedKeyRow[] => listKeys())

  ipcMain.handle('oc:keys:set', (_event, argsArg: unknown): void => {
    const args = requireObject(argsArg, 'keys.set args')
    const providerID = requireString(args.providerID, 'providerID')
    const key = requireString(args.key, 'key')
    try {
      setKey(providerID, key)
    } catch (error) {
      // Rethrow a message that references only the provider — never the key.
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to store key for provider ${providerID}: ${detail}`)
    }
  })

  ipcMain.handle('oc:keys:delete', (_event, providerArg: unknown): void => {
    const providerID = requireString(providerArg, 'providerID')
    deleteKey(providerID)
  })

  ipcMain.handle(
    'oc:keys:test',
    (_event, providerArg: unknown): Promise<{ ok: boolean; status?: number; detail?: string }> => {
      const providerID = requireString(providerArg, 'providerID')
      return testKey(providerID)
    }
  )
}


/** Remove every handler this module registered. */
export function unregisterIpc(): void {
  for (const channel of CHANNELS) ipcMain.removeHandler(channel)
}
