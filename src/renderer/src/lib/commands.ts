/**
 * Claude Code style slash commands implementation.
 */

import { useStore, errText } from './store'
import { sessionCost } from './aggregate'
import { exportMarkdown } from './exportMarkdown'
import { formatCost } from './format'
import { isAssistant } from './types'
import type { ServerCommand } from './types'

export interface SlashCommand {
  name: string
  alias?: string
  description: string
  usage?: string
  isServerCommand?: boolean
  action?: (args: string) => Promise<void> | void
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: '/help',
    description: 'Show available slash commands and usage guide',
    usage: '/help'
  },
  {
    name: '/free',
    alias: '/auto',
    description: 'Toggle Free Model Auto-Routing to cycle models on rate limits (429)',
    usage: '/free'
  },
  {
    name: '/clear',
    description: 'Clear local conversation message view',
    usage: '/clear'
  },
  {
    name: '/models',
    description: 'List available AI models and active provider status',
    usage: '/models'
  },
  {
    name: '/doctor',
    description: 'Run environment and OpenCode server diagnostics',
    usage: '/doctor'
  },
  {
    name: '/compact',
    description: 'Compact conversation context',
    usage: '/compact',
    action: async () => {
      const { directory, activeSessionID, providerID, modelID, addSystemNotice } = useStore.getState()
      if (!directory || !activeSessionID || !providerID || !modelID) return
      addSystemNotice('Compacting session...')
      try {
        await window.api.sessions.summarize({ directory, sessionID: activeSessionID, providerID, modelID })
      } catch (e) {
        addSystemNotice(`⚠️ Failed to compact context: ${errText(e)}`)
      }
    }
  },
  {
    name: '/init',
    description: 'Create a default opencode.json config file in project folder',
    usage: '/init',
    action: async () => {
      const { directory, activeSessionID, providerID, modelID, addSystemNotice } = useStore.getState()
      if (!directory || !activeSessionID || !providerID || !modelID) return
      const messageID = `sys-${Date.now()}`
      addSystemNotice('Initializing project session...')
      try {
        await window.api.sessions.init({ directory, sessionID: activeSessionID, providerID, modelID, messageID })
        addSystemNotice('Initialized project session successfully.')
      } catch (e) {
        addSystemNotice(`⚠️ Failed to initialize session: ${errText(e)}`)
      }
    }
  },
  {
    name: '/cost',
    description: 'Display session message statistics and provider metrics',
    usage: '/cost',
    action: () => {
      const { messages, addSystemNotice } = useStore.getState()
      const cost = sessionCost(messages)
      let inputTokens = 0
      let outputTokens = 0
      for (const m of messages) {
        if (isAssistant(m.info)) {
          inputTokens += m.info.tokens.input
          outputTokens += m.info.tokens.output
        }
      }
      addSystemNotice(
        `💰 Session cost so far: ${formatCost(cost)} (${inputTokens} input / ${outputTokens} output tokens)`
      )
    }
  },
  {
    name: '/export',
    description: 'Export chat conversation history to a Markdown file',
    usage: '/export',
    action: async () => {
      const { messages, sessions, activeSessionID, addSystemNotice } = useStore.getState()
      if (messages.length === 0) {
        addSystemNotice('No messages to export.')
        return
      }
      const session = sessions.find((s) => s.id === activeSessionID)
      const defaultName = `${session?.title || 'opencode-chat'}.md`.replace(/[^a-zA-Z0-9._-]/g, '_')
      const content = exportMarkdown(messages, session?.title)
      try {
        const saved = await window.api.exportChat(defaultName, content)
        if (saved) {
          addSystemNotice('📄 Chat history exported to Markdown.')
        }
      } catch (e) {
        addSystemNotice(`⚠️ Failed to export chat: ${errText(e)}`)
      }
    }
  }
]

export function getMatchingCommands(query: string, serverCommands: ServerCommand[] = []): SlashCommand[] {
  const q = query.trim().toLowerCase()
  if (!q.startsWith('/')) return []

  const mappedServerCommands: SlashCommand[] = serverCommands.map((cmd) => ({
    name: `/${cmd.name}`,
    description: cmd.description || '',
    isServerCommand: true,
    action: async (args: string) => {
      const { directory, activeSessionID, addSystemNotice } = useStore.getState()
      if (!directory || !activeSessionID) return
      try {
        await window.api.sessions.command({ directory, sessionID: activeSessionID, command: cmd.name, arguments: args })
      } catch (e) {
        addSystemNotice(`⚠️ Failed to run \`${cmd.name}\`: ${errText(e)}`)
      }
    }
  }))

  const allCommands = [...SLASH_COMMANDS, ...mappedServerCommands]

  return allCommands.filter((cmd) => {
    return (
      cmd.name.toLowerCase().startsWith(q) ||
      (cmd.alias && cmd.alias.toLowerCase().startsWith(q)) ||
      cmd.description.toLowerCase().includes(q.slice(1))
    )
  })
}
