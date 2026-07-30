import { describe, expect, it, vi } from 'vitest'
import {
  MAX_CONTEXT_CHARS,
  MAX_LISTED_FILES,
  collectProjectContext,
  formatProjectContext,
  type LiveContextApi,
  type ProjectContextInput
} from '../liveContext'
import type { FileDiff, GitStatus, GitStatusEntry, Hunk } from '../../../../preload'

function status(overrides: Partial<GitStatus> = {}): GitStatus {
  return { branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, entries: [], clean: true, ...overrides }
}

function entry(overrides: Partial<GitStatusEntry> = {}): GitStatusEntry {
  return { path: 'src/foo.ts', index: null, worktree: 'modified', ...overrides }
}

function hunk(overrides: Partial<Hunk> = {}): Hunk {
  return {
    id: '1-1',
    header: '@@ -1,1 +1,1 @@',
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 1,
    lines: [
      { kind: 'del', text: 'old line' },
      { kind: 'add', text: 'new line' }
    ],
    ...overrides
  }
}

function fileDiff(overrides: Partial<FileDiff> = {}): FileDiff {
  return { path: 'src/foo.ts', binary: false, truncated: false, hunks: [hunk()], ...overrides }
}

describe('formatProjectContext', () => {
  it('formats a repo with changes and a diff', () => {
    const input: ProjectContextInput = {
      directory: '/repo',
      status: status({ clean: false, entries: [entry()], ahead: 2, behind: 1 }),
      diffs: [{ path: 'src/foo.ts', patch: '-old line\n+new line\n' }]
    }
    const text = formatProjectContext(input)
    expect(text).toContain('Project context for /repo:')
    expect(text).toContain('Branch: main')
    expect(text).toContain('2 ahead / 1 behind')
    expect(text).toContain('Changed files (1):')
    expect(text).toContain('modified src/foo.ts')
    expect(text).toContain('--- src/foo.ts')
    expect(text).toContain('+new line')
  })

  it('reports a clean repo', () => {
    const text = formatProjectContext({ directory: '/repo', status: status({ clean: true }), diffs: [] })
    expect(text).toContain('no uncommitted changes')
  })

  it('reports a non-repo directory without throwing', () => {
    const text = formatProjectContext({ directory: '/not-a-repo', status: null, diffs: [] })
    expect(text).toContain('Project context for /not-a-repo:')
    expect(text).toContain('not a git repository')
  })

  it('truncates the file list past MAX_LISTED_FILES with an "and N more" marker', () => {
    const entries = Array.from({ length: MAX_LISTED_FILES + 5 }, (_, i) => entry({ path: `file${i}.ts` }))
    const text = formatProjectContext({
      directory: '/repo',
      status: status({ clean: false, entries }),
      diffs: []
    })
    expect(text).toContain('…and 5 more')
    const listedFileLines = text.split('\n').filter((l) => l.startsWith('- modified file'))
    expect(listedFileLines.length).toBe(MAX_LISTED_FILES)
  })

  it('truncates oversized output at a line boundary with a clear marker', () => {
    const bigDiffs = Array.from({ length: 50 }, (_, i) => ({
      path: `big${i}.ts`,
      patch: 'x'.repeat(500)
    }))
    const text = formatProjectContext({ directory: '/repo', status: status({ clean: true }), diffs: bigDiffs })
    expect(text.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS)
    expect(text).toContain('[context truncated]')
    expect(text.endsWith('[context truncated]')).toBe(true)
  })

  it('never exceeds MAX_CONTEXT_CHARS regardless of input size', () => {
    const bigDiffs = Array.from({ length: 200 }, (_, i) => ({
      path: `f${i}.ts`,
      patch: 'y'.repeat(1000)
    }))
    const text = formatProjectContext({ directory: '/repo', status: null, diffs: bigDiffs })
    expect(text.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS)
  })
})

describe('collectProjectContext', () => {
  function makeApi(overrides: Partial<LiveContextApi> = {}): LiveContextApi {
    return {
      git: {
        status: vi.fn().mockResolvedValue(status({ clean: false, entries: [entry()] })),
        diff: vi.fn().mockResolvedValue(fileDiff())
      },
      ...overrides
    } as LiveContextApi
  }

  it('happy path includes branch and a diff', async () => {
    const api = makeApi()
    const text = await collectProjectContext(api, '/repo')
    expect(text).toContain('Branch: main')
    expect(text).toContain('--- src/foo.ts')
    expect(api.git.diff).toHaveBeenCalledWith({ directory: '/repo', path: 'src/foo.ts' })
  })

  it('returns a fallback and does not throw when status rejects', async () => {
    const api = makeApi({ git: { status: vi.fn().mockRejectedValue(new Error('boom')), diff: vi.fn() } })
    const text = await collectProjectContext(api, '/repo')
    expect(text).toContain('could not read git status')
  })

  it('skips a file whose diff rejects but keeps the others', async () => {
    const entries = [entry({ path: 'a.ts' }), entry({ path: 'b.ts' })]
    const diff = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(fileDiff({ path: 'b.ts' }))
    const api = makeApi({
      git: { status: vi.fn().mockResolvedValue(status({ clean: false, entries })), diff }
    })
    const text = await collectProjectContext(api, '/repo')
    expect(text).toContain('--- b.ts')
    expect(text).not.toContain('--- a.ts')
  })

  it('respects maxDiffFiles', async () => {
    const entries = [entry({ path: 'a.ts' }), entry({ path: 'b.ts' }), entry({ path: 'c.ts' })]
    const diff = vi.fn().mockResolvedValue(fileDiff())
    const api = makeApi({
      git: { status: vi.fn().mockResolvedValue(status({ clean: false, entries })), diff }
    })
    await collectProjectContext(api, '/repo', { maxDiffFiles: 1 })
    expect(diff).toHaveBeenCalledTimes(1)
  })
})
