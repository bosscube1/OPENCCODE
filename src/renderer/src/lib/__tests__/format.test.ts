import { describe, expect, it } from 'vitest'
import { formatCost, formatDuration, formatTokens } from '../format'

describe('formatting helpers', () => {
  it('formats cost with appropriate precision', () => {
    expect(formatCost(0.0015)).toBe('$0.0015')
    expect(formatCost(0)).toBe('$0.00')
  })

  it('formats token counts with k and M suffix', () => {
    expect(formatTokens(450)).toBe('450')
    expect(formatTokens(1500)).toBe('1.5k')
    expect(formatTokens(2500000)).toBe('2.5M')
  })

  it('formats duration nicely from milliseconds', () => {
    expect(formatDuration(500)).toBe('500ms')
    expect(formatDuration(12000)).toBe('12s')
    expect(formatDuration(75000)).toBe('1m 15s')
  })
})
