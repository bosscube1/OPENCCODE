/**
 * The single `AppState` shape, plus the plumbing types every slice creator uses.
 *
 * `AppState` is the one source of truth for the store's surface. Each slice declares
 * what it owns as a `Pick<AppState, …>`, so a slice can never drift from the contract:
 * changing a signature here is the only way to change it anywhere.
 */

import type { Theme, RoutingMode } from '../prefs'
import type { CompareRun } from '../compare'
import type {
  AppSettings,
  MessageWithParts,
  OcEvent,
  Permission,
  PermissionResponse,
  Provider,
  ServerStatus,
  Session,
  Todo,
  ServerCommand,
  ProjectRecord,
  PromptPart,
  UpdateStatus
} from '../types'

export interface AppState {
  // connection
  server: ServerStatus
  // project
  directory: string | null
  // sessions
  sessions: Session[]
  activeSessionID: string | null
  // messages for the active session, ordered oldest -> newest
  messages: MessageWithParts[]
  busy: boolean
  // model
  providers: Provider[]
  defaultModels: Record<string, string>
  /** Main-process verified only; never inferred from OpenCode's provider metadata. */
  linkedProviderIDs: string[]
  providerID: string | null
  modelID: string | null
  /** User's pinned choice — mutated only by setModel. Never overwritten by failover. */
  pinnedProviderID: string | null
  pinnedModelID: string | null
  autoRotate: boolean
  modelPool: string[] | null
  stickyModel: boolean
  routingMode: RoutingMode
  showPaidModels: boolean
  // permissions awaiting user answer, oldest first
  permissions: Permission[]
  // last error banner text, null when clear
  error: string | null

  todos: Todo[]
  branch: string | null
  queuedPrompts: Array<{ text: string, parts?: PromptPart[] }>
  serverCommands: ServerCommand[]
  projects: ProjectRecord[]
  activeView: 'chats' | 'projects' | 'images'
  appSettings: AppSettings
  shortcutRegistered: boolean
  shortcutError: string | null
  updateStatus: UpdateStatus
  theme: Theme
  activeArtifactID: string | null

  /* ---- multi-model fan-out (compare runs) ---- */
  /** The active compare run, or null. While non-null, Chat renders CompareView. */
  compare: CompareRun | null
  /** Persisted `"providerID/modelID"` targets for the next fan-out. */
  compareTargets: string[]
  setCompareTargets(keys: string[]): void
  /**
   * Fan one prompt out to every target as its own read-only session.
   * Never engages the failover machinery — see the note on `applyCompareEvent`.
   */
  sendToMany(text: string, parts?: PromptPart[]): Promise<void>
  abortCompare(): Promise<void>
  /** Adopt a column's session as the active (fully tool-enabled) session and clear the run. */
  promoteCompareColumn(index: number): Promise<void>
  /** Delete every session in the run and clear it. */
  discardCompare(): Promise<void>
  /** Leave the run's sessions in place but stop showing the comparison. */
  clearCompare(): void

  // actions
  init(): Promise<void>
  pickDirectory(): Promise<void>
  setDirectory(dir: string): Promise<void>
  loadProjects(): Promise<void>
  createProject(name: string): Promise<ProjectRecord>
  openProject(project: ProjectRecord): Promise<void>
  setActiveView(view: 'chats' | 'projects' | 'images'): void
  loadAppSettings(): Promise<void>
  updateAppSettings(patch: Partial<AppSettings>): Promise<void>
  setUpdateStatus(status: UpdateStatus): void
  newSession(): Promise<void>
  selectSession(id: string): Promise<void>
  deleteSession(id: string): Promise<void>
  send(text: string, parts?: PromptPart[]): Promise<void>
  abort(): Promise<void>
  setModel(providerID: string, modelID: string): void
  revertToPinned(): void
  toggleAutoRotate(): void
  toggleStickyModel(): void
  setRoutingMode(mode: RoutingMode): void
  setShowPaidModels(v: boolean): void
  setModelPool(pool: string[] | null): void
  rotateToNextFreeModel(exclude?: string, excludeProviderID?: string): { providerID: string; modelID: string; providerName: string; modelName: string } | null
  addSystemNotice(text: string): void
  executeSlashCommand(cmdText: string): Promise<void>
  replyPermission(id: string, response: PermissionResponse): Promise<void>
  applyEvent(e: OcEvent): void
  dismissError(): void
  renameSession(id: string, title: string): Promise<void>
  setTheme(t: Theme): void
  queuePrompt(text: string, parts?: PromptPart[]): void
  removeQueued(index: number): void
  retryExchange(messageID: string): Promise<void>
  editAndResend(messageID: string, newText: string): Promise<void>
  setActiveArtifactID(id: string | null): void
}

/**
 * The zustand `set` handed to every slice.
 *
 * It is the WHOLE-store setter, not a per-slice one: a slice may legitimately write keys
 * another slice owns (deleting a session clears `permissions`, for example). Keeping one
 * setter is what stops cross-cutting writes from tearing.
 */
export type SetState = {
  (partial: Partial<AppState>): void
  (updater: (state: AppState) => Partial<AppState>): void
}

export type GetState = () => AppState

/** A slice is a plain factory over the shared `set` / `get`. */
export type SliceCreator<T> = (set: SetState, get: GetState) => T
