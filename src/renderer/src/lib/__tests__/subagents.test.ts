import { describe, expect, it } from 'vitest'
import { childSessionsOf, isDescendantOf, isSelfOrDescendant, splitSubagentTitle, taskChildSessionId } from '../subagents'
import type { Session, ToolPart, ToolState } from '../types'

function makeSession(id: string, parentID?: string, created = 1): Session {
  return {
    id,
    parentID,
    directory: '/proj',
    projectID: 'p1',
    title: id,
    time: { created, updated: created }
  } as unknown as Session
}

function makeTaskPart(state: ToolState, tool = 'task'): ToolPart {
  return {
    id: 'part-1',
    sessionID: 'parent',
    messageID: 'msg-1',
    type: 'tool',
    tool,
    callID: 'call-1',
    state
  } as unknown as ToolPart
}

describe('isSelfOrDescendant / isDescendantOf', () => {
  const sessions = [
    makeSession('root'),
    makeSession('child', 'root'),
    makeSession('grandchild', 'child'),
    makeSession('unrelated')
  ]

  it('is true for the root session itself (self)', () => {
    expect(isSelfOrDescendant(sessions, 'root', 'root')).toBe(true)
    expect(isDescendantOf(sessions, 'root', 'root')).toBe(false)
  })

  it('walks the parentID chain to any depth', () => {
    expect(isSelfOrDescendant(sessions, 'root', 'child')).toBe(true)
    expect(isSelfOrDescendant(sessions, 'root', 'grandchild')).toBe(true)
    expect(isDescendantOf(sessions, 'root', 'grandchild')).toBe(true)
    expect(isDescendantOf(sessions, 'child', 'grandchild')).toBe(true)
  })

  it('is false for unrelated and ancestor sessions', () => {
    expect(isSelfOrDescendant(sessions, 'root', 'unrelated')).toBe(false)
    expect(isDescendantOf(sessions, 'root', 'unrelated')).toBe(false)
    // The root is an ancestor of child, not a descendant of it.
    expect(isDescendantOf(sessions, 'child', 'root')).toBe(false)
  })

  it('is false when either id is missing', () => {
    expect(isSelfOrDescendant(sessions, null, 'child')).toBe(false)
    expect(isSelfOrDescendant(sessions, 'root', null)).toBe(false)
    expect(isSelfOrDescendant(sessions, undefined, undefined)).toBe(false)
  })

  it('terminates on a parentID cycle instead of looping forever', () => {
    const cyclic = [makeSession('a', 'b'), makeSession('b', 'a')]
    expect(isSelfOrDescendant(cyclic, 'root', 'a')).toBe(false)
  })
})

describe('taskChildSessionId', () => {
  it('extracts the child session id from a running task part', () => {
    const part = makeTaskPart({
      status: 'running',
      input: { description: 'scout', prompt: 'look around' },
      metadata: { sessionId: 'child-1' },
      time: { start: 1 }
    })
    expect(taskChildSessionId(part)).toBe('child-1')
  })

  it('extracts the child session id from a completed task part', () => {
    const part = makeTaskPart({
      status: 'completed',
      input: {},
      output: 'done',
      title: 'scout',
      metadata: { sessionId: 'child-2' },
      time: { start: 1, end: 2 }
    })
    expect(taskChildSessionId(part)).toBe('child-2')
  })

  it('is undefined for a pending part (no metadata yet)', () => {
    const part = makeTaskPart({ status: 'pending', input: {}, time: { start: 1 } } as unknown as ToolState)
    expect(taskChildSessionId(part)).toBeUndefined()
  })

  it('is undefined when metadata lacks a usable sessionId', () => {
    expect(
      taskChildSessionId(
        makeTaskPart({ status: 'running', input: {}, metadata: {}, time: { start: 1 } })
      )
    ).toBeUndefined()
    expect(
      taskChildSessionId(
        makeTaskPart({ status: 'running', input: {}, metadata: { sessionId: 42 }, time: { start: 1 } })
      )
    ).toBeUndefined()
    expect(
      taskChildSessionId(
        makeTaskPart({ status: 'running', input: {}, metadata: { sessionId: '' }, time: { start: 1 } })
      )
    ).toBeUndefined()
    expect(
      taskChildSessionId(
        makeTaskPart({ status: 'running', input: {}, time: { start: 1 } })
      )
    ).toBeUndefined()
  })

  it('is undefined for tools that are not task', () => {
    const part = makeTaskPart(
      { status: 'running', input: {}, metadata: { sessionId: 'child-1' }, time: { start: 1 } },
      'bash'
    )
    expect(taskChildSessionId(part)).toBeUndefined()
  })
})

describe('splitSubagentTitle', () => {
  it('splits the generated title into label and agent badge', () => {
    expect(splitSubagentTitle('Explore the repo (@scout subagent)')).toEqual({
      label: 'Explore the repo',
      agent: 'scout'
    })
  })

  it('handles multi-word descriptions and hyphenated agents', () => {
    expect(splitSubagentTitle('Fix the failing tests in CI (@build-fixer subagent)')).toEqual({
      label: 'Fix the failing tests in CI',
      agent: 'build-fixer'
    })
  })

  it('returns non-matching titles whole with a null agent', () => {
    expect(splitSubagentTitle('A normal session')).toEqual({ label: 'A normal session', agent: null })
    expect(splitSubagentTitle('(not a suffix) (@scout in the middle)')).toEqual({
      label: '(not a suffix) (@scout in the middle)',
      agent: null
    })
  })

  it('falls back to a generic label for empty input', () => {
    expect(splitSubagentTitle(undefined)).toEqual({ label: 'Subagent', agent: null })
    expect(splitSubagentTitle(null)).toEqual({ label: 'Subagent', agent: null })
    expect(splitSubagentTitle('   ')).toEqual({ label: 'Subagent', agent: null })
    expect(splitSubagentTitle('(@scout subagent)')).toEqual({ label: 'Subagent', agent: 'scout' })
  })
})

describe('childSessionsOf', () => {
  const sessions = [
    makeSession('root'),
    makeSession('child-b', 'root', 2),
    makeSession('child-a', 'root', 1),
    makeSession('grandchild', 'child-a', 3),
    makeSession('unrelated')
  ]

  it('returns direct children only, oldest-first', () => {
    expect(childSessionsOf(sessions, 'root').map((s) => s.id)).toEqual(['child-a', 'child-b'])
  })

  it('does not pull grandchildren into the root section', () => {
    expect(childSessionsOf(sessions, 'root')).toHaveLength(2)
    expect(childSessionsOf(sessions, 'child-a').map((s) => s.id)).toEqual(['grandchild'])
  })

  it('is empty for missing parents, leaf sessions, and null/undefined ids', () => {
    expect(childSessionsOf(sessions, 'unrelated')).toEqual([])
    expect(childSessionsOf(sessions, null)).toEqual([])
    expect(childSessionsOf(sessions, undefined)).toEqual([])
    expect(childSessionsOf([], 'root')).toEqual([])
  })
})
