/**
 * `oc:openEditor` — opens a file (optionally at a line/column) in the user's real external
 * editor, via a `vscode://file/...` deep link. This is the only place that constructs such a
 * URL: the renderer only ever sends a `{ path, line?, column? }` triple, never a URL, so
 * `shell.openExternal` can never be turned into an arbitrary-protocol gadget from the renderer.
 *
 * Security invariants (see CONTRACTS.md "Phase 1 — Code surface", invariant 5):
 *   - `path` is resolved against the session `directory` and validated with `assertSubpath`
 *     (reused from `./projectsPaths`, never re-implemented here).
 *   - Only an allowlisted URL scheme is ever produced.
 */
import type { IpcMain } from 'electron'
import { shell } from 'electron'
import { assertSubpath } from './projectsPaths'

/** Deep-link schemes this module is allowed to construct. Nothing else is ever produced. */
const ALLOWED_SCHEMES = ['vscode', 'vscode-insiders', 'cursor'] as const
type EditorScheme = (typeof ALLOWED_SCHEMES)[number]

const DEFAULT_SCHEME: EditorScheme = 'vscode'

// `oc:openEditor`'s renderer-facing args carry `directory`, like every other Phase 1 channel —
// main resolves containment against the directory the renderer supplies, not a tracked global.
export type OpenEditorArgs = {
  directory: string
  path: string
  line?: number
  column?: number
}

function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`Invalid IPC argument: ${name} must be an object.`)
  }
  return value as Record<string, unknown>
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid IPC argument: ${name} must be a non-empty string.`)
  }
  return value
}

function optionalPositiveInt(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid IPC argument: ${name} must be a positive integer.`)
  }
  return value
}

/**
 * Encode a filesystem path for the `vscode://file/<path>` URL form. Every path segment is
 * percent-encoded individually so drive-letter colons and separators survive untouched while
 * anything that could smuggle extra URL structure (spaces, `?`, `#`, `%`) is neutralised.
 */
function encodeFileUrlPath(absPath: string): string {
  const posix = absPath.replace(/\\/g, '/')
  return posix
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

function buildEditorUrl(scheme: EditorScheme, absPath: string, line?: number, column?: number): string {
  let url = `${scheme}://file/${encodeFileUrlPath(absPath)}`
  if (line !== undefined) {
    url += `:${line}`
    if (column !== undefined) url += `:${column}`
  }
  return url
}

/**
 * Resolves and opens `args.path` (relative to the active session directory) in the external
 * editor. Exported so a caller with validated `OpenEditorArgs` can invoke it without an IPC round
 * trip (e.g. from a test, or from another main-process entry point).
 */
export async function openEditor(args: OpenEditorArgs): Promise<void> {
  const absPath = assertSubpath(args.directory, args.path)
  const url = buildEditorUrl(DEFAULT_SCHEME, absPath, args.line, args.column)
  await shell.openExternal(url)
}

export function register(ipc: IpcMain): void {
  ipc.removeHandler('oc:openEditor')
  ipc.handle('oc:openEditor', async (_event, argsArg: unknown): Promise<void> => {
    const args = requireObject(argsArg, 'openEditor args')
    const directory = requireString(args.directory, 'directory')
    const path = requireString(args.path, 'path')
    const line = optionalPositiveInt(args.line, 'line')
    const column = optionalPositiveInt(args.column, 'column')
    await openEditor({ directory, path, line, column })
  })
}
