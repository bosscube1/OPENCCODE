/**
 * Artifact detection, versioning, and management helpers — Module 5.
 * Pure renderer module, no side effects, no React imports.
 */

import type { MessageWithParts } from './types'

export type ArtifactType = 'code' | 'html' | 'svg' | 'mermaid' | 'markdown'

export type ArtifactVersion = {
  version: number
  content: string
  messageID: string
}

export type Artifact = {
  id: string
  title: string
  type: ArtifactType
  language?: string
  version: number
  versions: ArtifactVersion[]
  currentContent: string
  messageID: string
}

/**
 * Clean title for display in chips and panel header.
 */
export function getArtifactTitle(type: ArtifactType, lang?: string, filename?: string): string {
  if (filename && filename.trim().length > 0) {
    return filename.trim()
  }

  switch (type) {
    case 'html':
      return 'HTML Component'
    case 'svg':
      return 'SVG Graphic'
    case 'mermaid':
      return 'Mermaid Diagram'
    case 'markdown':
      return 'Markdown Document'
    case 'code':
      return lang ? `${lang.charAt(0).toUpperCase() + lang.slice(1)} Code` : 'Code Snippet'
  }
}

/**
 * Parse fence header to extract language tag and filename hint if present.
 * Example: "typescript src/index.ts" -> { lang: "typescript", filename: "src/index.ts" }
 */

export function parseFenceHeader(header: string): { lang?: string; filename?: string } {
  const trimmed = header.trim()
  if (!trimmed) return {}

  const parts = trimmed.split(/\s+/)
  const first = parts[0].toLowerCase()

  if (parts.length >= 2) {
    const filename = parts.slice(1).join(' ')
    return { lang: first, filename }
  }

  // If single token contains an extension like "app.tsx" or "chart.svg"
  if (first.includes('.')) {
    const ext = first.split('.').pop()?.toLowerCase()
    return { lang: ext, filename: parts[0] }
  }

  return { lang: first }
}

/**
 * Scan all loaded messages for substantial code/markup blocks and aggregate artifacts with versioning.
 */
export function extractArtifactsFromMessages(messages: MessageWithParts[]): Artifact[] {
  const artifactMap = new Map<string, Artifact>()

  for (const msg of messages) {
    // Only inspect assistant messages
    if (msg.info.role !== 'assistant') continue

    const textParts = msg.parts.filter((p) => p.type === 'text')
    const fullText = textParts.map((p) => (p as { text: string }).text).join('\n')
    if (!fullText) continue

    // Regex matching complete code fence blocks: ```[header]\n[code]\n```
    const fenceRegex = /```([^\n]*)\n([\s\S]*?)\n```/g
    let match: RegExpExecArray | null = null

    while ((match = fenceRegex.exec(fullText)) !== null) {
      const headerRaw = match[1] ?? ''
      const content = match[2] ?? ''

      const { lang, filename } = parseFenceHeader(headerRaw)
      const langLower = (lang ?? '').toLowerCase()

      let type: ArtifactType | null = null

      if (langLower === 'html' || langLower === 'htm') {
        type = 'html'
      } else if (langLower === 'svg' || content.trim().startsWith('<svg')) {
        type = 'svg'
      } else if (langLower === 'mermaid') {
        type = 'mermaid'
      } else if (langLower === 'markdown' || langLower === 'md') {
        type = 'markdown'
      } else {
        const lineCount = content.split('\n').length
        const charCount = content.length
        if (lineCount >= 15 || charCount >= 800) {
          type = 'code'
        }
      }

      if (!type) continue

      // Generate identity key
      let identityKey: string
      if (filename) {
        identityKey = `file:${filename.trim()}`
      } else {
        const firstLine = content.split('\n')[0].trim().slice(0, 40)
        identityKey = `type:${type}:${langLower}:${firstLine}`
      }

      const existing = artifactMap.get(identityKey)
      const title = getArtifactTitle(type, langLower, filename)

      if (!existing) {
        const artifact: Artifact = {
          id: identityKey,
          title,
          type,
          language: langLower || undefined,
          version: 1,
          versions: [{ version: 1, content, messageID: msg.info.id }],
          currentContent: content,
          messageID: msg.info.id
        }
        artifactMap.set(identityKey, artifact)
      } else {
        const lastVersion = existing.versions[existing.versions.length - 1]
        if (lastVersion.content !== content) {
          const nextVer = existing.versions.length + 1
          existing.versions.push({
            version: nextVer,
            content,
            messageID: msg.info.id
          })
          existing.version = nextVer
          existing.currentContent = content
          existing.messageID = msg.info.id
        }
      }
    }
  }

  return Array.from(artifactMap.values())
}
