/**
 * Convert session messages into a clean Markdown export document.
 *
 * Pure function — no IPC, no DOM. `Chat.tsx` builds the meta and hands the
 * resulting string to `window.api.exportChat` for the actual file write.
 */
import { isReasoningPart, isTextPart, isToolPart } from './types'
import type { MessageWithParts, Part, ToolPart } from './types'

export type ExportMeta = {
  sessionTitle?: string
  directory?: string
  providerID?: string
  modelID?: string
  exportedAt?: Date
}

function renderTool(part: ToolPart): string {
  const state = part.state
  let block = `\`\`\`tool\n${part.tool}`

  try {
    block += `\n${JSON.stringify(state.input, null, 2)}`
  } catch {
    /* unstringifiable input — skip the argument dump, keep the tool name */
  }

  if (state.status === 'completed') {
    const output = typeof state.output === 'string' ? state.output : JSON.stringify(state.output)
    if (output) block += `\n\n// result\n${output}`
  } else if (state.status === 'error') {
    const error = typeof state.error === 'string' ? state.error : JSON.stringify(state.error)
    if (error) block += `\n\n// error\n${error}`
  }

  block += '\n```'
  return block
}

/** Renders one part to a Markdown fragment; unknown/unhandled part types resolve to '' (skipped). */
function renderPart(part: Part): string {
  if (isTextPart(part)) return part.text.trim()

  if (isReasoningPart(part)) {
    const text = part.text.trim()
    if (text === '') return ''
    return `<details>\n<summary>Reasoning</summary>\n\n${text}\n\n</details>`
  }

  if (isToolPart(part)) return renderTool(part)

  return ''
}

/**
 * `meta` is normally the structured object below. A bare string is also accepted as shorthand
 * for `{ sessionTitle }` — kept for the existing `/export` slash command and test call sites,
 * which predate the structured form and are outside this change's file ownership.
 */
export function exportMarkdown(messages: MessageWithParts[], meta?: ExportMeta | string): string {
  const resolved: ExportMeta = typeof meta === 'string' ? { sessionTitle: meta } : (meta ?? {})
  const title = resolved.sessionTitle?.trim() || 'OpenCode Chat Export'
  const exportedAt = resolved.exportedAt ?? new Date()

  const metaLines: string[] = []
  if (resolved.directory) metaLines.push(`- **Directory:** \`${resolved.directory}\``)
  if (resolved.providerID || resolved.modelID) {
    metaLines.push(`- **Model:** \`${resolved.providerID ?? '?'}/${resolved.modelID ?? '?'}\``)
  }
  metaLines.push(`- **Exported:** ${exportedAt.toISOString()}`)
  metaLines.push(`- **Messages:** ${messages.length}`)

  let out = `# ${title}\n\n${metaLines.join('\n')}\n\n---\n\n`

  for (const message of messages) {
    const heading = message.info.role === 'user' ? '## User' : '## Assistant'
    out += `${heading}\n\n`

    for (const part of message.parts) {
      const rendered = renderPart(part)
      if (rendered !== '') out += `${rendered}\n\n`
    }
  }

  return `${out.trim()}\n`
}
