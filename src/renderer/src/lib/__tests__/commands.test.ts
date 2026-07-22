import { describe, expect, it } from 'vitest'
import { getMatchingCommands } from '../commands'
import type { ServerCommand } from '../types'

describe('slash command helpers', () => {
  it('returns empty array when query does not start with slash', () => {
    expect(getMatchingCommands('help')).toEqual([])
  })

  it('matches slash commands by prefix or description', () => {
    const helpMatches = getMatchingCommands('/he')
    expect(helpMatches.some((c) => c.name === '/help')).toBe(true)

    const freeMatches = getMatchingCommands('/fr')
    expect(freeMatches.some((c) => c.name === '/free')).toBe(true)
  })

  it('includes server commands', () => {
    const serverCmds: ServerCommand[] = [
      { name: 'test', description: 'Run test suite', template: 'test' }
    ]
    const matches = getMatchingCommands('/test', serverCmds)
    expect(matches.some((c) => c.name === '/test' && c.isServerCommand)).toBe(true)
  })
})
