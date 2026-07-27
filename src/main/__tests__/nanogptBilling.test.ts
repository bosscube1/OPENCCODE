import { describe, expect, it } from 'vitest'
import { classifyBilling } from '../nanogptBilling'

describe('classifyBilling', () => {
  it('returns unknown for an absent paymentSource', () => {
    expect(classifyBilling(undefined)).toBe('unknown')
    expect(classifyBilling(null)).toBe('unknown')
  })

  it('returns unknown for an empty or blank string', () => {
    expect(classifyBilling('')).toBe('unknown')
    expect(classifyBilling('   ')).toBe('unknown')
  })

  it('recognizes a subscription marker, case-insensitively and as a substring', () => {
    expect(classifyBilling('subscription')).toBe('subscription')
    expect(classifyBilling('Subscription')).toBe('subscription')
    expect(classifyBilling('SUBSCRIPTION')).toBe('subscription')
    expect(classifyBilling('nanogpt-subscription')).toBe('subscription')
    expect(classifyBilling('subscription_credit')).toBe('subscription')
  })

  it('treats any other present, non-subscription value as balance', () => {
    expect(classifyBilling('balance')).toBe('balance')
    expect(classifyBilling('wallet')).toBe('balance')
    expect(classifyBilling('nano')).toBe('balance')
    expect(classifyBilling('usd')).toBe('balance')
  })

  it('documented invariant: an absent value must NOT be treated as balance', () => {
    // This is the guard against blacklisting every model the first time NanoGPT omits the field:
    // absence must resolve to 'unknown', never to the pessimistic 'balance' classification.
    expect(classifyBilling(undefined)).not.toBe('balance')
    expect(classifyBilling(null)).not.toBe('balance')
  })
})
