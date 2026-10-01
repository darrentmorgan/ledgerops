import {describe, expect, it} from 'vitest'
import {containsSecretShapedData} from '../../../src/lib/ledgerops/data-hygiene.js'

describe('offline workflow data hygiene', () => {
  it('rejects custom-prototype arrays without invoking overridden iteration methods', () => {
    const customPrototype = Object.create(Array.prototype) as {
      some: () => boolean
      every: () => boolean
    }
    customPrototype.some = () => false
    customPrototype.every = () => true
    const values = [new Date('2026-08-07T00:00:00.000Z')]
    Object.setPrototypeOf(values, customPrototype)

    expect(containsSecretShapedData(values)).toBe(true)
  })

  it('rejects credential-shaped keys recursively', () => {
    expect(containsSecretShapedData({nested: {accessToken: 'synthetic-value'}})).toBe(true)
    expect(containsSecretShapedData({nested: {client_secret: 'synthetic-value'}})).toBe(true)
  })

  it('rejects obvious credential wire formats and cycles', () => {
    expect(containsSecretShapedData({value: 'Bearer synthetic-value'})).toBe(true)
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(containsSecretShapedData(circular)).toBe(true)
  })

  it('allows ordinary synthetic workflow data and repeated object references', () => {
    const shared = {label: 'synthetic'}
    expect(containsSecretShapedData({first: shared, second: shared})).toBe(false)
  })
})
