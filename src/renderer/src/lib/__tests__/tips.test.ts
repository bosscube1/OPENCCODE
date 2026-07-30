import { describe, expect, it } from 'vitest'
import {
  type Tip,
  type TipsPrefs,
  TIPS,
  nextTip,
  remainingTipCount,
  dismissTip,
  setTipsEnabled,
  resetTips,
  tipShortcutKeys
} from '../tips'
import { SHORTCUTS } from '../shortcuts'

// Small fixture array for testing pure functions without depending on the live catalogue
const fixtureTips: Tip[] = [
  {
    id: 'fixture-tip-1',
    title: 'First fixture tip',
    body: 'Body of the first tip'
  },
  {
    id: 'fixture-tip-2',
    title: 'Second fixture tip',
    body: 'Body of the second tip',
    shortcutId: 'command-palette'
  },
  {
    id: 'fixture-tip-3',
    title: 'Third fixture tip',
    body: 'Body of the third tip'
  }
]

describe('nextTip', () => {
  it('returns the first tip not present in dismissed', () => {
    const prefs: TipsPrefs = { enabled: true, dismissed: ['fixture-tip-1'] }
    const result = nextTip(prefs, fixtureTips)
    expect(result?.id).toBe('fixture-tip-2')
  })

  it('returns null when enabled is false, even though undismissed tips exist', () => {
    const prefs: TipsPrefs = { enabled: false, dismissed: [] }
    const result = nextTip(prefs, fixtureTips)
    expect(result).toBe(null)
  })

  it('returns null when every tip id is dismissed', () => {
    const prefs: TipsPrefs = {
      enabled: true,
      dismissed: ['fixture-tip-1', 'fixture-tip-2', 'fixture-tip-3']
    }
    const result = nextTip(prefs, fixtureTips)
    expect(result).toBe(null)
  })

  it('ignores unknown ids in dismissed (does not skip real tips)', () => {
    const prefs: TipsPrefs = {
      enabled: true,
      dismissed: ['unknown-id-that-does-not-exist', 'another-unknown-id']
    }
    const result = nextTip(prefs, fixtureTips)
    expect(result?.id).toBe('fixture-tip-1')
  })
})

describe('dismissTip', () => {
  it('appends the id and does NOT mutate the input object', () => {
    const prefs: TipsPrefs = { enabled: true, dismissed: ['fixture-tip-1'] }
    const result = dismissTip(prefs, 'fixture-tip-2')

    // Original object must be unchanged
    expect(prefs.dismissed).toEqual(['fixture-tip-1'])
    // Result must be a different reference
    expect(result).not.toBe(prefs)
    // Result must contain the new id
    expect(result.dismissed).toEqual(['fixture-tip-1', 'fixture-tip-2'])
  })

  it('is idempotent — calling twice with the same id appends it only once', () => {
    let prefs: TipsPrefs = { enabled: true, dismissed: [] }
    prefs = dismissTip(prefs, 'fixture-tip-1')
    prefs = dismissTip(prefs, 'fixture-tip-1')

    expect(prefs.dismissed).toEqual(['fixture-tip-1'])
  })
})

describe('setTipsEnabled', () => {
  it('flips enabled while preserving dismissed', () => {
    const prefs: TipsPrefs = { enabled: true, dismissed: ['fixture-tip-1', 'fixture-tip-2'] }
    const result = setTipsEnabled(prefs, false)

    expect(result.enabled).toBe(false)
    expect(result.dismissed).toEqual(['fixture-tip-1', 'fixture-tip-2'])
  })
})

describe('resetTips', () => {
  it('clears dismissed and sets enabled to true', () => {
    const prefs: TipsPrefs = { enabled: true, dismissed: ['fixture-tip-1', 'fixture-tip-2'] }
    const result = resetTips(prefs)

    expect(result.enabled).toBe(true)
    expect(result.dismissed).toEqual([])
  })

  it('sets enabled to true even when input had enabled: false', () => {
    const prefs: TipsPrefs = { enabled: false, dismissed: ['fixture-tip-1'] }
    const result = resetTips(prefs)

    expect(result.enabled).toBe(true)
    expect(result.dismissed).toEqual([])
  })
})

describe('remainingTipCount', () => {
  it('counts only undismissed tips with the injected fixture', () => {
    const prefs: TipsPrefs = { enabled: true, dismissed: ['fixture-tip-1'] }
    const result = remainingTipCount(prefs, fixtureTips)

    expect(result).toBe(2)
  })

  it('returns 0 when enabled is false', () => {
    const prefs: TipsPrefs = { enabled: false, dismissed: [] }
    const result = remainingTipCount(prefs, fixtureTips)

    expect(result).toBe(0)
  })
})

describe('TIPS catalogue integrity', () => {
  it('every tip id is unique', () => {
    const ids = TIPS.map((tip) => tip.id)
    const uniqueIds = new Set(ids)
    expect(uniqueIds.size).toBe(ids.length)
  })

  it('every tip has non-empty title and body', () => {
    for (const tip of TIPS) {
      expect(tip.title).toBeTruthy()
      expect(tip.body).toBeTruthy()
      expect(typeof tip.title).toBe('string')
      expect(typeof tip.body).toBe('string')
    }
  })
})

describe('tipShortcutKeys', () => {
  it('returns a non-empty string for a real tip whose shortcutId exists in SHORTCUTS', () => {
    // Find a tip with a shortcutId that exists in SHORTCUTS
    const tipWithShortcut = TIPS.find((tip) => {
      if (!tip.shortcutId) return false
      return SHORTCUTS.some((s) => s.id === tip.shortcutId)
    })
    expect(tipWithShortcut).toBeDefined()

    if (tipWithShortcut) {
      const keys = tipShortcutKeys(tipWithShortcut)
      expect(keys).toBeTruthy()
      expect(typeof keys).toBe('string')
    }
  })

  it('returns null for a tip with no shortcutId', () => {
    const tipWithoutShortcut = TIPS.find((tip) => !tip.shortcutId)
    expect(tipWithoutShortcut).toBeDefined()

    if (tipWithoutShortcut) {
      const keys = tipShortcutKeys(tipWithoutShortcut)
      expect(keys).toBe(null)
    }
  })

  it('returns null for a tip with a bogus shortcutId that does not exist in SHORTCUTS', () => {
    const bogusTip: Tip = {
      id: 'bogus-test-tip',
      title: 'Bogus',
      body: 'Bogus body',
      shortcutId: 'nonexistent-shortcut-id-that-will-never-exist'
    }
    const keys = tipShortcutKeys(bogusTip)
    expect(keys).toBe(null)
  })
})
