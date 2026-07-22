import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import { app } from 'electron'
import { assertSubpath, projectSlug } from './projectsPaths'

export type ProjectRecord = {
  id: string
  name: string
  directory: string
  createdAt: number
  updatedAt: number
}

export type KnowledgeFile = { filename: string; size: number; updatedAt: number }

type Registry = { version: 1; projects: ProjectRecord[] }

const START = '<!-- OPENCODE-DESKTOP-INSTRUCTIONS-START -->'
const END = '<!-- OPENCODE-DESKTOP-INSTRUCTIONS-END -->'
const KNOWLEDGE_GLOB = 'knowledge/**/*.md'

function registryPath(): string {
  return join(app.getPath('userData'), 'projects-registry.json')
}

function projectsRoot(): string {
  return join(app.getPath('userData'), 'Projects')
}

function isProjectRecord(value: unknown): value is ProjectRecord {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return typeof row.id === 'string' && row.id.length > 0 &&
    typeof row.name === 'string' && row.name.length > 0 &&
    typeof row.directory === 'string' && row.directory.length > 0 &&
    typeof row.createdAt === 'number' && Number.isFinite(row.createdAt) &&
    typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt)
}

async function readRegistry(): Promise<Registry> {
  try {
    const parsed = JSON.parse(await readFile(registryPath(), 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null) return { version: 1, projects: [] }
    const rows = (parsed as { projects?: unknown }).projects
    if (!Array.isArray(rows)) return { version: 1, projects: [] }
    const root = projectsRoot()
    const projects = rows.filter(isProjectRecord).filter((project) => {
      try {
        assertSubpath(root, project.directory)
        return true
      } catch {
        return false
      }
    })
    return { version: 1, projects }
  } catch {
    return { version: 1, projects: [] }
  }
}

async function writeRegistry(registry: Registry): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  const path = registryPath()
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
}

async function requireProject(directory: string): Promise<ProjectRecord> {
  const resolved = resolve(directory)
  assertSubpath(projectsRoot(), resolved)
  const registry = await readRegistry()
  const project = registry.projects.find((row) => resolve(row.directory) === resolved)
  if (!project) throw new Error('Unknown managed project directory.')
  return project
}

async function ensureConfig(directory: string): Promise<void> {
  const path = assertSubpath(directory, 'opencode.json')
  let config: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      config = parsed as Record<string, unknown>
    }
  } catch {
    // A missing or malformed generated file is repaired to the minimal safe shape.
  }
  const current = Array.isArray(config.instructions)
    ? config.instructions.filter((item): item is string => typeof item === 'string')
    : []
  config.instructions = current.includes(KNOWLEDGE_GLOB) ? current : [...current, KNOWLEDGE_GLOB]
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}

export async function listProjects(): Promise<ProjectRecord[]> {
  const registry = await readRegistry()
  return [...registry.projects].sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function createProject(nameArg: string): Promise<ProjectRecord> {
  const name = nameArg.trim()
  if (!name) throw new Error('Project name must not be empty.')
  if (name.length > 80) throw new Error('Project name must be 80 characters or fewer.')

  const root = projectsRoot()
  await mkdir(root, { recursive: true })
  const registry = await readRegistry()
  const baseSlug = projectSlug(name)
  let slug = baseSlug
  let suffix = 2
  const used = new Set(registry.projects.map((row) => resolve(row.directory).toLowerCase()))
  while (used.has(resolve(root, slug).toLowerCase()) || existsSync(resolve(root, slug))) {
    slug = `${baseSlug}-${suffix++}`
  }
  const directory = assertSubpath(root, slug)
  await mkdir(directory, { recursive: false })
  await mkdir(assertSubpath(directory, 'knowledge'), { recursive: true })
  await ensureConfig(directory)

  const now = Date.now()
  const project: ProjectRecord = { id: randomUUID(), name, directory, createdAt: now, updatedAt: now }
  await writeRegistry({ version: 1, projects: [...registry.projects, project] })
  return project
}

export async function getProjectInstructions(directory: string): Promise<string> {
  await requireProject(directory)
  const path = assertSubpath(directory, 'AGENTS.md')
  try {
    const content = await readFile(path, 'utf8')
    const start = content.indexOf(START)
    const end = content.indexOf(END, start + START.length)
    if (start < 0 || end < 0) return ''
    return content.slice(start + START.length, end).replace(/^\r?\n|\r?\n$/g, '')
  } catch {
    return ''
  }
}

export async function setProjectInstructions(directory: string, text: string): Promise<void> {
  await requireProject(directory)
  const path = assertSubpath(directory, 'AGENTS.md')
  let content = ''
  try { content = await readFile(path, 'utf8') } catch { /* new file */ }
  const escapedStart = START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const escapedEnd = END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const block = new RegExp(`(?:\\r?\\n)?${escapedStart}[\\s\\S]*?${escapedEnd}(?:\\r?\\n)?`, 'g')
  const remaining = content.replace(block, '\n').trimEnd()
  const trimmed = text.trim()
  const managed = trimmed ? `${START}\n${trimmed}\n${END}` : ''
  const next = [remaining, managed].filter(Boolean).join('\n\n')
  await writeFile(path, next ? `${next}\n` : '', 'utf8')
}

export async function listKnowledge(directory: string): Promise<KnowledgeFile[]> {
  await requireProject(directory)
  const knowledgeDir = assertSubpath(directory, 'knowledge')
  await mkdir(knowledgeDir, { recursive: true })
  const entries = await readdir(knowledgeDir, { withFileTypes: true })
  const result: KnowledgeFile[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue
    const path = assertSubpath(knowledgeDir, entry.name)
    const info = await stat(path)
    result.push({ filename: entry.name, size: info.size, updatedAt: info.mtimeMs })
  }
  return result.sort((a, b) => a.filename.localeCompare(b.filename))
}

export async function addKnowledge(directory: string, filePaths: string[]): Promise<KnowledgeFile[]> {
  await requireProject(directory)
  if (!Array.isArray(filePaths) || filePaths.length === 0) return listKnowledge(directory)
  const knowledgeDir = assertSubpath(directory, 'knowledge')
  await mkdir(knowledgeDir, { recursive: true })
  for (const source of filePaths) {
    if (typeof source !== 'string' || !source.trim()) throw new Error('Invalid knowledge file path.')
    if (extname(source).toLowerCase() !== '.md') throw new Error('Knowledge files must use the .md extension.')
    const filename = basename(source)
    const destination = assertSubpath(knowledgeDir, filename)
    await copyFile(source, destination)
  }
  await ensureConfig(directory)
  return listKnowledge(directory)
}

export async function removeKnowledge(directory: string, filename: string): Promise<void> {
  await requireProject(directory)
  if (filename !== basename(filename) || !/\.md$/i.test(filename)) {
    throw new Error('Invalid knowledge filename.')
  }
  const knowledgeDir = assertSubpath(directory, 'knowledge')
  const target = assertSubpath(knowledgeDir, filename)
  await unlink(target)
}
