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
