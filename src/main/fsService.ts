/**
 * Phase 1 code surface — filesystem service (main process).
 *
 * Owns `oc:fs:tree`, `oc:fs:read`, `oc:fs:write`. The renderer never touches `node:fs`;
 * every path it supplies is resolved against the session `directory` and validated with
 * `assertSubpath` from ./projectsPaths (security invariant 1 — there is deliberately no
 * second containment check in this file).
 *
 * The tree is LAZY: depth 1 by default, hard-capped at 3, with per-directory and per-call
 * node budgets, so a 200k-file repository can never turn one IPC call into a full walk.
 */

import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { open, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import type { IpcMain } from 'electron'
import { assertSubpath } from './projectsPaths'

/* ------------------------------------------------------------------ */
/* shared types (mirrored in src/preload/index.ts for the renderer)     */
/* ------------------------------------------------------------------ */

export type GitFileStatus =
  | 'untracked'
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'conflicted'
  | 'ignored'

export type FileNode = {
  name: string
  /** POSIX-separated, ALWAYS relative to the session directory. */
  path: string
  kind: 'file' | 'dir'
  gitStatus: GitFileStatus | null
  /** Edited by the agent during this session; overlaid by the renderer. */
  touched: boolean
}

export type FileContent = {
  path: string
  text: string
  bytes: number
  /** True when the file exceeded MAX_READ_BYTES. */
  truncated: boolean
  /** sha256 of the on-disk bytes; the optimistic-concurrency token. */
  sha: string
  /** Monaco language id, inferred from extension. */
  language: string | null
}

/* ------------------------------------------------------------------ */
/* bounds                                                              */
/* ------------------------------------------------------------------ */

/** Security invariant 7 — `oc:fs:read` caps at 2 MiB of returned text. */
export const MAX_READ_BYTES = 2 * 1024 * 1024
/** Bytes inspected for a NUL when deciding "is this binary". */
const BINARY_SNIFF_BYTES = 8 * 1024
/** Refuse to even hash something this large; a review surface has no use for it. */
const MAX_HASHABLE_BYTES = 512 * 1024 * 1024
/** Largest text an editor panel may write back. */
const MAX_WRITE_BYTES = 8 * 1024 * 1024
/** Deepest lazy expansion a single tree call may perform. */
export const MAX_TREE_DEPTH = 3
/** Entries returned for any one directory. */
const MAX_ENTRIES_PER_DIR = 5000
/** Total nodes a single tree call may produce. */
const MAX_NODES_PER_CALL = 20000
/** Ignore-file size cap; a .gitignore beyond this is treated as absent. */
const MAX_IGNORE_FILE_BYTES = 256 * 1024

/* ------------------------------------------------------------------ */
/* argument validation (same style as src/main/ipc.ts)                  */
/* ------------------------------------------------------------------ */

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid IPC argument: ${name} must be a non-empty string.`)
  }
  return value
}

function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid IPC argument: ${name} must be an object.`)
  }
  return value as Record<string, unknown>
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid IPC argument: ${name} must be a string.`)
  }
  return value
}

/** Resolve and validate the session root. Never renderer-relative. */
export function requireDirectory(value: unknown, name = 'directory'): string {
  const dir = resolve(requireString(value, name))
  let info: ReturnType<typeof statSync>
  try {
    info = statSync(dir)
  } catch {
    throw new Error(`Directory does not exist: ${dir}`)
  }
  if (!info.isDirectory()) throw new Error(`Not a directory: ${dir}`)
  return dir
}

/** Native separators → POSIX. Only values crossing IPC use POSIX. */
export function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/')
}

/**
 * Resolve a renderer-supplied relative path inside `directory`.
 * Containment is delegated entirely to `assertSubpath`.
 */
export function resolveWithin(directory: string, relPath: string): { abs: string; rel: string } {
  const abs = assertSubpath(directory, relPath)
  return { abs, rel: toPosix(relative(directory, abs)) }
}

/* ------------------------------------------------------------------ */
/* .gitignore                                                          */
/* ------------------------------------------------------------------ */

type IgnoreRule = { re: RegExp; negate: boolean; dirOnly: boolean }

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Translate one gitignore pattern into a regex matching repo-root-relative POSIX paths.
 * `baseRel` is the POSIX directory (relative to the repo root) that owns the .gitignore.
 */
export function compileIgnorePattern(pattern: string, baseRel: string): IgnoreRule | null {
  let body = pattern
  if (body.startsWith('\\#') || body.startsWith('\\!')) body = body.slice(1)
  else if (body.startsWith('#')) return null
  // Trailing unescaped whitespace is not part of the pattern.
  body = body.replace(/(?<!\\)\s+$/, '')
  if (body.length === 0) return null

  let negate = false
  if (body.startsWith('!')) {
    negate = true
    body = body.slice(1)
  }
  if (body.length === 0) return null

  let dirOnly = false
  if (body.endsWith('/')) {
    dirOnly = true
    body = body.slice(0, -1)
  }
  if (body.length === 0) return null

  // A slash anywhere but the (already stripped) trailing one anchors the pattern.
  const anchored = body.includes('/')
  if (body.startsWith('/')) body = body.slice(1)

  let out = ''
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]
    if (ch === '\\' && i + 1 < body.length) {
      out += escapeRegExp(body[i + 1] as string)
      i += 1
    } else if (ch === '*' && body[i + 1] === '*') {
      if (body[i + 2] === '/') {
        out += '(?:[^/]+/)*'
        i += 2
      } else {
        out += '.*'
        i += 1
      }
    } else if (ch === '*') {
      out += '[^/]*'
    } else if (ch === '?') {
      out += '[^/]'
    } else if (ch === '[') {
      const close = body.indexOf(']', i + 1)
      if (close === -1) {
        out += '\\['
      } else {
        let cls = body.slice(i + 1, close)
        if (cls.startsWith('!')) cls = `^${cls.slice(1)}`
        out += `[${cls}]`
        i = close
      }
    } else {
      out += escapeRegExp(ch as string)
    }
  }

  const prefix = baseRel ? `${escapeRegExp(baseRel)}/` : ''
  const floating = anchored ? '' : '(?:.*/)?'
  return {
    re: new RegExp(`^${prefix}${floating}${out}(?:/.*)?$`),
    negate,
    dirOnly
  }
}

async function loadIgnoreRules(absDir: string, baseRel: string): Promise<IgnoreRule[]> {
  let raw: string
  try {
    const info = await stat(resolve(absDir, '.gitignore'))
    if (!info.isFile() || info.size > MAX_IGNORE_FILE_BYTES) return []
    raw = await readFile(resolve(absDir, '.gitignore'), 'utf8')
  } catch {
    return []
  }
  const rules: IgnoreRule[] = []
  for (const line of raw.split(/\r?\n/)) {
    const rule = compileIgnorePattern(line, baseRel)
    if (rule) rules.push(rule)
  }
  return rules
}

/** Last matching rule wins, exactly like git. Rules must be ordered shallow → deep. */
export function isIgnored(relPosix: string, isDir: boolean, rules: readonly IgnoreRule[]): boolean {
  let ignored = false
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue
    if (rule.re.test(relPosix)) ignored = !rule.negate
  }
  return ignored
}

/* ------------------------------------------------------------------ */
/* tree                                                                */
/* ------------------------------------------------------------------ */

function compareNodes(a: FileNode, b: FileNode): number {
  if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
  const byName = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  return byName !== 0 ? byName : a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

type TreeBudget = { remaining: number }

async function walk(
  root: string,
  absDir: string,
  relDir: string,
  depth: number,
  inherited: readonly IgnoreRule[],
  budget: TreeBudget
): Promise<FileNode[]> {
  const rules = inherited.concat(await loadIgnoreRules(absDir, relDir))

  let entries: Dirent[]
  try {
    entries = await readdir(absDir, { withFileTypes: true })
  } catch {
    return []
  }

  const nodes: FileNode[] = []
  const dirsToExpand: Array<{ node: FileNode; abs: string }> = []

  for (const entry of entries) {
    if (nodes.length >= MAX_ENTRIES_PER_DIR || budget.remaining <= 0) break
    const name = entry.name
    if (name === '.git') continue
    // Symlinks are never traversed or reported: assertSubpath rejects them on read/write,
    // so surfacing them in the tree would only produce unopenable rows.
    if (entry.isSymbolicLink()) continue
    const isDir = entry.isDirectory()
    if (!isDir && !entry.isFile()) continue

    const relPosix = relDir ? `${relDir}/${name}` : name
    if (isIgnored(relPosix, isDir, rules)) continue

    const node: FileNode = {
      name,
      path: relPosix,
      kind: isDir ? 'dir' : 'file',
      gitStatus: null,
      touched: false
    }
    nodes.push(node)
    budget.remaining -= 1
    if (isDir && depth > 1) dirsToExpand.push({ node, abs: resolve(absDir, name) })
  }

  nodes.sort(compareNodes)

  if (depth > 1) {
    for (const child of dirsToExpand) {
      if (budget.remaining <= 0) break
      const kids = await walk(root, child.abs, child.node.path, depth - 1, rules, budget)
      if (kids.length > 0) {
        // Children are appended flat after their parent so the renderer can render either
        // a flat virtualised list or rebuild nesting from `path`.
        const index = nodes.indexOf(child.node)
        nodes.splice(index + 1, 0, ...kids)
      }
    }
  }

  return nodes
}

/** `oc:fs:tree` implementation. */
export async function readTree(
  directory: string,
  path?: string,
  depth?: number
): Promise<FileNode[]> {
  const root = requireDirectory(directory)
  let absDir = root
  let relDir = ''
  if (path !== undefined && path !== null && String(path).trim().length > 0 && path !== '.') {
    const target = resolveWithin(root, String(path))
    const info = await stat(target.abs)
    if (!info.isDirectory()) throw new Error(`Not a directory: ${target.rel}`)
    absDir = target.abs
    relDir = target.rel
  }

  let wanted = 1
  if (depth !== undefined && depth !== null) {
    if (typeof depth !== 'number' || !Number.isFinite(depth)) {
      throw new Error('Invalid IPC argument: depth must be a number.')
    }
    wanted = Math.min(MAX_TREE_DEPTH, Math.max(1, Math.floor(depth)))
  }

  // Rules from every ancestor .gitignore between the root and the requested subdirectory.
  let inherited: IgnoreRule[] = []
  if (relDir) {
    let walkAbs = root
    let walkRel = ''
    inherited = inherited.concat(await loadIgnoreRules(walkAbs, walkRel))
    for (const segment of relDir.split('/')) {
      walkAbs = resolve(walkAbs, segment)
      walkRel = walkRel ? `${walkRel}/${segment}` : segment
      if (walkRel === relDir) break
      inherited = inherited.concat(await loadIgnoreRules(walkAbs, walkRel))
    }
  }

  return walk(root, absDir, relDir, wanted, inherited, { remaining: MAX_NODES_PER_CALL })
}

/* ------------------------------------------------------------------ */
/* read / write                                                        */
/* ------------------------------------------------------------------ */

const LANGUAGE_BY_EXT: Readonly<Record<string, string>> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  svg: 'xml',
  md: 'markdown',
  markdown: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  cfg: 'ini',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ps1: 'powershell',
  psm1: 'powershell',
  bat: 'bat',
  cmd: 'bat',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  dockerfile: 'dockerfile',
  vue: 'html',
  svelte: 'html'
}

/** Monaco language id for a POSIX-relative path, or null when unknown. */
export function languageForPath(relPosix: string): string | null {
  const base = (relPosix.split('/').pop() ?? '').toLowerCase()
  if (base === 'dockerfile') return 'dockerfile'
  if (base === 'makefile') return 'makefile'
  if (base.startsWith('.env')) return 'ini'
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return null
  return LANGUAGE_BY_EXT[base.slice(dot + 1)] ?? null
}

type HashedRead = { hash: string; head: Buffer; size: number; truncated: boolean }

/**
 * Stream the file once: hash every byte (the concurrency token must describe the WHOLE
 * file, not the truncated prefix) while retaining only the first MAX_READ_BYTES.
 */
async function hashAndHead(abs: string, keepBytes: number): Promise<HashedRead> {
  const info = await stat(abs)
  if (!info.isFile()) throw new Error('Only regular files can be read.')
  if (info.size > MAX_HASHABLE_BYTES) {
    throw new Error(`File is too large to open (${info.size} bytes).`)
  }

  const handle = await open(abs, 'r')
  try {
    const hash = createHash('sha256')
    const chunk = Buffer.allocUnsafe(64 * 1024)
    const kept: Buffer[] = []
    let keptBytes = 0
    let size = 0
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
      if (bytesRead === 0) break
      const slice = chunk.subarray(0, bytesRead)
      hash.update(slice)
      size += bytesRead
      if (keptBytes < keepBytes) {
        const take = Math.min(bytesRead, keepBytes - keptBytes)
        kept.push(Buffer.from(slice.subarray(0, take)))
        keptBytes += take
      }
    }
    return {
      hash: hash.digest('hex'),
      head: Buffer.concat(kept, keptBytes),
      size,
      truncated: size > keepBytes
    }
  } finally {
    await handle.close()
  }
}

/** sha256 of the on-disk bytes. */
export async function sha256OfFile(abs: string): Promise<string> {
  const { hash } = await hashAndHead(abs, 0)
  return hash
}

/** `oc:fs:read` implementation. */
export async function readFileContent(directory: string, path: string): Promise<FileContent> {
  const root = requireDirectory(directory)
  const { abs, rel } = resolveWithin(root, requireString(path, 'path'))
  const { hash, head, size, truncated } = await hashAndHead(abs, MAX_READ_BYTES)

  const sniff = head.subarray(0, BINARY_SNIFF_BYTES)
  if (sniff.includes(0)) {
    throw new Error(`Binary file cannot be opened as text: ${rel}`)
  }

  return {
    path: rel,
    text: head.toString('utf8'),
    bytes: size,
    truncated,
    sha: hash,
    language: languageForPath(rel)
  }
}

/**
 * `oc:fs:write` implementation. Optimistic concurrency: THROWS when the on-disk sha256
 * differs from `baseSha`, so an in-flight agent edit is never silently clobbered
 * (security invariant 6). The renderer catches and offers reload-or-overwrite.
 */
export async function writeFileContent(
  directory: string,
  path: string,
  text: string,
  baseSha: string
): Promise<{ sha: string }> {
  const root = requireDirectory(directory)
  const { abs, rel } = resolveWithin(root, requireString(path, 'path'))
  const expected = requireString(baseSha, 'baseSha')

  const bytes = Buffer.from(text, 'utf8')
  if (bytes.byteLength > MAX_WRITE_BYTES) {
    throw new Error(`Refusing to write ${bytes.byteLength} bytes; limit is ${MAX_WRITE_BYTES}.`)
  }

  const info = await stat(abs)
  if (!info.isFile()) throw new Error('Only regular files can be written.')

  const current = await sha256OfFile(abs)
  if (current !== expected) {
    throw new Error(
      `${rel} changed on disk since it was opened. Reload the file or overwrite deliberately.`
    )
  }

  await writeFile(abs, bytes)
  return { sha: createHash('sha256').update(bytes).digest('hex') }
}

/* ------------------------------------------------------------------ */
/* registration                                                        */
/* ------------------------------------------------------------------ */

export function register(ipc: IpcMain): void {
  ipc.handle('oc:fs:tree', async (_event, argsArg: unknown): Promise<FileNode[]> => {
    const args = requireObject(argsArg, 'fs tree args')
    const path = args.path === undefined || args.path === null ? undefined : requireText(args.path, 'path')
    const depth = args.depth === undefined || args.depth === null ? undefined : (args.depth as number)
    return readTree(requireString(args.directory, 'directory'), path, depth)
  })

  ipc.handle('oc:fs:read', async (_event, argsArg: unknown): Promise<FileContent> => {
    const args = requireObject(argsArg, 'fs read args')
    return readFileContent(
      requireString(args.directory, 'directory'),
      requireString(args.path, 'path')
    )
  })

  ipc.handle('oc:fs:write', async (_event, argsArg: unknown): Promise<{ sha: string }> => {
    const args = requireObject(argsArg, 'fs write args')
    return writeFileContent(
      requireString(args.directory, 'directory'),
      requireString(args.path, 'path'),
      requireText(args.text, 'text'),
      requireString(args.baseSha, 'baseSha')
    )
  })
}
