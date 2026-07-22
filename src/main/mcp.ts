import { readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { deleteMcpSecrets, getMcpSecrets, setMcpSecrets, type McpSecrets } from './keys'
import type {
  Config,
  McpLocalConfig,
  McpRemoteConfig,
  McpStatus,
  OpencodeClient
} from '@opencode-ai/sdk'

export type McpConfig = McpLocalConfig | McpRemoteConfig
export type McpSnapshot = {
  configs: Record<string, McpConfig>
  statuses: Record<string, McpStatus>
}

type FieldsResult<T> = { data: T | undefined; error: unknown; response: Response }
type Restart = () => Promise<unknown>
type OpenExternal = (url: string) => Promise<unknown>
type GetClient = () => OpencodeClient
type ConfigMutation = (configs: Record<string, McpConfig>) => Record<string, McpConfig>

function errorDetail(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (typeof error === 'object' && error !== null) {
    const message = (error as Record<string, unknown>).message
    if (typeof message === 'string') return message
  }
  return 'OpenCode request failed.'
}

async function unwrap<T>(request: Promise<FieldsResult<T>>): Promise<T> {
  const result = await request
  if (result.error !== undefined && result.error !== null) throw new Error(errorDetail(result.error))
  if (!result.response.ok) {
    throw new Error(`OpenCode request failed: ${result.response.status} ${result.response.statusText}`.trim())
  }
  return result.data as T
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateStringMap(value: unknown, field: string): Record<string, string> | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new Error(`${field} must be an object.`)
  const result: Record<string, string> = {}
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = rawKey.trim()
    if (!key) throw new Error(`${field} keys must not be empty.`)
    if (Object.hasOwn(result, key)) throw new Error(`${field} contains a duplicate key: ${key}.`)
    if (typeof rawValue !== 'string') throw new Error(`${field}.${key} must be a string.`)
    result[key] = rawValue.trim()
  }
  return result
}

function validateTimeout(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error('MCP timeout must be a positive integer in milliseconds.')
  }
  return value
}

export function validateMcpName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('MCP name must be a string.')
  const name = value.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new Error('MCP name must be 1-64 letters, numbers, dots, underscores, or hyphens.')
  }
  return name
}

export function validateMcpConfig(value: unknown): McpConfig {
  if (!isRecord(value)) throw new Error('MCP config must be an object.')
  const enabled = value.enabled
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    throw new Error('MCP enabled must be a boolean.')
  }
  const timeout = validateTimeout(value.timeout)

  if (value.type === 'local') {
    if (!Array.isArray(value.command) || value.command.length === 0 ||
        value.command.some((part) => typeof part !== 'string') ||
        typeof value.command[0] !== 'string' || !value.command[0].trim()) {
      throw new Error('Local MCP command must begin with a non-empty executable string.')
    }
    const environment = validateStringMap(value.environment, 'MCP environment')
    return {
      type: 'local',
      command: [value.command[0].trim(), ...value.command.slice(1) as string[]],
      ...(environment ? { environment } : {}),
      ...(enabled === undefined ? {} : { enabled }),
      ...(timeout === undefined ? {} : { timeout })
    }
  }

  if (value.type === 'remote') {
    if (typeof value.url !== 'string') throw new Error('Remote MCP URL must be a string.')
    let url: URL
    try { url = new URL(value.url.trim()) } catch { throw new Error('Remote MCP URL is invalid.') }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Remote MCP URL must use HTTP or HTTPS.')
    }
    let oauth: McpRemoteConfig['oauth']
    if (value.oauth === false) {
      oauth = false
    } else if (value.oauth !== undefined) {
      if (!isRecord(value.oauth)) throw new Error('MCP OAuth config must be an object or false.')
      oauth = {}
      for (const field of ['clientId', 'clientSecret', 'scope'] as const) {
        const fieldValue = value.oauth[field]
        if (fieldValue !== undefined && (typeof fieldValue !== 'string' || !fieldValue.trim())) {
          throw new Error(`MCP OAuth ${field} must be a non-empty string.`)
        }
        if (typeof fieldValue === 'string') oauth[field] = fieldValue.trim()
      }
    }
    const headers = validateStringMap(value.headers, 'MCP headers')
    return {
      type: 'remote',
      url: url.toString(),
      ...(headers ? { headers } : {}),
      ...(oauth === undefined ? {} : { oauth }),
      ...(enabled === undefined ? {} : { enabled }),
      ...(timeout === undefined ? {} : { timeout })
    }
  }

  throw new Error('MCP config type must be local or remote.')
}

export function mergeMcpConfig(
  configs: Record<string, McpConfig> | undefined,
  name: string,
  config: McpConfig
): Record<string, McpConfig> {
  return { ...(configs ?? {}), [name]: config }
}

export function removeMcpConfig(
  configs: Record<string, McpConfig> | undefined,
  name: string
): Record<string, McpConfig> {
  const next = { ...(configs ?? {}) }
  delete next[name]
  return next
}

function validConfigMap(value: unknown): Record<string, McpConfig> {
  if (!isRecord(value)) return {}
  const result: Record<string, McpConfig> = {}
  for (const [name, config] of Object.entries(value)) {
    try { result[validateMcpName(name)] = validateMcpConfig(config) } catch { /* omit invalid server config */ }
  }
  return result
}

/** Return only display-safe config fields. Environment, header, and OAuth secrets stay in main. */
export function publicMcpConfigMap(configs: Record<string, McpConfig>): Record<string, McpConfig> {
  const result: Record<string, McpConfig> = {}
  for (const [name, config] of Object.entries(configs)) {
    if (config.type === 'local') {
      result[name] = {
        type: 'local',
        command: [...config.command],
        ...(config.enabled === undefined ? {} : { enabled: config.enabled }),
        ...(config.timeout === undefined ? {} : { timeout: config.timeout })
      }
    } else {
      const oauth = config.oauth === false
        ? false
        : config.oauth === undefined
          ? undefined
          : {
              ...(config.oauth.clientId ? { clientId: config.oauth.clientId } : {}),
              ...(config.oauth.scope ? { scope: config.oauth.scope } : {})
            }
      result[name] = {
        type: 'remote',
        url: config.url,
        ...(oauth === undefined ? {} : { oauth }),
        ...(config.enabled === undefined ? {} : { enabled: config.enabled }),
        ...(config.timeout === undefined ? {} : { timeout: config.timeout })
      }
    }
  }
  return result
}

/** Remove credential-bearing fields before any workspace configuration write. */
export function stripMcpSecrets(config: McpConfig): McpConfig {
  if (config.type === 'local') {
    return {
      type: 'local',
      command: [...config.command],
      ...(config.enabled === undefined ? {} : { enabled: config.enabled }),
      ...(config.timeout === undefined ? {} : { timeout: config.timeout })
    }
  }
  const oauth = config.oauth === false
    ? false
    : config.oauth === undefined
      ? undefined
      : {
          ...(config.oauth.clientId ? { clientId: config.oauth.clientId } : {}),
          ...(config.oauth.scope ? { scope: config.oauth.scope } : {})
        }
  return {
    type: 'remote',
    url: config.url,
    ...(oauth === undefined ? {} : { oauth }),
    ...(config.enabled === undefined ? {} : { enabled: config.enabled }),
    ...(config.timeout === undefined ? {} : { timeout: config.timeout })
  }
}

function extractMcpSecrets(config: McpConfig): McpSecrets | undefined {
  if (config.type === 'local') {
    return config.environment && Object.keys(config.environment).length > 0
      ? { environment: { ...config.environment } }
      : undefined
  }
  const oauthClientSecret = typeof config.oauth === 'object' ? config.oauth.clientSecret : undefined
  if (!config.headers && !oauthClientSecret) return undefined
  return {
    ...(config.headers && Object.keys(config.headers).length > 0 ? { headers: { ...config.headers } } : {}),
    ...(oauthClientSecret ? { oauthClientSecret } : {})
  }
}

function hydrateMcpConfig(config: McpConfig, secrets: McpSecrets | undefined): McpConfig {
  if (!secrets) return config
  if (config.type === 'local') {
    return {
      ...config,
      ...(secrets.environment ? { environment: { ...secrets.environment } } : {})
    }
  }
  if (config.type === 'remote') {
    const oauth = config.oauth === false
      ? false
      : config.oauth === undefined
        ? (secrets.oauthClientSecret ? { clientSecret: secrets.oauthClientSecret } : undefined)
        : { ...config.oauth, ...(secrets.oauthClientSecret ? { clientSecret: secrets.oauthClientSecret } : {}) }
    return {
      ...config,
      ...(secrets.headers ? { headers: { ...secrets.headers } } : {}),
      ...(oauth === undefined ? {} : { oauth })
    }
  }
  return config
}

function redactMcpConfigMap(configs: Record<string, McpConfig>): Record<string, McpConfig> {
  return Object.fromEntries(Object.entries(configs).map(([name, config]) => [name, stripMcpSecrets(config)]))
}

async function writeConfigFallback(
  directory: string,
  configs: Record<string, McpConfig>,
  restart: Restart,
  mutation?: ConfigMutation
): Promise<void> {
  const root = resolve(directory)
  const path = join(root, 'opencode.json')
  let diskConfig: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (!isRecord(parsed)) throw new Error('Project opencode.json must contain a JSON object.')
    diskConfig = parsed
  } catch (error) {
    const code = isRecord(error) ? error.code : undefined
    if (code !== 'ENOENT') throw error
  }
  const diskMcp = validConfigMap(diskConfig.mcp)
  const nextConfigs = mutation ? mutation(diskMcp) : configs
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify({ ...diskConfig, mcp: nextConfigs }, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
  await restart()
}

async function readServerConfig(client: OpencodeClient, directory: string): Promise<Config> {
  return unwrap<Config>(client.config.get({ query: { directory } }))
}

async function persistMcpConfigs(
  client: OpencodeClient,
  directory: string,
  configs: Record<string, McpConfig>,
  restart: Restart,
  current?: Config,
  fallbackMutation?: ConfigMutation
): Promise<boolean> {
  try {
    const base = current ?? await readServerConfig(client, directory)
    await unwrap<Config>(client.config.update({ query: { directory }, body: { ...base, mcp: configs } }))
    return false
  } catch {
    await writeConfigFallback(directory, configs, restart, fallbackMutation)
    return true
  }
}

/**
 * One-time migration for legacy workspace configs. Credentials are encrypted before the
 * workspace file is rewritten, so a failed encryption operation never discards a secret.
 */
async function migrateWorkspaceMcpSecrets(
  client: OpencodeClient,
  directory: string,
  current: Config
): Promise<Record<string, McpConfig>> {
  const configs = validConfigMap(current.mcp)
  let changed = false
  for (const [name, config] of Object.entries(configs)) {
    const secrets = extractMcpSecrets(config)
    if (!secrets) continue
    setMcpSecrets(directory, name, secrets)
    changed = true
  }
  const safeConfigs = redactMcpConfigMap(configs)
  if (changed) {
    await unwrap<Config>(client.config.update({ query: { directory }, body: { ...current, mcp: safeConfigs } }))
  }
  return safeConfigs
}

export async function getMcpSnapshot(client: OpencodeClient, directory: string): Promise<McpSnapshot> {
  const [config, statuses] = await Promise.all([
    readServerConfig(client, directory),
    unwrap<Record<string, McpStatus>>(client.mcp.status({ query: { directory } }))
  ])
  const configs = await migrateWorkspaceMcpSecrets(client, directory, config)
  return { configs: publicMcpConfigMap(configs), statuses }
}

export async function addMcp(
  client: OpencodeClient,
  directory: string,
  nameArg: unknown,
  configArg: unknown,
  restart: Restart,
  getFreshClient: GetClient = () => client
): Promise<McpSnapshot> {
  const name = validateMcpName(nameArg)
  const config = validateMcpConfig(configArg)
  const secrets = extractMcpSecrets(config)
  if (secrets) setMcpSecrets(directory, name, secrets)
  const safeConfig = stripMcpSecrets(config)
  const current = await readServerConfig(client, directory).catch(() => undefined)
  const mutation: ConfigMutation = (configs) => mergeMcpConfig(redactMcpConfigMap(configs), name, safeConfig)
  const restarted = await persistMcpConfigs(
    client,
    directory,
    mutation(validConfigMap(current?.mcp)),
    restart,
    current,
    mutation
  )
  const activeClient = restarted ? getFreshClient() : client
  // The server receives credentials only in-memory after the safe workspace config is written.
  await unwrap(activeClient.mcp.add({ query: { directory }, body: { name, config: hydrateMcpConfig(safeConfig, secrets) } }))
  return getMcpSnapshot(activeClient, directory)
}

export async function removeMcp(
  client: OpencodeClient,
  directory: string,
  nameArg: unknown,
  restart: Restart,
  getFreshClient: GetClient = () => client
): Promise<McpSnapshot> {
  const name = validateMcpName(nameArg)
  const current = await readServerConfig(client, directory).catch(() => undefined)
  const mutation: ConfigMutation = (configs) => removeMcpConfig(configs, name)
  const configs = mutation(validConfigMap(current?.mcp))
  const restarted = await persistMcpConfigs(client, directory, configs, restart, current, mutation)
  if (!restarted) {
    await unwrap(client.mcp.disconnect({ path: { name }, query: { directory } })).catch(() => undefined)
  }
  deleteMcpSecrets(directory, name)
  return getMcpSnapshot(restarted ? getFreshClient() : client, directory)
}

export async function connectMcp(client: OpencodeClient, directory: string, nameArg: unknown): Promise<McpSnapshot> {
  const name = validateMcpName(nameArg)
  // A restarted OpenCode server only sees the redacted workspace config. Rehydrate this
  // connector in memory immediately before connecting; credentials never cross back to disk.
  const current = await readServerConfig(client, directory)
  const config = validConfigMap(current.mcp)[name]
  if (config) {
    await unwrap(client.mcp.add({
      query: { directory },
      body: { name, config: hydrateMcpConfig(stripMcpSecrets(config), getMcpSecrets(directory, name)) }
    }))
  }
  await unwrap(client.mcp.connect({ path: { name }, query: { directory } }))
  return getMcpSnapshot(client, directory)
}

export async function disconnectMcp(client: OpencodeClient, directory: string, nameArg: unknown): Promise<McpSnapshot> {
  const name = validateMcpName(nameArg)
  await unwrap(client.mcp.disconnect({ path: { name }, query: { directory } }))
  return getMcpSnapshot(client, directory)
}

export async function authMcp(
  client: OpencodeClient,
  directory: string,
  nameArg: unknown,
  openExternal: OpenExternal
): Promise<McpSnapshot> {
  const name = validateMcpName(nameArg)
  const auth = await unwrap<{ authorizationUrl: string }>(
    client.mcp.auth.start({ path: { name }, query: { directory } })
  )
  let url: URL
  try { url = new URL(auth.authorizationUrl) } catch { throw new Error('OpenCode returned an invalid MCP authorization URL.') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('MCP authorization URL must use HTTP or HTTPS.')
  }
  await openExternal(url.toString())
  return getMcpSnapshot(client, directory)
}
