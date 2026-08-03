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

  it('does not list a server command that collides with a built-in twice', () => {
    // opencode registers `/init` itself and the local table ships it too. Both used to
    // reach the menu, which rendered duplicate children under one React key.
    const serverCmds: ServerCommand[] = [
      { name: 'init', description: 'Server-side init', template: 'init' }
    ]
    const matches = getMatchingCommands('/init', serverCmds)
    expect(matches.filter((c) => c.name === '/init')).toHaveLength(1)
  })

  it('keeps the local command on a collision — it is the one with an action', () => {
    const serverCmds: ServerCommand[] = [
      { name: 'init', description: 'Server-side init', template: 'init' }
    ]
    const [match] = getMatchingCommands('/init', serverCmds).filter((c) => c.name === '/init')
    expect(match.isServerCommand).toBeUndefined()
    expect(typeof match.action).toBe('function')
  })
})
