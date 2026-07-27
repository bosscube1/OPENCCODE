import { describe, expect, it } from 'vitest'
import {
  canGenerateWith,
  classifyBilling,
  isNanoFamily,
  label,
  pickDefaultImageModel,
  sortImageModels,
  type ImageModelLike
} from '../imageModels'

describe('isNanoFamily', () => {
  it('matches NanoGPT nano-family ids and names', () => {
    expect(isNanoFamily({ id: 'nano-banana' })).toBe(true)
    expect(isNanoFamily({ id: 'nano-banana-pro' })).toBe(true)
    expect(isNanoFamily({ id: 'google/nano-banana' })).toBe(true)
    expect(isNanoFamily({ id: 'some-id', name: 'Nano Banana Pro' })).toBe(true)
    expect(isNanoFamily({ id: 'some/nano' })).toBe(true)
  })

  it('does not match ids that merely contain "nano" as a substring (word-boundary anchored)', () => {
    // A naive `.includes('nano')` match would wrongly return true for all four of these.
    expect(isNanoFamily({ id: 'nanonymous-x' })).toBe(false)
    expect(isNanoFamily({ id: 'nanotech-diffusion' })).toBe(false)
    expect(isNanoFamily({ id: 'flux-pro' })).toBe(false)
    expect(isNanoFamily({ id: 'gpt-image-2' })).toBe(false)
  })
})

describe('sortImageModels', () => {
  it('places nano-family models first, non-nano ties broken alphabetically by label', () => {
    const models: ImageModelLike[] = [
      { id: 'flux-pro', name: 'Flux Pro' },
      { id: 'nano-banana', name: 'Nano Banana' },
      { id: 'aardvark-diffusion', name: 'Aardvark' }
    ]
    const sorted = sortImageModels(models)
    expect(sorted.map((m) => m.id)).toEqual(['nano-banana', 'aardvark-diffusion', 'flux-pro'])
  })

  it('sinks balance-billed models to the bottom regardless of nano status', () => {
    const models: ImageModelLike[] = [
      { id: 'nano-banana', name: 'Nano Banana' }, // nano, but balance-billed
      { id: 'flux-pro', name: 'Flux Pro' } // non-nano, not billed
    ]
    const sorted = sortImageModels(models, ['nano-banana'])
    expect(sorted.map((m) => m.id)).toEqual(['flux-pro', 'nano-banana'])
  })

  it('breaks ties alphabetically by label', () => {
    const models: ImageModelLike[] = [
      { id: 'b-id', name: 'Beta' },
      { id: 'a-id', name: 'Alpha' }
    ]
    expect(sortImageModels(models).map((m) => m.id)).toEqual(['a-id', 'b-id'])
  })
})

describe('label', () => {
  it('prefers name over id', () => {
    expect(label({ id: 'raw-id', name: 'Pretty Name' })).toBe('Pretty Name')
  })

  it('falls back to id when name is absent', () => {
    expect(label({ id: 'raw-id' })).toBe('raw-id')
  })

  it('falls back to id when name is an empty string', () => {
    expect(label({ id: 'raw-id', name: '' })).toBe('raw-id')
  })
})

describe('pickDefaultImageModel', () => {
  it('returns a nano model when one is eligible', () => {
    const models: ImageModelLike[] = [
      { id: 'flux-pro', name: 'Flux Pro' },
      { id: 'nano-banana', name: 'Nano Banana' }
    ]
    expect(pickDefaultImageModel(models, [], false)).toBe('nano-banana')
  })

  it('excludes balance-billed ids when subscriptionOnly is true', () => {
    const models: ImageModelLike[] = [
      { id: 'nano-banana', name: 'Nano Banana' },
      { id: 'flux-pro', name: 'Flux Pro' }
    ]
    expect(pickDefaultImageModel(models, ['nano-banana'], true)).toBe('flux-pro')
  })

  it('includes balance-billed ids when subscriptionOnly is false', () => {
    const models: ImageModelLike[] = [{ id: 'nano-banana', name: 'Nano Banana' }]
    expect(pickDefaultImageModel(models, ['nano-banana'], false)).toBe('nano-banana')
  })

  it('returns null for an empty catalogue', () => {
    expect(pickDefaultImageModel([], [], false)).toBeNull()
    expect(pickDefaultImageModel([], [], true)).toBeNull()
  })

  it('returns null when subscriptionOnly and every model is balance-billed', () => {
    const models: ImageModelLike[] = [
      { id: 'nano-banana', name: 'Nano Banana' },
      { id: 'flux-pro', name: 'Flux Pro' }
    ]
    expect(pickDefaultImageModel(models, ['nano-banana', 'flux-pro'], true)).toBeNull()
  })
})

describe('canGenerateWith', () => {
  it('is false only when subscriptionOnly is true and the id is balance-billed', () => {
    expect(canGenerateWith('nano-banana', ['nano-banana'], true)).toBe(false)
  })

  it('is true when subscriptionOnly is true but the id is not balance-billed', () => {
    expect(canGenerateWith('nano-banana', ['flux-pro'], true)).toBe(true)
  })

  it('is true when subscriptionOnly is false, billed or not', () => {
    expect(canGenerateWith('nano-banana', ['nano-banana'], false)).toBe(true)
    expect(canGenerateWith('nano-banana', [], false)).toBe(true)
  })
})

describe('classifyBilling (renderer copy)', () => {
  it('matches the documented classification table', () => {
    expect(classifyBilling(undefined)).toBe('unknown')
    expect(classifyBilling(null)).toBe('unknown')
    expect(classifyBilling('')).toBe('unknown')
    expect(classifyBilling('subscription')).toBe('subscription')
    expect(classifyBilling('Subscription')).toBe('subscription')
    expect(classifyBilling('balance')).toBe('balance')
    expect(classifyBilling('wallet')).toBe('balance')
  })

  // The renderer copy here must stay in exact lockstep with the main-process copy in
  // src/main/nanogptBilling.ts (see nanogptBilling.test.ts for its own copy of this table, and the
  // "Mirrors src/main/nanogptBilling.ts" comment atop classifyBilling in imageModels.ts). The
  // renderer cannot import main-process modules directly (see tsconfig.web.json's `include`, which
  // excludes src/main), so the two suites duplicate the same input/output table by hand rather than
  // sharing a fixture — if you change one copy's behavior, update both this table and
  // nanogptBilling.test.ts's table together.
  it('reproduces the same table as the main-process copy for shared key inputs', () => {
    const table: Array<[string | undefined | null, 'subscription' | 'balance' | 'unknown']> = [
      [undefined, 'unknown'],
      [null, 'unknown'],
      ['', 'unknown'],
      ['   ', 'unknown'],
      ['subscription', 'subscription'],
      ['SUBSCRIPTION', 'subscription'],
      ['nanogpt-subscription', 'subscription'],
      ['balance', 'balance'],
      ['wallet', 'balance'],
      ['nano', 'balance'],
      ['usd', 'balance']
    ]
    for (const [input, expected] of table) {
      expect(classifyBilling(input)).toBe(expected)
    }
  })
})
