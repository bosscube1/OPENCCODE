import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// fsService only imports `IpcMain` as a type, so nothing from electron is evaluated at
// runtime. The mock is kept so the module graph stays inert if that ever changes.
vi.mock('electron', () => ({}))

import {
  MAX_READ_BYTES,
  MAX_TREE_DEPTH,
  compileIgnorePattern,
  isIgnored,
  languageForPath,
  readFileContent,
  readTree,
  register,
  writeFileContent
} from '../fsService'

let root = ''

function write(rel: string, text: string): void {
  const abs = join(root, ...rel.split('/'))
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, text)
}

function sha(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oc-fs-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('readTree', () => {
  beforeEach(() => {
    write('README.md', '# hi\n')
    write('src/index.ts', 'export const a = 1\n')
    write('src/nested/deep/file.ts', 'export const b = 2\n')
    write('node_modules/pkg/index.js', 'module.exports = {}\n')
    write('dist/bundle.js', 'x\n')
    write('.gitignore', 'node_modules/\ndist\n')
    mkdirSync(join(root, '.git'), { recursive: true })
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  })

  it('lists one level by default, dirs first then name, POSIX paths', async () => {
    const nodes = await readTree(root)
    expect(nodes.map((n) => n.path)).toEqual(['src', '.gitignore', 'README.md'])
    expect(nodes[0]).toMatchObject({ kind: 'dir', gitStatus: null, touched: false })
    expect(nodes.every((n) => !n.path.includes('\\'))).toBe(true)
  })

  it('never recurses at depth 1 (lazy by default)', async () => {
    const nodes = await readTree(root)
    expect(nodes.some((n) => n.path.startsWith('src/'))).toBe(false)
  })

  it('honours .gitignore and always hides .git', async () => {
    const nodes = await readTree(root, undefined, 3)
    const paths = nodes.map((n) => n.path)
    expect(paths).not.toContain('node_modules')
    expect(paths).not.toContain('dist')
    expect(paths.some((p) => p.startsWith('.git/'))).toBe(false)
    expect(paths).toContain('src/index.ts')
    // depth 3 == root -> src -> nested -> deep; `deep`'s own children are level 4.
    expect(paths).toContain('src/nested/deep')
    expect(paths).not.toContain('src/nested/deep/file.ts')
  })

  it('supports gitignore negation and nested ignore files', async () => {
    write('.gitignore', '*.log\n!keep.log\n')
    write('a.log', 'x')
    write('keep.log', 'x')
    write('logs/.gitignore', '!*.log\n')
    write('logs/inner.log', 'x')
    const paths = (await readTree(root, undefined, 3)).map((n) => n.path)
    expect(paths).not.toContain('a.log')
    expect(paths).toContain('keep.log')
    expect(paths).toContain('logs/inner.log')
  })

  it('clamps depth to MAX_TREE_DEPTH and rejects non-numeric depth', async () => {
    const deep = await readTree(root, undefined, 99)
    expect(deep.length).toBeGreaterThan(0)
    expect(MAX_TREE_DEPTH).toBe(3)
    await expect(readTree(root, undefined, 'lots' as unknown as number)).rejects.toThrow(
      /depth must be a number/i
    )
  })

  it('scopes to a subdirectory and rejects traversal out of the session directory', async () => {
    const nodes = await readTree(root, 'src', 1)
    expect(nodes.map((n) => n.path)).toEqual(['src/nested', 'src/index.ts'])
    await expect(readTree(root, '../')).rejects.toThrow(/strictly inside/i)
    await expect(readTree(root, '..\\..\\Windows')).rejects.toThrow(/strictly inside/i)
    await expect(readTree(root, tmpdir())).rejects.toThrow(/strictly inside/i)
  })

  it('omits symlinked entries', () => {
    const outside = mkdtempSync(join(tmpdir(), 'oc-fs-outside-'))
    try {
      symlinkSync(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      return // Windows without developer mode cannot create links.
    }
    return readTree(root).then((nodes) => {
      expect(nodes.map((n) => n.name)).not.toContain('linked')
      rmSync(outside, { recursive: true, force: true })
    })
  })
})

describe('readFileContent', () => {
  it('returns text, byte count, sha256 and an inferred language', async () => {
    write('src/app.ts', 'const x = 1\n')
    const file = await readFileContent(root, 'src/app.ts')
    expect(file).toMatchObject({
      path: 'src/app.ts',
      text: 'const x = 1\n',
      bytes: 12,
      truncated: false,
      language: 'typescript'
    })
    expect(file.sha).toBe(sha('const x = 1\n'))
  })

  it('handles UTF-8 names and content', async () => {
    write('日本語/ファイル.md', '# 見出し\n')
    const file = await readFileContent(root, '日本語/ファイル.md')
    expect(file.text).toBe('# 見出し\n')
    expect(file.language).toBe('markdown')
  })

  it('refuses binaries detected by a NUL byte in the first 8 KB', async () => {
    writeFileSync(join(root, 'blob.bin'), Buffer.from([0x41, 0x42, 0x00, 0x43]))
    await expect(readFileContent(root, 'blob.bin')).rejects.toThrow(/binary/i)
  })

  it('truncates past MAX_READ_BYTES but still hashes the whole file', async () => {
    const big = 'a'.repeat(MAX_READ_BYTES + 1024)
    writeFileSync(join(root, 'big.txt'), big)
    const file = await readFileContent(root, 'big.txt')
    expect(file.truncated).toBe(true)
    expect(file.text.length).toBe(MAX_READ_BYTES)
    expect(file.bytes).toBe(MAX_READ_BYTES + 1024)
    expect(file.sha).toBe(sha(big))
  })

  it('rejects traversal and absolute escapes', async () => {
    await expect(readFileContent(root, '../secret.txt')).rejects.toThrow(/strictly inside/i)
    await expect(readFileContent(root, '..\\..\\hosts')).rejects.toThrow(/strictly inside/i)
    await expect(readFileContent(root, join(tmpdir(), 'x.txt'))).rejects.toThrow(/strictly inside/i)
  })
})

describe('writeFileContent', () => {
  it('writes when baseSha matches and returns the new sha', async () => {
    write('a.txt', 'one\n')
    const before = await readFileContent(root, 'a.txt')
    const result = await writeFileContent(root, 'a.txt', 'two\n', before.sha)
    expect(result.sha).toBe(sha('two\n'))
    expect((await readFileContent(root, 'a.txt')).text).toBe('two\n')
  })

  it('THROWS on a stale baseSha so an in-flight agent edit is never clobbered', async () => {
    write('a.txt', 'one\n')
    const opened = await readFileContent(root, 'a.txt')
    write('a.txt', 'agent edited this\n') // the agent writes underneath the editor panel
    await expect(writeFileContent(root, 'a.txt', 'editor text\n', opened.sha)).rejects.toThrow(
      /changed on disk/i
    )
    expect((await readFileContent(root, 'a.txt')).text).toBe('agent edited this\n')
  })

  it('rejects an empty baseSha and paths outside the session directory', async () => {
    write('a.txt', 'one\n')
    await expect(writeFileContent(root, 'a.txt', 'x', '')).rejects.toThrow(/baseSha/i)
    await expect(writeFileContent(root, '../evil.txt', 'x', sha('one\n'))).rejects.toThrow(
      /strictly inside/i
    )
  })
})

describe('gitignore compilation', () => {
  it('anchors patterns containing a slash and floats bare names', () => {
    const anchored = compileIgnorePattern('/build', '')
    const floating = compileIgnorePattern('*.log', '')
    expect(anchored && isIgnored('build', true, [anchored])).toBe(true)
    expect(anchored && isIgnored('src/build', true, [anchored])).toBe(false)
    expect(floating && isIgnored('deep/nested/x.log', false, [floating])).toBe(true)
  })

  it('ignores comments and blank lines, and honours dir-only patterns', () => {
    expect(compileIgnorePattern('# comment', '')).toBeNull()
    expect(compileIgnorePattern('   ', '')).toBeNull()
    const dirOnly = compileIgnorePattern('cache/', '')
    expect(dirOnly && isIgnored('cache', true, [dirOnly])).toBe(true)
    expect(dirOnly && isIgnored('cache', false, [dirOnly])).toBe(false)
  })
})

describe('languageForPath', () => {
  it('maps known extensions and special filenames, null otherwise', () => {
    expect(languageForPath('src/a.tsx')).toBe('typescript')
    expect(languageForPath('Dockerfile')).toBe('dockerfile')
    expect(languageForPath('.env.local')).toBe('ini')
    expect(languageForPath('LICENSE')).toBeNull()
  })
})

describe('register', () => {
  it('registers exactly the three fs channels and validates arguments', async () => {
    const handlers = new Map<string, (event: unknown, args: unknown) => Promise<unknown>>()
    register({
      handle: (channel: string, fn: (event: unknown, args: unknown) => Promise<unknown>) => {
        handlers.set(channel, fn)
      }
    } as unknown as Parameters<typeof register>[0])

    expect([...handlers.keys()]).toEqual(['oc:fs:tree', 'oc:fs:read', 'oc:fs:write'])

    write('a.txt', 'one\n')
    const read = handlers.get('oc:fs:read')!
    await expect(read(null, { directory: root, path: 'a.txt' })).resolves.toMatchObject({
      text: 'one\n'
    })
    await expect(read(null, 'not-an-object')).rejects.toThrow(/must be an object/i)
    await expect(read(null, { directory: root })).rejects.toThrow(/path must be a non-empty string/i)
    await expect(read(null, { directory: '', path: 'a.txt' })).rejects.toThrow(/non-empty string/i)

    const tree = handlers.get('oc:fs:tree')!
    await expect(tree(null, { directory: root })).resolves.toHaveLength(1)
  })
})
