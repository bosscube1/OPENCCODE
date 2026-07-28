/**
 * Phase 1 code surface — git service (main process).
 *
 * Security posture (binding, see CONTRACTS.md "Security invariants"):
 *  - Invariant 1: every renderer-supplied path goes through `assertSubpath`.
 *  - Invariant 2: EVERY git invocation is an argv array through `execFile`/`spawn` with
 *    `shell: false`. There is no command-string concatenation anywhere in this file, so a
 *    branch literally named `; rm -rf /` or a file named `--upload-pack=evil` is inert.
 *    `--` separators are used wherever git accepts them so a leading-dash value can never
 *    be re-read as an option.
 *  - Invariant 3: no push, no `--force`, no `reset --hard`, no history rewriting beyond
 *    `commit --amend`.
 *  - Invariant 7: `oc:git:diff` caps at 5000 lines per file and reports `binary: true`
 *    rather than streaming blob bytes.
 */

import { execFile, spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import type { IpcMain } from 'electron'
import { assertSubpath } from './projectsPaths'

/* ------------------------------------------------------------------ */
/* shared types (mirrored in src/preload/index.ts for the renderer)     */
/*                                                                      */
/* Deliberately duplicated rather than imported from fsService.ts:      */
/* CONTRACTS.md requires that services never import each other.         */
/* ------------------------------------------------------------------ */

export type GitFileStatus =
  | 'untracked'
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'conflicted'
  | 'ignored'

export type DiffLine = { kind: 'ctx' | 'add' | 'del'; text: string }

export type Hunk = {
  /** Stable within one FileDiff: `${oldStart}-${newStart}`. */
  id: string
  /** "@@ -a,b +c,d @@" */
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
  /**
   * Set when the corresponding side ends without a trailing newline
   * ("\ No newline at end of file"). Load-bearing: without it, applying a
   * file's final hunk silently adds a newline that was never in the source.
   */
  oldNoEofNewline?: boolean
  newNoEofNewline?: boolean
}

export type FileDiff = {
  path: string
  /** Set on renames. */
  oldPath?: string
  /** When true, `hunks` is empty. */
  binary: boolean
  /**
   * True when the diff exceeded MAX_DIFF_LINES and hunks were dropped.
   *
   * The UI MUST surface this. A partial diff that looks complete is a data-loss
   * trap: the user reviews what is shown, stages "all hunks", and silently
   * loses every change past the cap.
   */
  truncated: boolean
  hunks: Hunk[]
}

export type GitStatusEntry = {
  path: string
  /** Staged side. */
  index: GitFileStatus | null
  /** Unstaged side. */
  worktree: GitFileStatus | null
  renamedFrom?: string
}

export type GitStatus = {
  branch: string
  upstream: string | null
  ahead: number
  behind: number
  entries: GitStatusEntry[]
  clean: boolean
}

export type GitBranch = { name: string; current: boolean; remote: boolean }

/* ------------------------------------------------------------------ */
/* bounds                                                              */
/* ------------------------------------------------------------------ */

/** Security invariant 7 — diff lines returned for one file. */
export const MAX_DIFF_LINES = 5000
const GIT_TIMEOUT_MS = 30_000
const GIT_MAX_BUFFER = 32 * 1024 * 1024
const MAX_PATHS_PER_CALL = 1000
const MAX_COMMIT_MESSAGE_BYTES = 64 * 1024
const MAX_PATCH_BYTES = 4 * 1024 * 1024
/** Untracked files larger than this are reported as a binary/oversize diff. */
const MAX_UNTRACKED_DIFF_BYTES = 2 * 1024 * 1024

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

function optionalBoolean(value: unknown, name: string): boolean {
  if (value === undefined || value === null) return false
  if (typeof value !== 'boolean') {
    throw new Error(`Invalid IPC argument: ${name} must be a boolean.`)
  }
  return value
}

function requirePathList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Invalid IPC argument: paths must be a non-empty string array.')
  }
  if (value.length > MAX_PATHS_PER_CALL) {
    throw new Error(`Invalid IPC argument: paths may not exceed ${MAX_PATHS_PER_CALL} entries.`)
  }
  return value.map((entry, i) => requireString(entry, `paths[${i}]`))
}

/** Native separators → POSIX. Only values crossing IPC use POSIX separators. */
function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/')
}

/** Resolve and validate the session root. */
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

/** Validate a renderer path against the session directory and return it POSIX-relative. */
export function relPathWithin(directory: string, path: string): string {
  const abs = assertSubpath(directory, path)
  return toPosix(relative(directory, abs))
}

/* ------------------------------------------------------------------ */
/* branch-name validation                                              */
/* ------------------------------------------------------------------ */

/**
 * Allowlist, not a blocklist. Rejects anything git itself forbids plus every value that
 * could be re-read as an option (leading `-`), so `--upload-pack=evil` never reaches git
 * even as an inert argv element.
 */
export function isValidBranchName(name: string): boolean {
  if (name.length === 0 || name.length > 255) return false
  if (name.startsWith('-')) return false
  if (name.startsWith('/') || name.endsWith('/')) return false
  if (name.endsWith('.') || name.endsWith('.lock')) return false
  if (name === '@' || name === 'HEAD') return false
  if (name.includes('..') || name.includes('//') || name.includes('@{')) return false
  // Control chars, whitespace, and git's reserved punctuation.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return false
  if (name.split('/').some((segment) => segment.length === 0 || segment.startsWith('.'))) {
    return false
  }
  return true
}

function requireBranchName(value: unknown): string {
  const name = requireString(value, 'branch')
  if (!isValidBranchName(name)) {
    throw new Error(`Invalid branch name: ${name}`)
  }
  return name
}

/* ------------------------------------------------------------------ */
/* process invocation                                                  */
/* ------------------------------------------------------------------ */

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // Never let git block the main process on an interactive credential/editor prompt.
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    GIT_EDITOR: 'true'
  }
}

export type GitRunResult = { stdout: string; stderr: string }

/**
 * Run git with an argv array. `shell` is never set; the args are passed to the process
 * verbatim, so no value in `args` can ever be interpreted by a shell.
 */
export function runGit(cwd: string, args: readonly string[]): Promise<GitRunResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=false', ...args],
      {
        cwd,
        shell: false,
        windowsHide: true,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        encoding: 'buffer',
        env: gitEnv()
      },
      (error, stdout, stderr) => {
        const out = (stdout as unknown as Buffer | undefined)?.toString('utf8') ?? ''
        const err = (stderr as unknown as Buffer | undefined)?.toString('utf8') ?? ''
        if (error) {
          const detail = err.trim() || out.trim() || error.message
          rejectPromise(new Error(`git ${args[0] ?? ''} failed: ${detail}`.trim()))
          return
        }
        resolvePromise({ stdout: out, stderr: err })
      }
    )
  })
}

/** Run git with a payload on stdin. Used only by `git apply --cached -`. */
function runGitWithStdin(cwd: string, args: readonly string[], input: string): Promise<GitRunResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('git', ['-c', 'core.quotepath=false', ...args], {
      cwd,
      shell: false,
      windowsHide: true,
      env: gitEnv()
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => child.kill(), GIT_TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      rejectPromise(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolvePromise({ stdout: out, stderr: err })
      else rejectPromise(new Error(`git ${args[0] ?? ''} failed: ${(err || out).trim()}`))
    })
    child.stdin.on('error', () => {
      /* the close handler reports the real failure */
    })
    child.stdin.end(input, 'utf8')
  })
}

/* ------------------------------------------------------------------ */
/* status                                                              */
/* ------------------------------------------------------------------ */

function mapStatusCode(code: string): GitFileStatus | null {
  switch (code) {
    case ' ':
      return null
    case 'M':
    case 'T':
      return 'modified'
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'added'
    case 'U':
      return 'conflicted'
    case '?':
      return 'untracked'
    case '!':
      return 'ignored'
    default:
      return null
  }
}

const CONFLICT_PAIRS = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

/**
 * Parse `git status --porcelain=v1 -z --branch`. NUL-delimited records mean paths with
 * spaces, quotes, and UTF-8 need no unquoting at all.
 */
export function parsePorcelainStatus(raw: string): GitStatus {
  const records = raw.split('\0')
  let branch = ''
  let upstream: string | null = null
  let ahead = 0
  let behind = 0
  const entries: GitStatusEntry[] = []

  for (let i = 0; i < records.length; i += 1) {
    const record = records[i] as string
    if (record.length === 0) continue

    if (record.startsWith('## ')) {
      const header = record.slice(3)
      const noCommits = /^No commits yet on (.+)$/.exec(header)
      if (noCommits) {
        branch = (noCommits[1] as string).split('...')[0] as string
        continue
      }
      if (header.startsWith('HEAD (no branch)')) {
        branch = 'HEAD (detached)'
        continue
      }
      const divergence = /\s\[(.+)\]$/.exec(header)
      const names = divergence ? header.slice(0, divergence.index) : header
      const [local, remote] = names.split('...')
      branch = (local ?? '').trim()
      upstream = remote ? remote.trim() : null
      if (divergence) {
        const info = divergence[1] as string
        const aheadMatch = /ahead (\d+)/.exec(info)
        const behindMatch = /behind (\d+)/.exec(info)
        if (aheadMatch) ahead = Number(aheadMatch[1])
        if (behindMatch) behind = Number(behindMatch[1])
      }
      continue
    }

    if (record.length < 4) continue
    const x = record[0] as string
    const y = record[1] as string
    const path = record.slice(3)
    const conflicted = CONFLICT_PAIRS.has(`${x}${y}`)

    // `??` / `!!` describe the worktree only — nothing about them is staged.
    const untrackedOnly = x === '?' || x === '!'
    const entry: GitStatusEntry = {
      path,
      index: conflicted ? 'conflicted' : untrackedOnly ? null : mapStatusCode(x),
      worktree: conflicted ? 'conflicted' : mapStatusCode(untrackedOnly ? x : y)
    }

    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      // In -z output the original path is its own record, immediately after the entry.
      const orig = records[i + 1]
      if (typeof orig === 'string') {
        entry.renamedFrom = orig
        i += 1
      }
    }

    entries.push(entry)
  }

  return { branch, upstream, ahead, behind, entries, clean: entries.length === 0 }
}

/**
 * True when git failed only because the directory is not a repository.
 *
 * A project folder with no git in it is an ordinary, expected state — managed
 * project directories start that way. It must read as "no repo here", not as an
 * error banner containing raw git output.
 */
export function isNotARepoError(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e)
  return /not a git repository|detected dubious ownership/i.test(message)
}

/** Returns null when `directory` is not a git repository. Mirrors `oc:vcs:get`. */
export async function getStatus(directory: string): Promise<GitStatus | null> {
  let stdout: string
  try {
    ;({ stdout } = await runGit(directory, [
      'status',
      '--porcelain=v1',
      '-z',
      '--branch',
      '--untracked-files=all'
    ]))
  } catch (e) {
    if (isNotARepoError(e)) return null
    throw e
  }
  return parsePorcelainStatus(stdout)
}

/* ------------------------------------------------------------------ */
/* diff                                                                */
/* ------------------------------------------------------------------ */

function stripPrefix(p: string): string {
  if (p === '/dev/null') return p
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2)
  return p
}

/**
 * Parse `git diff` unified output for a single file. Caps at MAX_DIFF_LINES emitted diff
 * lines; anything past the cap is dropped rather than streamed.
 */
export function parseUnifiedDiff(raw: string, fallbackPath: string): FileDiff {
  const diff: FileDiff = { path: fallbackPath, binary: false, truncated: false, hunks: [] }
  let current: Hunk | null = null
  let emitted = 0
  let capped = false

  for (const line of raw.replace(/\n$/, '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = null
      continue
    }
    if (line.startsWith('rename from ')) {
      diff.oldPath = stripPrefix(line.slice('rename from '.length))
      continue
    }
    if (line.startsWith('rename to ')) {
      diff.path = stripPrefix(line.slice('rename to '.length))
      continue
    }
    if (line.startsWith('copy from ')) {
      diff.oldPath = stripPrefix(line.slice('copy from '.length))
      continue
    }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      diff.binary = true
      diff.hunks = []
      return diff
    }
    if (line.startsWith('--- ')) {
      const p = stripPrefix(line.slice(4).trim())
      if (p !== '/dev/null' && !diff.oldPath) diff.oldPath = p
      continue
    }
    if (line.startsWith('+++ ')) {
      const p = stripPrefix(line.slice(4).trim())
      if (p !== '/dev/null') diff.path = p
      continue
    }
    if (line.startsWith('@@')) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
      if (!match) continue
      if (capped) {
        current = null
        continue
      }
      const oldStart = Number(match[1])
      const oldLines = match[2] === undefined ? 1 : Number(match[2])
      const newStart = Number(match[3])
      const newLines = match[4] === undefined ? 1 : Number(match[4])
      current = {
        id: `${oldStart}-${newStart}`,
        header: `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`,
        oldStart,
        oldLines,
        newStart,
        newLines,
        lines: []
      }
      diff.hunks.push(current)
      continue
    }
    if (!current) continue
    if (line.startsWith('\\')) {
      // "\ No newline at end of file" applies to the line just emitted. Dropping it
      // loses information the renderer needs: accepting a file's final hunk would
      // then silently append a trailing newline the user never asked for. A context
      // line means neither side has one; otherwise it belongs to that one side.
      const last = current.lines[current.lines.length - 1]
      if (last?.kind === 'del') current.oldNoEofNewline = true
      else if (last?.kind === 'add') current.newNoEofNewline = true
      else if (last?.kind === 'ctx') {
        current.oldNoEofNewline = true
        current.newNoEofNewline = true
      }
      continue
    }
    if (emitted >= MAX_DIFF_LINES) {
      capped = true
      current = null
      continue
    }
    const marker = line[0]
    if (marker === '+') current.lines.push({ kind: 'add', text: line.slice(1) })
    else if (marker === '-') current.lines.push({ kind: 'del', text: line.slice(1) })
    else if (marker === ' ' || line.length === 0) current.lines.push({ kind: 'ctx', text: line.slice(1) })
    else continue
    emitted += 1
  }

  if (diff.oldPath === diff.path) delete diff.oldPath
  diff.truncated = capped
  return diff
}

/** Synthesise an all-additions diff for an untracked file (git diff shows nothing for it). */
async function untrackedDiff(directory: string, relPath: string): Promise<FileDiff> {
  const abs = assertSubpath(directory, relPath)
  const info = await stat(abs)
  if (!info.isFile() || info.size > MAX_UNTRACKED_DIFF_BYTES) {
    return { path: relPath, binary: true, truncated: false, hunks: [] }
  }
  const buffer = await readFile(abs)
  if (buffer.subarray(0, 8 * 1024).includes(0)) {
    return { path: relPath, binary: true, truncated: false, hunks: [] }
  }
  const text = buffer.toString('utf8')
  const all = text.length === 0 ? [] : text.replace(/\n$/, '').split('\n')
  const lines: DiffLine[] = all
    .slice(0, MAX_DIFF_LINES)
    .map((text_) => ({ kind: 'add' as const, text: text_ }))
  if (lines.length === 0) return { path: relPath, binary: false, truncated: false, hunks: [] }
  return {
    path: relPath,
    binary: false,
    // `all` was sliced to MAX_DIFF_LINES above; anything beyond that was dropped.
    truncated: all.length > MAX_DIFF_LINES,
    hunks: [
      {
        id: `0-1`,
        header: `@@ -0,0 +1,${lines.length} @@`,
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: lines.length,
        lines
      }
    ]
  }
}

export async function getDiff(
  directory: string,
  path: string,
  staged: boolean
): Promise<FileDiff> {
  const rel = relPathWithin(directory, path)
  const args = ['diff', '--no-color', '--no-ext-diff', '--find-renames', '-U3']
  if (staged) args.push('--cached')
  args.push('--', rel)
  const { stdout } = await runGit(directory, args)
  if (stdout.trim().length === 0 && !staged) {
    const status = await getStatus(directory)
    const entry = status?.entries.find((e) => e.path === rel)
    if (entry && entry.worktree === 'untracked') return untrackedDiff(directory, rel)
  }
  if (stdout.trim().length === 0) return { path: rel, binary: false, truncated: false, hunks: [] }
  return parseUnifiedDiff(stdout, rel)
}

/* ------------------------------------------------------------------ */
/* stage / unstage / stageHunks                                        */
/* ------------------------------------------------------------------ */

export async function stagePaths(directory: string, paths: readonly string[]): Promise<GitStatus | null> {
  // Containment is enforced here, not only at the IPC boundary, so the exported
  // function is safe for any caller.
  const rels = paths.map((p) => relPathWithin(directory, p))
  // `--` guarantees a file named `-f` is treated as a pathspec, never an option.
  await runGit(directory, ['add', '--all', '--', ...rels])
  return getStatus(directory)
}

export async function unstagePaths(directory: string, paths: readonly string[]): Promise<GitStatus | null> {
  const rels = paths.map((p) => relPathWithin(directory, p))
  try {
    await runGit(directory, ['restore', '--staged', '--', ...rels])
  } catch {
    // Older git, or an unborn HEAD where `restore --staged` has no source.
    await runGit(directory, ['reset', '--quiet', '--', ...rels]).catch(async () => {
      await runGit(directory, ['rm', '--cached', '--quiet', '-r', '--', ...rels])
    })
  }
  return getStatus(directory)
}

/** Paths a unified diff touches, with a/ b/ prefixes stripped and /dev/null dropped. */
export function patchPaths(patch: string): string[] {
  const found = new Set<string>()
  for (const line of patch.split('\n')) {
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      const p = stripPrefix(line.slice(4).trim().split('\t')[0] as string)
      if (p !== '/dev/null' && p.length > 0) found.add(p)
    } else if (line.startsWith('diff --git ')) {
      for (const token of line.slice('diff --git '.length).split(' ')) {
        const p = stripPrefix(token.trim())
        if (p !== '/dev/null' && p.length > 0) found.add(p)
      }
    }
  }
  return [...found]
}

/**
 * Apply a renderer-built unified diff to the index via `git apply --cached -` over STDIN.
 * The patch never becomes a temp file path supplied by the renderer.
 */
export async function stageHunks(
  directory: string,
  path: string,
  patch: string
): Promise<GitStatus | null> {
  const rel = relPathWithin(directory, path)
  if (Buffer.byteLength(patch, 'utf8') > MAX_PATCH_BYTES) {
    throw new Error('Patch is too large to apply.')
  }
  const referenced = patchPaths(patch)
  if (referenced.length === 0) throw new Error('Patch does not reference any file.')
  // Defense in depth: git apply already refuses to leave the work tree, but every
  // referenced path is containment-checked here as well, and must be the target file.
  for (const candidate of referenced) {
    const candidateRel = relPathWithin(directory, candidate)
    if (candidateRel !== rel) {
      throw new Error(`Patch references an unexpected file: ${candidate}`)
    }
  }
  await runGitWithStdin(directory, ['apply', '--cached', '--whitespace=nowarn', '-'], patch)
  return getStatus(directory)
}

/* ------------------------------------------------------------------ */
/* commit / branches / checkout / remote                               */
/* ------------------------------------------------------------------ */

export async function commit(
  directory: string,
  message: string,
  amend: boolean
): Promise<{ sha: string }> {
  if (Buffer.byteLength(message, 'utf8') > MAX_COMMIT_MESSAGE_BYTES) {
    throw new Error('Commit message is too long.')
  }
  // `--message` takes the next argv element as its value, so a message beginning with
  // `--` can never be re-read as an option.
  const args = ['commit', '--message', message]
  if (amend) args.push('--amend')
  await runGit(directory, args)
  const { stdout } = await runGit(directory, ['rev-parse', 'HEAD'])
  return { sha: stdout.trim() }
}

export async function listBranches(directory: string): Promise<GitBranch[]> {
  let stdout: string
  try {
    ;({ stdout } = await runGit(directory, [
      'for-each-ref',
      '--format=%(refname)%09%(refname:short)%09%(HEAD)',
      'refs/heads',
      'refs/remotes'
    ]))
  } catch (e) {
    // No repo means no branches, not a failure worth surfacing.
    if (isNotARepoError(e)) return []
    throw e
  }
  const branches: GitBranch[] = []
  for (const line of stdout.split('\n')) {
    if (line.trim().length === 0) continue
    const [refname, short, head] = line.split('\t')
    if (!refname || !short) continue
    const remote = refname.startsWith('refs/remotes/')
    if (remote && short.endsWith('/HEAD')) continue
    branches.push({ name: short, current: head === '*', remote })
  }
  return branches
}

export async function checkout(
  directory: string,
  branch: string,
  create: boolean
): Promise<GitStatus | null> {
  // Validated here as well as at the IPC boundary; a name that survives this cannot
  // start with `-`, so it can never be re-read as an option.
  if (!isValidBranchName(branch)) throw new Error(`Invalid branch name: ${branch}`)
  const args = create ? ['checkout', '-b', branch] : ['checkout', branch]
  await runGit(directory, args)
  return getStatus(directory)
}

/** Normalise any remote URL to a browsable https URL, or null when there isn't one. */
export function normalizeRemoteUrl(raw: string): string | null {
  const value = raw.trim()
  if (value.length === 0) return null

  // scp-like syntax: git@host:owner/repo.git
  const scp = /^(?:([^@/\s]+)@)?([^:/\s]+):(?!\/)(.+)$/.exec(value)
  if (scp && !value.includes('://')) {
    const host = scp[2] as string
    const path = (scp[3] as string).replace(/\.git$/, '').replace(/^\/+/, '')
    return `https://${host}/${path}`
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  const protocol = url.protocol.replace(/:$/, '')
  if (!['http', 'https', 'ssh', 'git', 'git+ssh'].includes(protocol)) return null
  const path = url.pathname.replace(/\.git$/, '').replace(/\/+$/, '')
  const port = url.port && url.port !== '22' && url.port !== '443' ? `:${url.port}` : ''
  return `https://${url.hostname}${port}${path}`
}

export async function getRemoteUrl(directory: string): Promise<string | null> {
  let raw: string
  try {
    const { stdout } = await runGit(directory, ['remote', 'get-url', 'origin'])
    raw = stdout
  } catch {
    try {
      const { stdout } = await runGit(directory, ['config', '--get', 'remote.origin.url'])
      raw = stdout
    } catch {
      return null
    }
  }
  return normalizeRemoteUrl(raw)
}

/* ------------------------------------------------------------------ */
/* registration                                                        */
/* ------------------------------------------------------------------ */

export function register(ipc: IpcMain): void {
  ipc.handle('oc:git:status', async (_event, directoryArg: unknown): Promise<GitStatus | null> => {
    return getStatus(requireDirectory(directoryArg))
  })

  ipc.handle('oc:git:diff', async (_event, argsArg: unknown): Promise<FileDiff> => {
    const args = requireObject(argsArg, 'git diff args')
    const directory = requireDirectory(args.directory)
    return getDiff(directory, requireString(args.path, 'path'), optionalBoolean(args.staged, 'staged'))
  })

  ipc.handle('oc:git:stage', async (_event, argsArg: unknown): Promise<GitStatus | null> => {
    const args = requireObject(argsArg, 'git stage args')
    const directory = requireDirectory(args.directory)
    return stagePaths(directory, requirePathList(args.paths))
  })

  ipc.handle('oc:git:unstage', async (_event, argsArg: unknown): Promise<GitStatus | null> => {
    const args = requireObject(argsArg, 'git unstage args')
    const directory = requireDirectory(args.directory)
    return unstagePaths(directory, requirePathList(args.paths))
  })

  ipc.handle('oc:git:stageHunks', async (_event, argsArg: unknown): Promise<GitStatus | null> => {
    const args = requireObject(argsArg, 'git stageHunks args')
    const directory = requireDirectory(args.directory)
    return stageHunks(
      directory,
      requireString(args.path, 'path'),
      requireString(args.patch, 'patch')
    )
  })

  ipc.handle('oc:git:commit', async (_event, argsArg: unknown): Promise<{ sha: string }> => {
    const args = requireObject(argsArg, 'git commit args')
    const directory = requireDirectory(args.directory)
    return commit(
      directory,
      requireString(args.message, 'message'),
      optionalBoolean(args.amend, 'amend')
    )
  })

  ipc.handle('oc:git:branches', async (_event, directoryArg: unknown): Promise<GitBranch[]> => {
    return listBranches(requireDirectory(directoryArg))
  })

  ipc.handle('oc:git:checkout', async (_event, argsArg: unknown): Promise<GitStatus | null> => {
    const args = requireObject(argsArg, 'git checkout args')
    const directory = requireDirectory(args.directory)
    return checkout(directory, requireBranchName(args.branch), optionalBoolean(args.create, 'create'))
  })

  ipc.handle('oc:git:remoteUrl', async (_event, directoryArg: unknown): Promise<string | null> => {
    return getRemoteUrl(requireDirectory(directoryArg))
  })
}
