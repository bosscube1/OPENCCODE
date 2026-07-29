/**
 * Project-level OpenCode config (`opencode.json`) reads and scoped updates.
 *
 * Only the `permission` key is editable through this module. Updates go through the
 * server's `config.update` first; when that fails (e.g. an older server without the
 * endpoint) the project file is rewritten atomically and the server is restarted —
 * the same pattern as the MCP config path in mcp.ts.
 */
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Config, OpencodeClient } from '@opencode-ai/sdk'

export type PermissionLevel = 'ask' | 'allow' | 'deny'

/** The `permission` key of a project config — structurally `Config['permission']` from the SDK. */
export type PermissionConfig = {
  edit?: PermissionLevel
  bash?: PermissionLevel | Record<string, PermissionLevel>
  webfetch?: PermissionLevel
  doom_loop?: PermissionLevel
  external_directory?: PermissionLevel
}

type FieldsResult<T> = { data: T | undefined; error: unknown; response: Response }
type Restart = () => Promise<unknown>

const LEVELS: ReadonlySet<string> = new Set(['ask', 'allow', 'deny'])
const MAX_BASH_PATTERNS = 64
const MAX_PATTERN_LENGTH = 256

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorDetail(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (isRecord(error) && typeof error.message === 'string') return error.message
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

function requireLevel(value: unknown, field: string): PermissionLevel {
  if (typeof value === 'string' && LEVELS.has(value)) return value as PermissionLevel
  throw new Error(`Invalid permission config: ${field} must be "ask", "allow", or "deny".`)
}

function validateBashPatterns(value: Record<string, unknown>): Record<string, PermissionLevel> {
  const entries = Object.entries(value)
  if (entries.length > MAX_BASH_PATTERNS) {
    throw new Error(`Invalid permission config: bash may not exceed ${MAX_BASH_PATTERNS} patterns.`)
  }
  const patterns: Record<string, PermissionLevel> = {}
  for (const [pattern, level] of entries) {
    if (pattern.trim().length === 0 || pattern.length > MAX_PATTERN_LENGTH) {
      throw new Error('Invalid permission config: bash patterns must be 1-256 characters.')
    }
    patterns[pattern] = requireLevel(level, `bash["${pattern}"]`)
  }
  return patterns
}

/**
 * Strictly validate a renderer-supplied permission config. Unknown keys are rejected outright:
 * this object is written into the project's opencode.json, so nothing unvalidated passes through.
 */
export function validatePermissionConfig(value: unknown): PermissionConfig {
  if (!isRecord(value)) throw new Error('Invalid permission config: must be an object.')
  const out: PermissionConfig = {}
  for (const [key, raw] of Object.entries(value)) {
    switch (key) {
      case 'bash':
        out.bash = isRecord(raw) ? validateBashPatterns(raw) : requireLevel(raw, 'bash')
        break
      case 'edit':
      case 'webfetch':
      case 'doom_loop':
      case 'external_directory':
        out[key] = requireLevel(raw, key)
        break
      default:
        throw new Error(`Invalid permission config: unknown key "${key}".`)
    }
  }
  return out
}

/** The resolved `permission` key of the project config, or an empty object when unset. */
export async function getPermissionConfig(
  client: OpencodeClient,
  directory: string
): Promise<PermissionConfig> {
  const config = await unwrap<Config>(client.config.get({ query: { directory } }))
  return (config.permission ?? {}) as PermissionConfig
}

async function writePermissionFallback(
  directory: string,
  permission: PermissionConfig,
  restart: Restart
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
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify({ ...diskConfig, permission }, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
  await restart()
}

/**
 * Merge `permission` (and only that key) into the project config. Returns true when the
 * direct-file fallback ran — and the server was restarted — instead of `config.update`.
 */
export async function setPermissionConfig(
  client: OpencodeClient,
  directory: string,
  permission: PermissionConfig,
  restart: Restart
): Promise<boolean> {
  try {
    const base = await unwrap<Config>(client.config.get({ query: { directory } }))
    await unwrap<Config>(client.config.update({ query: { directory }, body: { ...base, permission } }))
    return false
  } catch {
    await writePermissionFallback(directory, permission, restart)
    return true
  }
}
