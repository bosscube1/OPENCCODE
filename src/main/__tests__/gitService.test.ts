import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// gitService imports `IpcMain` as a type only; nothing from electron runs at import time.
vi.mock('electron', () => ({}))

// execFile is wrapped in a spy so individual tests can inject a git failure without
// touching the real harness (execFileSync below and the pass-through default stay real).
vi.mock('node:child_process', async (importOriginal) => {
  const mod = await importOriginal<typeof import('node:child_process')>()
  return { ...mod, execFile: vi.fn(mod.execFile) }
})

import {
  MAX_DIFF_LINES,
  checkout,
  commit,
  getDiff,
  getRemoteUrl,
  getStatus,
  isNotARepoError,
  isValidBranchName,
  listBranches,
  normalizeRemoteUrl,
  parsePorcelainStatus,
  parseUnifiedDiff,
  patchPaths,
  register,
  stageHunks,
  stagePaths,
  unstagePaths
} from '../gitService'

/* ------------------------------------------------------------------ */
/* real temp repo harness                                              */
/* ------------------------------------------------------------------ */

let repo = ''
let gitAvailable = true

function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

function file(rel: string, text: string): void {
  const abs = join(repo, ...rel.split('/'))
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, text)
}

beforeAll(() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true })
  } catch {
    gitAvailable = false
  }
})

beforeEach(() => {
  if (!gitAvailable) return
  repo = mkdtempSync(join(tmpdir(), 'oc-git-'))
  git('init', '--quiet', '--initial-branch=main')
  git('config', 'user.email', 'test@example.invalid')
  git('config', 'user.name', 'Test User')
  git('config', 'commit.gpgsign', 'false')
  file('README.md', 'hello\n')
  git('add', '--', 'README.md')
  git('commit', '--quiet', '--message', 'initial')
})

afterEach(() => {
  if (repo) rmSync(repo, { recursive: true, force: true })
  repo = ''
})

afterAll(() => {
  if (!gitAvailable) {
    // Surfaced rather than silently skipped.
    console.warn('git not found on PATH; repo-backed gitService tests did not run.')
  }
})

const itGit = (name: string, fn: () => void | Promise<void>): void => {
  it(name, async () => {
    if (!gitAvailable) return
    await fn()
  })
}

/**
 * Make the next (and only the next) execFile call invoke its callback with `message`
 * as the git stderr, simulating a git invocation that exited non-zero. Everything
 * after that one call falls through to the real execFile.
 */
function failNextGitCall(message: string): void {
  const mocked = execFile as unknown as {
    mockImplementationOnce: (fn: (...args: unknown[]) => void) => void
  }
  mocked.mockImplementationOnce((...args: unknown[]) => {
    const callback = args[args.length - 1] as (
      error: Error | null,
      stdout: Buffer,
      stderr: Buffer
    ) => void
    callback(new Error(message), Buffer.alloc(0), Buffer.from(message, 'utf8'))
  })
}

/* ------------------------------------------------------------------ */
/* status                                                              */
/* ------------------------------------------------------------------ */

describe('getStatus', () => {
  itGit('reports a clean repo with its branch', async () => {
    const status = await getStatus(repo)
    expect(status).not.toBeNull()
    expect(status!.branch).toBe('main')
    expect(status!.clean).toBe(true)
    expect(status!.entries).toEqual([])
    expect(status!.ahead).toBe(0)
    expect(status!.behind).toBe(0)
    expect(status!.upstream).toBeNull()
  })

  itGit('splits the staged and unstaged sides', async () => {
    file('README.md', 'hello world\n')
    file('new.txt', 'fresh\n')
    git('add', '--', 'README.md')
    file('README.md', 'hello world again\n')

    const status = await getStatus(repo)
    expect(status).not.toBeNull()
    expect(status!.clean).toBe(false)
    const readme = status!.entries.find((e) => e.path === 'README.md')
    expect(readme).toMatchObject({ index: 'modified', worktree: 'modified' })
    const fresh = status!.entries.find((e) => e.path === 'new.txt')
    expect(fresh).toMatchObject({ index: null, worktree: 'untracked' })
  })

  itGit('handles paths with spaces, quotes and UTF-8', async () => {
    file('a file with spaces.txt', 'x\n')
    file('日本語/メモ.md', 'x\n')
    // NTFS forbids `"` in filenames, so the quoted-path case is POSIX-only.
    if (process.platform !== 'win32') file('quote"name.txt', 'x\n')
    const paths = (await getStatus(repo))!.entries.map((e) => e.path)
    expect(paths).toContain('a file with spaces.txt')
    expect(paths).toContain('日本語/メモ.md')
    if (process.platform !== 'win32') expect(paths).toContain('quote"name.txt')
  })

  itGit('reports renames with their original path', async () => {
    git('mv', 'README.md', 'READYOU.md')
    const status = await getStatus(repo)
    expect(status).not.toBeNull()
    const entry = status!.entries.find((e) => e.index === 'renamed')
    expect(entry).toBeDefined()
    expect(entry?.path).toBe('READYOU.md')
    expect(entry?.renamedFrom).toBe('README.md')
  })
})

describe('parsePorcelainStatus', () => {
  it('parses branch, upstream and divergence', () => {
    const status = parsePorcelainStatus('## main...origin/main [ahead 2, behind 3]\0')
    expect(status).toMatchObject({ branch: 'main', upstream: 'origin/main', ahead: 2, behind: 3 })
  })

  it('parses an unborn branch and a detached HEAD', () => {
    expect(parsePorcelainStatus('## No commits yet on main\0').branch).toBe('main')
    expect(parsePorcelainStatus('## HEAD (no branch)\0').branch).toBe('HEAD (detached)')
  })

  it('maps conflict pairs to conflicted on both sides', () => {
    const status = parsePorcelainStatus('## main\0UU both.txt\0')
    expect(status.entries[0]).toMatchObject({
      path: 'both.txt',
      index: 'conflicted',
      worktree: 'conflicted'
    })
  })

  it('keeps a rename entry and its original path together', () => {
    const status = parsePorcelainStatus('## main\0R  new name.txt\0old name.txt\0?? other.txt\0')
    expect(status.entries).toHaveLength(2)
    expect(status.entries[0]).toMatchObject({
      path: 'new name.txt',
      index: 'renamed',
      renamedFrom: 'old name.txt'
    })
    expect(status.entries[1]?.path).toBe('other.txt')
  })
})

/* ------------------------------------------------------------------ */
/* non-repository directories (expected state, not an error)           */
/* ------------------------------------------------------------------ */

describe('isNotARepoError', () => {
  it('matches git non-repo failures, including dubious ownership', () => {
    expect(isNotARepoError(new Error('fatal: not a git repository (or any of the parent directories): .git'))).toBe(true)
    expect(isNotARepoError(new Error('fatal: detected dubious ownership in repository at /x'))).toBe(true)
  })

  it('does not match genuine faults', () => {
    expect(isNotARepoError(new Error('spawn git ENOENT'))).toBe(false)
    expect(isNotARepoError(new Error('git timed out'))).toBe(false)
    expect(isNotARepoError('plain string')).toBe(false)
  })
})

describe('non-repository directories', () => {
  itGit('getStatus resolves to null instead of throwing', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'oc-nongit-'))
    try {
      await expect(getStatus(plain)).resolves.toBeNull()
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })

  itGit('listBranches resolves to an empty list instead of throwing', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'oc-nongit-'))
    try {
      await expect(listBranches(plain)).resolves.toEqual([])
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })

  it('a "not a git repository" failure resolves to null, not a rejection', async () => {
    failNextGitCall('fatal: not a git repository (or any of the parent directories): .git')
    await expect(getStatus(tmpdir())).resolves.toBeNull()

    failNextGitCall('fatal: not a git repository (or any of the parent directories): .git')
    await expect(listBranches(tmpdir())).resolves.toEqual([])
  })

  it('a genuine git failure (binary missing, timeout, ...) still throws', async () => {
    failNextGitCall('spawn git ENOENT')
    await expect(getStatus(tmpdir())).rejects.toThrow(/ENOENT/)

    failNextGitCall('spawn git ENOENT')
    await expect(listBranches(tmpdir())).rejects.toThrow(/ENOENT/)
  })
})

/* ------------------------------------------------------------------ */
/* diff                                                                */
/* ------------------------------------------------------------------ */

describe('getDiff', () => {
  itGit('returns hunks for a worktree modification', async () => {
    file('README.md', 'hello\nsecond\n')
    const diff = await getDiff(repo, 'README.md', false)
    expect(diff.path).toBe('README.md')
    expect(diff.binary).toBe(false)
    expect(diff.hunks).toHaveLength(1)
    expect(diff.hunks[0]?.lines).toEqual([
      { kind: 'ctx', text: 'hello' },
      { kind: 'add', text: 'second' }
    ])
    expect(diff.hunks[0]?.id).toMatch(/^\d+-\d+$/)
  })

  itGit('returns the staged diff when staged is true', async () => {
    file('README.md', 'staged change\n')
    git('add', '--', 'README.md')
    file('README.md', 'worktree change\n')
    const staged = await getDiff(repo, 'README.md', true)
    expect(staged.hunks[0]?.lines.some((l) => l.kind === 'add' && l.text === 'staged change')).toBe(
      true
    )
  })

  itGit('synthesises an additions diff for an untracked file', async () => {
    file('brand-new.txt', 'one\ntwo\n')
    const diff = await getDiff(repo, 'brand-new.txt', false)
    expect(diff.hunks[0]?.lines).toEqual([
      { kind: 'add', text: 'one' },
      { kind: 'add', text: 'two' }
    ])
  })

  itGit('flags binary content instead of streaming it', async () => {
    writeFileSync(join(repo, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255]))
    git('add', '--', 'blob.bin')
    const diff = await getDiff(repo, 'blob.bin', true)
    expect(diff.binary).toBe(true)
    expect(diff.hunks).toEqual([])
  })

  itGit('rejects a path outside the session directory', async () => {
    await expect(getDiff(repo, '../outside.txt', false)).rejects.toThrow(/strictly inside/i)
  })
})

describe('parseUnifiedDiff', () => {
  it('caps at MAX_DIFF_LINES and REPORTS the truncation', () => {
    const body = Array.from({ length: MAX_DIFF_LINES + 500 }, (_, i) => `+line ${i}`).join('\n')
    const raw = `diff --git a/x.txt b/x.txt\n--- a/x.txt\n+++ b/x.txt\n@@ -0,0 +1,${MAX_DIFF_LINES + 500} @@\n${body}\n`
    const diff = parseUnifiedDiff(raw, 'x.txt')
    const total = diff.hunks.reduce((n, h) => n + h.lines.length, 0)
    expect(total).toBe(MAX_DIFF_LINES)
    // Capping silently is a data-loss trap: the user reviews a diff that looks
    // complete, stages "all hunks", and loses everything past the cap.
    expect(diff.truncated).toBe(true)
  })

  it('records "no newline at end of file" per side', () => {
    // Dropping this marker means accepting a file's final hunk silently appends a
    // newline the source never had.
    const newOnly = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n'
    expect(parseUnifiedDiff(newOnly, 'x').hunks[0]).toMatchObject({
      newNoEofNewline: true
    })
    expect(parseUnifiedDiff(newOnly, 'x').hunks[0].oldNoEofNewline).toBeUndefined()

    const oldOnly = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n'
    expect(parseUnifiedDiff(oldOnly, 'x').hunks[0].oldNoEofNewline).toBe(true)

    // A context line carries the marker for BOTH sides.
    const both = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-a\n+b\n c\n\\ No newline at end of file\n'
    const hunk = parseUnifiedDiff(both, 'x').hunks[0]
    expect(hunk.oldNoEofNewline).toBe(true)
    expect(hunk.newNoEofNewline).toBe(true)
  })

  it('does not flag truncation for a diff under the cap', () => {
    const raw = 'diff --git a/x.txt b/x.txt\n--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-a\n+b\n'
    expect(parseUnifiedDiff(raw, 'x.txt').truncated).toBe(false)
  })

  it('picks up renames as oldPath', () => {
    const raw = [
      'diff --git a/old.txt b/new.txt',
      'similarity index 90%',
      'rename from old.txt',
      'rename to new.txt',
      '--- a/old.txt',
      '+++ b/new.txt',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      ''
    ].join('\n')
    const diff = parseUnifiedDiff(raw, 'new.txt')
    expect(diff.path).toBe('new.txt')
    expect(diff.oldPath).toBe('old.txt')
  })

  it('marks binary output', () => {
    const raw = 'diff --git a/x.bin b/x.bin\nBinary files a/x.bin and b/x.bin differ\n'
    expect(parseUnifiedDiff(raw, 'x.bin')).toEqual({
      path: 'x.bin',
      binary: true,
      truncated: false,
      hunks: []
    })
  })
})

/* ------------------------------------------------------------------ */
/* stage / unstage / stageHunks                                        */
/* ------------------------------------------------------------------ */

describe('stage and unstage', () => {
  itGit('stages and unstages a path with spaces', async () => {
    file('a file.txt', 'x\n')
    let status = await stagePaths(repo, ['a file.txt'])
    expect(status).not.toBeNull()
    expect(status!.entries.find((e) => e.path === 'a file.txt')?.index).toBe('added')
    status = await unstagePaths(repo, ['a file.txt'])
    expect(status).not.toBeNull()
    expect(status!.entries.find((e) => e.path === 'a file.txt')?.worktree).toBe('untracked')
  })

  itGit('treats a leading-dash filename as a pathspec, never an option', async () => {
    // `--upload-pack=evil` as a FILE NAME must be staged as a file, not parsed as a flag.
    const name = '--upload-pack=evil'
    file(name, 'inert\n')
    const status = await stagePaths(repo, [name])
    expect(status).not.toBeNull()
    expect(status!.entries.find((e) => e.path === name)?.index).toBe('added')
  })

  itGit('rejects staging paths outside the session directory', async () => {
    await expect(stagePaths(repo, ['../../etc/passwd'])).rejects.toThrow(/strictly inside/i)
  })
})

describe('stageHunks', () => {
  itGit('applies a renderer patch over stdin', async () => {
    file('README.md', 'hello\nsecond\n')
    const patch = [
      'diff --git a/README.md b/README.md',
      '--- a/README.md',
      '+++ b/README.md',
      '@@ -1 +1,2 @@',
      ' hello',
      '+second',
      ''
    ].join('\n')
    const status = await stageHunks(repo, 'README.md', patch)
    expect(status).not.toBeNull()
    expect(status!.entries.find((e) => e.path === 'README.md')?.index).toBe('modified')
  })

  itGit('refuses a patch that reaches outside the target file', async () => {
    const patch = [
      'diff --git a/../../evil.txt b/../../evil.txt',
      '--- a/../../evil.txt',
      '+++ b/../../evil.txt',
      '@@ -0,0 +1 @@',
      '+pwned',
      ''
    ].join('\n')
    await expect(stageHunks(repo, 'README.md', patch)).rejects.toThrow(/strictly inside|unexpected/i)
    expect(existsSync(join(repo, '..', '..', 'evil.txt'))).toBe(false)
  })

  itGit('refuses a patch touching a different in-repo file', async () => {
    file('other.txt', 'x\n')
    const patch = [
      'diff --git a/other.txt b/other.txt',
      '--- a/other.txt',
      '+++ b/other.txt',
      '@@ -1 +1 @@',
      '-x',
      '+y',
      ''
    ].join('\n')
    await expect(stageHunks(repo, 'README.md', patch)).rejects.toThrow(/unexpected file/i)
  })
})

describe('patchPaths', () => {
  it('extracts paths from headers and drops /dev/null', () => {
    const patch = [
      'diff --git a/src/x.ts b/src/x.ts',
      '--- /dev/null',
      '+++ b/src/x.ts',
      '@@ -0,0 +1 @@',
      '+a'
    ].join('\n')
    expect(patchPaths(patch)).toEqual(['src/x.ts'])
  })
})

/* ------------------------------------------------------------------ */
/* commit / branches / checkout                                        */
/* ------------------------------------------------------------------ */

describe('commit', () => {
  itGit('commits staged work and returns the new sha', async () => {
    file('c.txt', 'x\n')
    await stagePaths(repo, ['c.txt'])
    const { sha } = await commit(repo, 'add c', false)
    expect(sha).toMatch(/^[0-9a-f]{40}$/)
    expect((await getStatus(repo))!.clean).toBe(true)
  })

  itGit('treats a message beginning with dashes as a message, not options', async () => {
    file('c.txt', 'x\n')
    await stagePaths(repo, ['c.txt'])
    await commit(repo, '--amend --force -m pwned', false)
    const log = git('log', '--format=%s', '-n', '1').trim()
    expect(log).toBe('--amend --force -m pwned')
    expect(git('rev-list', '--count', 'HEAD').trim()).toBe('2')
  })

  itGit('supports --amend', async () => {
    file('c.txt', 'x\n')
    await stagePaths(repo, ['c.txt'])
    await commit(repo, 'first message', false)
    await commit(repo, 'amended message', true)
    expect(git('log', '--format=%s', '-n', '1').trim()).toBe('amended message')
    expect(git('rev-list', '--count', 'HEAD').trim()).toBe('2')
  })
})

describe('branches and checkout', () => {
  itGit('lists local branches with the current one flagged', async () => {
    git('branch', 'feature/x')
    const branches = await listBranches(repo)
    expect(branches).toEqual(
      expect.arrayContaining([
        { name: 'main', current: true, remote: false },
        { name: 'feature/x', current: false, remote: false }
      ])
    )
  })

  itGit('creates and switches branches', async () => {
    const status = await checkout(repo, 'feature/new-thing', true)
    expect(status).not.toBeNull()
    expect(status!.branch).toBe('feature/new-thing')
    expect((await checkout(repo, 'main', false))!.branch).toBe('main')
  })
})

describe('branch-name validation (argument injection)', () => {
  it('rejects shell metacharacters, option-lookalikes and git-illegal names', () => {
    for (const bad of [
      '; rm -rf /',
      '--upload-pack=evil',
      '-b',
      '--force',
      'a b',
      'foo..bar',
      'foo~1',
      'foo^',
      'foo:bar',
      'foo?',
      'foo*',
      'foo[1]',
      'foo\\bar',
      'foo.lock',
      '/leading',
      'trailing/',
      'has//double',
      'ref@{0}',
      'HEAD',
      '',
      'a'.repeat(256),
      '.hidden/branch',
      'foo\nbar',
      'foo\x00bar'
    ]) {
      expect(isValidBranchName(bad), bad).toBe(false)
    }
  })

  it('accepts ordinary branch names', () => {
    for (const good of ['main', 'feature/x', 'release-1.2', 'user/fix_bug', 'v2']) {
      expect(isValidBranchName(good), good).toBe(true)
    }
  })

  itGit('a branch named "; rm -rf /" is inert — rejected, nothing executed', async () => {
    const sentinel = join(repo, 'README.md')
    await expect(checkout(repo, '; rm -rf /', true)).rejects.toThrow(/invalid branch name/i)
    await expect(checkout(repo, '--upload-pack=evil', false)).rejects.toThrow(
      /invalid branch name/i
    )
    expect(existsSync(sentinel)).toBe(true)
    expect((await getStatus(repo))!.branch).toBe('main')
  })
})

/* ------------------------------------------------------------------ */
/* remote URL                                                          */
/* ------------------------------------------------------------------ */

describe('normalizeRemoteUrl', () => {
  it('normalises scp-style, ssh and https remotes', () => {
    expect(normalizeRemoteUrl('git@github.com:bosscube1/OPENCCODE.git')).toBe(
      'https://github.com/bosscube1/OPENCCODE'
    )
    expect(normalizeRemoteUrl('ssh://git@github.com/owner/repo.git')).toBe(
      'https://github.com/owner/repo'
    )
    expect(normalizeRemoteUrl('https://github.com/owner/repo.git')).toBe(
      'https://github.com/owner/repo'
    )
  })

  it('strips embedded credentials', () => {
    expect(normalizeRemoteUrl('https://user:token@github.com/owner/repo.git')).toBe(
      'https://github.com/owner/repo'
    )
  })

  it('returns null for unusable remotes', () => {
    expect(normalizeRemoteUrl('')).toBeNull()
    expect(normalizeRemoteUrl('file:///tmp/repo.git')).toBeNull()
  })

  itGit('returns null when there is no origin, and the URL once set', async () => {
    expect(await getRemoteUrl(repo)).toBeNull()
    git('remote', 'add', 'origin', 'git@github.com:owner/repo.git')
    expect(await getRemoteUrl(repo)).toBe('https://github.com/owner/repo')
  })
})

/* ------------------------------------------------------------------ */
/* registration                                                        */
/* ------------------------------------------------------------------ */

describe('register', () => {
  it('registers exactly the nine git channels and validates arguments', async () => {
    const handlers = new Map<string, (event: unknown, args: unknown) => Promise<unknown>>()
    register({
      handle: (channel: string, fn: (event: unknown, args: unknown) => Promise<unknown>) => {
        handlers.set(channel, fn)
      }
    } as unknown as Parameters<typeof register>[0])

    expect([...handlers.keys()]).toEqual([
      'oc:git:status',
      'oc:git:diff',
      'oc:git:stage',
      'oc:git:unstage',
      'oc:git:stageHunks',
      'oc:git:commit',
      'oc:git:branches',
      'oc:git:checkout',
      'oc:git:remoteUrl'
    ])

    await expect(handlers.get('oc:git:status')!(null, '')).rejects.toThrow(/non-empty string/i)
    await expect(handlers.get('oc:git:diff')!(null, 'nope')).rejects.toThrow(/must be an object/i)
    await expect(
      handlers.get('oc:git:stage')!(null, { directory: tmpdir(), paths: [] })
    ).rejects.toThrow(/non-empty string array/i)
    await expect(
      handlers.get('oc:git:status')!(null, join(tmpdir(), 'definitely-not-here-xyz'))
    ).rejects.toThrow(/does not exist/i)

    if (gitAvailable) {
      await expect(handlers.get('oc:git:status')!(null, repo)).resolves.toMatchObject({
        branch: 'main'
      })
    }
  })

  it('exposes no push, force, or hard-reset channel', () => {
    const handlers: string[] = []
    register({
      handle: (channel: string) => {
        handlers.push(channel)
      }
    } as unknown as Parameters<typeof register>[0])
    expect(handlers.some((c) => /push|force|reset/i.test(c))).toBe(false)
  })
})
