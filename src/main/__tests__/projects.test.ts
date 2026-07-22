import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({ userData: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => mock.userData }
}))

import {
  addKnowledge,
  createProject,
  getProjectInstructions,
  listKnowledge,
  listProjects,
  removeKnowledge,
  setProjectInstructions
} from '../projects'

describe('managed projects', () => {
  beforeEach(async () => {
    mock.userData = await mkdtemp(join(tmpdir(), 'opencode-desktop-projects-'))
  })

  afterEach(async () => {
    await rm(mock.userData, { recursive: true, force: true })
  })

  it('creates unique project directories and a guarded registry', async () => {
    const first = await createProject('My Docs')
    const second = await createProject('My Docs')
    expect(first.directory).toMatch(/[\\/]my-docs$/)
    expect(second.directory).toMatch(/[\\/]my-docs-2$/)
    expect((await listProjects()).map((row) => row.id)).toEqual([second.id, first.id])
    const config = JSON.parse(await readFile(join(first.directory, 'opencode.json'), 'utf8')) as { instructions: string[] }
    expect(config.instructions).toContain('knowledge/**/*.md')
  })

  it('updates only the managed AGENTS.md marker block', async () => {
    const project = await createProject('Instructions')
    const agents = join(project.directory, 'AGENTS.md')
    await writeFile(agents, '# User-owned heading\n\nKeep this text.\n', 'utf8')
    await setProjectInstructions(project.directory, 'Always answer in haiku.')
    await setProjectInstructions(project.directory, 'Prefer concise answers.')
    const content = await readFile(agents, 'utf8')
    expect(content).toContain('# User-owned heading')
    expect(content).toContain('Keep this text.')
    expect(content).not.toContain('Always answer in haiku.')
    expect(content.match(/OPENCODE-DESKTOP-INSTRUCTIONS-START/g)).toHaveLength(1)
    expect(await getProjectInstructions(project.directory)).toBe('Prefer concise answers.')
  })

  it('copies, lists, and removes Markdown knowledge files', async () => {
    const project = await createProject('Knowledge')
    const source = join(mock.userData, 'reference.md')
    await writeFile(source, '# Reference\nFacts.', 'utf8')
    const added = await addKnowledge(project.directory, [source])
    expect(added).toHaveLength(1)
    expect(added[0].filename).toBe('reference.md')
    expect((await listKnowledge(project.directory))[0].size).toBeGreaterThan(0)
    await removeKnowledge(project.directory, 'reference.md')
    expect(await listKnowledge(project.directory)).toEqual([])
  })

  it('refuses filesystem operations for unregistered directories', async () => {
    const unknown = join(mock.userData, 'Projects', 'unknown')
    await expect(setProjectInstructions(unknown, 'nope')).rejects.toThrow(/unknown managed project/i)
  })
})
