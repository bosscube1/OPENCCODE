/**
 * Shared renderer types.
 *
 * The renderer imports SDK **types only** — never runtime SDK code (see CONTRACTS.md).
 * Everything the UI needs is re-exported from here so components have a single import site.
 */

import type {
  AssistantMessage,
  FilePart,
  Message,
  Part,
  ReasoningPart,
  TextPart,
  ToolPart,
  UserMessage
} from '@opencode-ai/sdk'

export type {
  Session,
  Message,
  UserMessage,
  AssistantMessage,
  Part,
  TextPart,
  ReasoningPart,
  FilePart,
  ToolPart,
  ToolState,
  Provider,
  Model,
  Permission
} from '@opencode-ai/sdk'

// SDK types for new features (Phase 0+)
export type { Todo, VcsInfo } from '@opencode-ai/sdk'

export type ProjectRecord = {
  id: string
  name: string
  directory: string
  createdAt: number
  updatedAt: number
}

export type KnowledgeFile = { filename: string; size: number; updatedAt: number }

export type McpLocalConfig = {
  type: 'local'
  command: string[]
  environment?: Record<string, string>
  enabled?: boolean
  timeout?: number
}

export type McpRemoteConfig = {
  type: 'remote'
  url: string
  enabled?: boolean
  headers?: Record<string, string>
  oauth?: { clientId?: string; clientSecret?: string; scope?: string } | false
  timeout?: number
}

export type McpConfig = McpLocalConfig | McpRemoteConfig

export type McpStatus =
  | { status: 'connected' | 'disabled' | 'needs_auth' }
  | { status: 'failed' | 'needs_client_registration'; error: string }

export type McpSnapshot = {
  configs: Record<string, McpConfig>
  statuses: Record<string, McpStatus>
}

export type AppSettings = {
  closeToTray: boolean
  globalShortcut: string
  showPaidModels: boolean
  ttftMs: number
  stallMs: number
  /**
   * Refuse NanoGPT image generation on any model observed to bill the pay-as-you-go balance.
   * Default true, so the app never silently spends money.
   */
  nanogptSubscriptionOnly: boolean
}

export type AppSettingsResult = {
  settings: AppSettings
  shortcutRegistered: boolean
  shortcutError?: string
}

/* ------------------------------------------------------------------ *
 * NanoGPT — subscription catalogue + image sidecar
 * Structurally identical to the main-process and preload copies.
 * ------------------------------------------------------------------ */

export type NanoChatModel = {
  id: string
  name?: string
  description?: string
  context_length?: number
  max_output_tokens?: number
  capabilities?: { vision?: boolean; tool_calling?: boolean }
}

export type NanoImageModel = {
  id: string
  name?: string
  description?: string
  pricing?: unknown
  supported_parameters?: string[]
  tags?: string[]
}

export type NanogptModelsResult = {
  chat: NanoChatModel[]
  image: NanoImageModel[]
  /** Image model ids observed to bill balance rather than the subscription. */
  balanceBilled: string[]
  fetchedAt: number
}

export type NanogptRefreshResult = {
  chatCount: number
  imageCount: number
  /** True when the chat model set changed — the OpenCode server must restart to see it. */
  restartRequired: boolean
  fetchedAt: number
}

export type NanoUsage = {
  active: boolean
  limits: { daily: number; monthly: number }
  enforceDailyLimit?: boolean
  daily: { used: number; remaining: number; percentUsed: number; resetAt: number }
  monthly: { used: number; remaining: number; percentUsed: number; resetAt: number }
  state: string
  graceUntil?: string | null
}

export type GeneratedImageMeta = {
  id: string
  sessionID: string | null
  prompt: string
  model: string
  size?: string
  paymentSource?: string
  cost?: number
  createdAt: number
  bytes: number
}

export type NanogptGenerateArgs = {
  prompt: string
  model: string
  n?: number
  size?: string
  sessionID?: string
  /** Explicit per-call consent to bill the pay-as-you-go balance. Never defaults to true. */
  allowBalance?: boolean
}

/** How a completed generation was billed. `unknown` = NanoGPT omitted `paymentSource`. */
export type ImageBilling = 'subscription' | 'balance' | 'unknown'

export type NanogptGenerateResult = {
  images: Array<{ meta: GeneratedImageMeta; base64: string }>
  billing: ImageBilling
  paymentSource?: string
  cost?: number
  remainingBalance?: number
  route: 'subscription' | 'standard'
  /** True when this call caused the model to be recorded as balance-billing. */
  blacklisted: boolean
}

export type UpdateStatus =
  | { state: 'idle' | 'checking' | 'not-available' | 'downloaded' }
  | { state: 'available'; version: string }
  | { state: 'progress'; percent: number }
  | { state: 'error'; message: string }

/**
 * Re-exported as ServerCommand to avoid collision with the DOM `Command` interface.
 * These are project-level slash commands registered on the server.
 */
import type { Command as SdkCommand } from '@opencode-ai/sdk'
export type ServerCommand = SdkCommand

/** Input shape for prompt parts sent over IPC to session.promptAsync. */
export type PromptPart =
  | { type: 'text'; text: string }
  | { type: 'file'; mime: string; filename: string; url: string }

/** A message plus the parts that belong to it, as returned by `oc:messages:list`. */
export type MessageWithParts = { info: Message; parts: Part[] }

/** Status of the `opencode serve` child process, owned by the main process. */
export type ServerStatus = { running: boolean; url: string | null; error?: string }

/** Answer to a permission request. */
export type PermissionResponse = 'once' | 'always' | 'reject'

/** Every SSE event, forwarded verbatim from main over the `oc:event` channel. */
export type OcEvent = { type: string; properties: any }

/** Shape returned by `oc:providers`. */
export type ProvidersResult = {
  providers: import('@opencode-ai/sdk').Provider[]
  default: Record<string, string>
}

/* ------------------------------------------------------------------ *
 * Narrowing helpers
 * ------------------------------------------------------------------ */

export function isTextPart(part: Part): part is TextPart {
  return part.type === 'text'
}

export function isReasoningPart(part: Part): part is ReasoningPart {
  return part.type === 'reasoning'
}

export function isToolPart(part: Part): part is ToolPart {
  return part.type === 'tool'
}

export function isFilePart(part: Part): part is FilePart {
  return part.type === 'file'
}

export function isAssistant(message: Message): message is AssistantMessage {
  return message.role === 'assistant'
}

export function isUser(message: Message): message is UserMessage {
  return message.role === 'user'
}
