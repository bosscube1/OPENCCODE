import { describe, it, expect } from 'vitest'

import {
  VIEW_MODES,
  describeViewMode,
  isViewMode,
  shouldCollapseTools,
  shouldHideTools,
  viewModeLabel,
  type ViewMode
} from '../viewMode'

/** Mirrors TOOLS_EXPANDED_TAIL in Chat.tsx. */
const EXPANDED_TAIL = 3

describe('shouldCollapseTools', () => {
  it('reproduces the pre-existing behaviour in normal mode', () => {
    // This is the exact predicate Chat.tsx used before view modes existed:
    // `visibleMessages.length - index > TOOLS_EXPANDED_TAIL`.
    for (const distance of [0, 1, 2, 3, 4, 10]) {
      expect(shouldCollapseTools('normal', distance, EXPANDED_TAIL)).toBe(distance > EXPANDED_TAIL)
    }
  })

  it('never collapses in verbose mode, however old the message', () => {
    for (const distance of [0, 1, 50, 5000]) {
      expect(shouldCollapseTools('verbose', distance, EXPANDED_TAIL)).toBe(false)
    }
  })

  it('always collapses in summary mode', () => {
    for (const distance of [0, 1, 50]) {
      expect(shouldCollapseTools('summary', distance, EXPANDED_TAIL)).toBe(true)
    }
  })
})

describe('shouldHideTools', () => {
  it('hides tool cards only in summary mode', () => {
    expect(shouldHideTools('summary')).toBe(true)
    expect(shouldHideTools('normal')).toBe(false)
    expect(shouldHideTools('verbose')).toBe(false)
  })

  it('never both hides and expands — summary must not claim tools are open', () => {
    // Guards the one incoherent combination: a mode that removes the cards while also
    // reporting them expanded would make the two predicates disagree at the call site.
    const incoherent = VIEW_MODES.filter(
      (mode) => shouldHideTools(mode) && !shouldCollapseTools(mode, 0, EXPANDED_TAIL)
    )
    expect(incoherent).toEqual([])
  })
})

describe('isViewMode', () => {
  it('accepts every declared mode', () => {
    for (const mode of VIEW_MODES) expect(isViewMode(mode)).toBe(true)
  })

  it('rejects anything else, so a corrupt pref falls back instead of throwing', () => {
    for (const bad of ['', 'NORMAL', 'compact', null, undefined, 0, {}, []]) {
      expect(isViewMode(bad)).toBe(false)
    }
  })
})

describe('labels', () => {
  it('gives every mode a distinct label and description', () => {
    const labels = VIEW_MODES.map(viewModeLabel)
    const described = VIEW_MODES.map(describeViewMode)
    expect(new Set(labels).size).toBe(VIEW_MODES.length)
    expect(new Set(described).size).toBe(VIEW_MODES.length)
    expect(described.every((text) => text.trim() !== '')).toBe(true)
  })

  it('covers the full union — a new mode must not silently fall through to Normal', () => {
    const modes: ViewMode[] = ['normal', 'verbose', 'summary']
    expect([...VIEW_MODES].sort()).toEqual([...modes].sort())
  })
})
