import { describe, it, expect } from 'vitest'

import {
  SIDE_CHAT_TITLE_SUFFIX,
  isSideChatTitle,
  sideChatTitle,
  splitSideChatTitle,
  splitSubagentTitle
} from '../subagents'

describe('sideChatTitle', () => {
  it('marks the title so the tab can be told apart from a subagent', () => {
    expect(sideChatTitle('what does assertSubpath do?')).toBe(
      `what does assertSubpath do?${SIDE_CHAT_TITLE_SUFFIX}`
    )
  })

  it('collapses newlines — the title renders in a one-line tab', () => {
    expect(sideChatTitle('line one\nline two\t  three')).toBe(
      `line one line two three${SIDE_CHAT_TITLE_SUFFIX}`
    )
  })

  it('caps long questions with an ellipsis instead of overflowing the tab', () => {
    const title = sideChatTitle('a'.repeat(200))
    expect(title.endsWith(SIDE_CHAT_TITLE_SUFFIX)).toBe(true)
    expect(title.length).toBeLessThan(60)
    expect(title).toContain('…')
  })

  it('falls back to a generic label rather than producing a blank tab', () => {
    expect(sideChatTitle('   ')).toBe(`Side chat${SIDE_CHAT_TITLE_SUFFIX}`)
  })

  it('cannot be double-marked by a question that already contains the marker', () => {
    const title = sideChatTitle('is this a (side chat)')
    expect(title.match(/\(side chat\)/g)).toHaveLength(1)
  })

  it('round-trips through the predicate and the splitter', () => {
    const title = sideChatTitle('why is the router picking groq?')
    expect(isSideChatTitle(title)).toBe(true)
    expect(splitSideChatTitle(title).label).toBe('why is the router picking groq?')
  })
})

describe('isSideChatTitle', () => {
  it('never fires on a Task-tool subagent title', () => {
    // The two markers must not overlap: both kinds of child session share one tab strip,
    // and mislabelling an agent delegation as the user's own tangent is the failure mode.
    const subagent = 'audit the routing slice (@general-purpose subagent)'
    expect(isSideChatTitle(subagent)).toBe(false)
    expect(splitSubagentTitle(subagent).agent).toBe('general-purpose')
  })

  it('is false for plain, empty, and non-string titles', () => {
    for (const bad of ['', '   ', 'a normal session', null, undefined]) {
      expect(isSideChatTitle(bad)).toBe(false)
    }
  })
})

describe('splitSideChatTitle', () => {
  it('returns unmarked titles whole and never renders blank', () => {
    expect(splitSideChatTitle('untouched').label).toBe('untouched')
    expect(splitSideChatTitle('').label).toBe('Side chat')
    expect(splitSideChatTitle(SIDE_CHAT_TITLE_SUFFIX).label).toBe('Side chat')
  })
})
