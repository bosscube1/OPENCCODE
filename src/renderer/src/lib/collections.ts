/**
 * Immutable collection helpers — extracted from store.ts.
 */

import type { Message, MessageWithParts, Part, Session } from './types'

export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Oldest -> newest, ties broken by id. */
export function sortMessages(list: MessageWithParts[]): MessageWithParts[] {
  return list.slice().sort((a, b) => {
    const delta = a.info.time.created - b.info.time.created
    if (delta !== 0) return delta
    return compareIds(a.info.id, b.info.id)
  })
}

export function upsertMessage(list: MessageWithParts[], info: Message): MessageWithParts[] {
  const index = list.findIndex((m) => m.info.id === info.id)
  if (index === -1) return sortMessages([...list, { info, parts: [] }])
  const existing = list[index] as MessageWithParts
  const next = list.slice()
  next[index] = { info, parts: existing.parts }
  return sortMessages(next)
}

export function removeMessage(list: MessageWithParts[], messageID: string): MessageWithParts[] {
  const index = list.findIndex((m) => m.info.id === messageID)
  if (index === -1) return list
  return list.filter((m) => m.info.id !== messageID)
}

/** Upsert a part, preserving first-seen order. Ignored when the message is unknown. */
export function upsertPart(list: MessageWithParts[], part: Part): MessageWithParts[] {
  const index = list.findIndex((m) => m.info.id === part.messageID)
  if (index === -1) return list
  const message = list[index] as MessageWithParts
  const partIndex = message.parts.findIndex((p) => p.id === part.id)
  let parts: Part[]
  if (partIndex === -1) {
    parts = [...message.parts, part]
  } else {
    parts = message.parts.slice()
    parts[partIndex] = part
  }
  const next = list.slice()
  next[index] = { info: message.info, parts }
  return next
}

export function removePart(
  list: MessageWithParts[],
  messageID: string,
  partID: string
): MessageWithParts[] {
  const index = list.findIndex((m) => m.info.id === messageID)
  if (index === -1) return list
  const message = list[index] as MessageWithParts
  if (!message.parts.some((p) => p.id === partID)) return list
  const next = list.slice()
  next[index] = { info: message.info, parts: message.parts.filter((p) => p.id !== partID) }
  return next
}

/** Newest first — that is the order the sidebar renders. */
export function sortSessions(list: Session[]): Session[] {
  return list.slice().sort((a, b) => {
    const delta = b.time.updated - a.time.updated
    if (delta !== 0) return delta
    return compareIds(b.id, a.id)
  })
}

export function upsertSession(list: Session[], session: Session): Session[] {
  const index = list.findIndex((s) => s.id === session.id)
  if (index === -1) return sortSessions([...list, session])
  const next = list.slice()
  next[index] = session
  return sortSessions(next)
}

export function normalizePath(p: string): string {
  return p.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
}

export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  return normalizePath(a) === normalizePath(b)
}

/**
 * Build a synthetic system notice (assistant message with a single text part).
 * Typed properly — no `as any` casts.
 */
export function makeNotice(sessionID: string, text: string): MessageWithParts {
  const sysId = `sys-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  return {
    info: {
      id: sysId,
      sessionID,
      role: 'assistant' as const,
      time: { created: Math.floor(Date.now() / 1000) },
      // Synthetic notices have no server-side counterpart — these fields satisfy
      // the AssistantMessage shape without leaking into real data.
      parentID: '',
      modelID: 'system',
      providerID: 'system',
      mode: 'notice',
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    } as MessageWithParts['info'],
    parts: [
      {
        id: `part-${sysId}`,
        messageID: sysId,
        sessionID,
        type: 'text' as const,
        text,
      } as MessageWithParts['parts'][number]
    ]
  }
}
