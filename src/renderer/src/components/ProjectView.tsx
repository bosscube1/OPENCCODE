import { useEffect, useMemo, useState } from 'react'
import type { FormEvent, JSX } from 'react'
import type { KnowledgeFile, ProjectRecord } from '../lib/types'
import { useStore } from '../lib/store'
import { relativeTime, shortPath } from '../lib/format'
import './projects.css'

type Tab = 'instructions' | 'knowledge' | 'chats'

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function ProjectView(): JSX.Element {
  const projects = useStore((s) => s.projects)
  const directory = useStore((s) => s.directory)
  const sessions = useStore((s) => s.sessions)
  const createProject = useStore((s) => s.createProject)
  const openProject = useStore((s) => s.openProject)
  const newSession = useStore((s) => s.newSession)
  const selectSession = useStore((s) => s.selectSession)
  const setActiveView = useStore((s) => s.setActiveView)

  const [selectedID, setSelectedID] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('instructions')
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [instructions, setInstructions] = useState('')
  const [knowledge, setKnowledge] = useState<KnowledgeFile[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)

  const selected = useMemo<ProjectRecord | null>(() => {
    return projects.find((project) => project.id === selectedID) ??
      projects.find((project) => project.directory === directory) ?? projects[0] ?? null
  }, [projects, selectedID, directory])

  useEffect(() => {
    if (!selected) {
      setInstructions('')
      setKnowledge([])
      return
    }
    let current = true
    setLoading(true)
    setLocalError(null)
    void Promise.all([
      window.api.projects.getInstructions(selected.directory),
      window.api.projects.listKnowledge(selected.directory)
    ]).then(([text, files]) => {
      if (!current) return
      setInstructions(text)
      setKnowledge(files)
    }).catch((error: unknown) => {
      if (current) setLocalError(error instanceof Error ? error.message : String(error))
    }).finally(() => {
      if (current) setLoading(false)
    })
    return () => { current = false }
  }, [selected])

  async function chooseProject(project: ProjectRecord): Promise<void> {
    setSelectedID(project.id)
    setNotice(null)
    setLocalError(null)
    await openProject(project)
  }

  async function submitCreate(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (!name.trim() || creating) return
    setCreating(true)
    setLocalError(null)
    try {
      const project = await createProject(name)
      setSelectedID(project.id)
      setName('')
      setNotice('Project created.')
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error))
    } finally {
      setCreating(false)
    }
  }

  async function saveInstructions(): Promise<void> {
    if (!selected || saving) return
    setSaving(true)
    setLocalError(null)
    try {
      await window.api.projects.setInstructions(selected.directory, instructions)
      setNotice('Custom instructions saved.')
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  async function addFiles(): Promise<void> {
    if (!selected) return
    setLoading(true)
    setLocalError(null)
    try {
      const files = await window.api.projects.addKnowledge(selected.directory)
      setKnowledge(files)
      setNotice('Knowledge files updated.')
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }

  async function removeFile(filename: string): Promise<void> {
    if (!selected || !window.confirm(`Remove ${filename} from this project?`)) return
    setLocalError(null)
    try {
      await window.api.projects.removeKnowledge(selected.directory, filename)
      setKnowledge((files) => files.filter((file) => file.filename !== filename))
      setNotice(`${filename} removed.`)
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <section className="projects" aria-label="Projects">
      <header className="projects__header">
        <div>
          <h1>Projects</h1>
          <p>Give each workspace its own instructions, knowledge, and conversations.</p>
        </div>
        <form className="projects__create" onSubmit={(event) => void submitCreate(event)}>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Project name" maxLength={80} />
          <button type="submit" disabled={!name.trim() || creating}>{creating ? 'Creating…' : 'Create project'}</button>
        </form>
      </header>

      <div className="projects__body">
        <aside className="projects__list" aria-label="Project list">
          {projects.length === 0 && <p className="projects__empty">No managed projects yet.</p>}
          {projects.map((project) => (
            <button
              type="button"
              key={project.id}
              className={selected?.id === project.id ? 'projects__project projects__project--active' : 'projects__project'}
              onClick={() => void chooseProject(project)}
            >
              <strong>{project.name}</strong>
              <span title={project.directory}>{shortPath(project.directory)}</span>
            </button>
          ))}
        </aside>

        <div className="projects__detail">
          {!selected ? (
            <div className="projects__blank"><h2>Create your first project</h2><p>A private folder will be created in the app data directory.</p></div>
          ) : (
            <>
              <div className="projects__title">
                <div><h2>{selected.name}</h2><code title={selected.directory}>{selected.directory}</code></div>
                {directory !== selected.directory && <button type="button" onClick={() => void chooseProject(selected)}>Open workspace</button>}
              </div>
              <div className="projects__tabs" role="tablist">
                {(['instructions', 'knowledge', 'chats'] as const).map((value) => (
                  <button type="button" role="tab" aria-selected={tab === value} className={tab === value ? 'projects__tab projects__tab--active' : 'projects__tab'} onClick={() => setTab(value)} key={value}>
                    {value === 'instructions' ? 'Custom instructions' : value === 'knowledge' ? 'Knowledge files' : 'Project chats'}
                  </button>
                ))}
              </div>

              {localError && <div className="projects__message projects__message--error" role="alert">{localError}</div>}
              {notice && <div className="projects__message" role="status">{notice}</div>}

              {tab === 'instructions' && (
                <div className="projects__pane">
                  <label htmlFor="project-instructions">Instructions applied to every chat in this project</label>
                  <textarea id="project-instructions" value={instructions} onChange={(event) => setInstructions(event.target.value)} disabled={loading} placeholder="For example: Use TypeScript, keep answers concise, and run tests before proposing changes." />
                  <div className="projects__actions"><span>Saved in a managed block inside AGENTS.md.</span><button type="button" onClick={() => void saveInstructions()} disabled={loading || saving}>{saving ? 'Saving…' : 'Save instructions'}</button></div>
                </div>
              )}

              {tab === 'knowledge' && (
                <div className="projects__pane">
                  <div className="projects__actions"><span>Markdown files become project context through OpenCode’s instructions glob.</span><button type="button" onClick={() => void addFiles()} disabled={loading}>{loading ? 'Loading…' : 'Add files…'}</button></div>
                  <div className="projects__files">
                    {knowledge.length === 0 && <p className="projects__empty">No knowledge files added.</p>}
                    {knowledge.map((file) => (
                      <div className="projects__file" key={file.filename}>
                        <div><strong>{file.filename}</strong><span>{formatSize(file.size)} · updated {relativeTime(file.updatedAt)}</span></div>
                        <button type="button" className="projects__remove" onClick={() => void removeFile(file.filename)}>Delete</button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {tab === 'chats' && (
                <div className="projects__pane">
                  {directory !== selected.directory ? (
                    <div className="projects__blank"><p>Open this workspace to load its scoped chats.</p><button type="button" onClick={() => void chooseProject(selected)}>Open workspace</button></div>
                  ) : (
                    <>
                      <div className="projects__actions"><span>{sessions.filter((session) => !session.parentID).length} project chats</span><button type="button" onClick={() => void newSession().then(() => setActiveView('chats'))}>New chat</button></div>
                      <div className="projects__chats">
                        {sessions.filter((session) => !session.parentID).length === 0 && <p className="projects__empty">No chats in this project yet.</p>}
                        {sessions.filter((session) => !session.parentID).map((session) => (
                          <button type="button" key={session.id} onClick={() => void selectSession(session.id).then(() => setActiveView('chats'))}>
                            <strong>{session.title || 'Untitled'}</strong><span>{relativeTime(session.time.updated || session.time.created)}</span>
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  )
}
