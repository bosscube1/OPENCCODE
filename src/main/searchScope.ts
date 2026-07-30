/**
 * Pure helpers for `oc:search:chats`'s optional third argument (scope resolution +
 * validation). Kept dependency-free (no `electron` import) so it can be unit tested
 * directly, unlike `ipc.ts` which pulls in the Electron runtime at module load.
 */

export type SearchScope = 'project' | 'all'

export type SearchOptions = { scope: SearchScope }

/**
 * Validate the optional `options` argument of `oc:search:chats`.
 * - `undefined` -> defaults to `{ scope: 'project' }` (byte-for-byte the old behaviour).
 * - otherwise must be an object with an optional `scope` of exactly `'project'` or `'all'`;
 *   any other value is rejected rather than silently coerced to `'project'`.
 */
export function parseSearchOptions(value: unknown): SearchOptions {
  if (value === undefined) return { scope: 'project' }
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid IPC argument: options must be an object.')
  }
  const scopeRaw = (value as Record<string, unknown>).scope
  if (scopeRaw === undefined) return { scope: 'project' }
  if (scopeRaw !== 'project' && scopeRaw !== 'all') {
    throw new Error(`Invalid IPC argument: options.scope must be "project" or "all", got ${String(scopeRaw)}.`)
  }
  return { scope: scopeRaw }
}

/**
 * Resolve the set of directories to search for a given scope.
 * - `'project'` -> just the active directory.
 * - `'all'` -> the active directory plus every known project directory, de-duplicated,
 *   with the active directory kept first so its results sort in naturally.
 *
 * De-duplication is case-insensitive and separator-insensitive: this is a Windows-first
 * app (ADR 0004), where `C:\Work` and `c:/work` are the same folder. Searching both would
 * surface every hit in that project twice.
 */
export function resolveSearchDirectories(
  directory: string,
  scope: SearchScope,
  projectDirectories: readonly string[]
): string[] {
  if (scope === 'project') return [directory]
  const seen = new Set<string>()
  const result: string[] = []
  for (const dir of [directory, ...projectDirectories]) {
    // The original spelling is what gets sent to the server; only the dedupe KEY is folded.
    const key = dir.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(dir)
  }
  return result
}
