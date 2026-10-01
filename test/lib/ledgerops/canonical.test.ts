import {describe, expect, it} from 'vitest'
import {canonicalJson, digestJson} from '../../../src/lib/ledgerops/canonical.js'

describe('ledgerops canonicalization', () => {
  it('sorts object keys recursively while preserving array order', () => {
    expect(
      canonicalJson({
        z: 1,
        nested: {z: 3, a: 2},
        array: [{z: 4, a: 5}, 'second', 'third'],
        a: 0,
      }),
    ).toBe('{"a":0,"array":[{"a":5,"z":4},"second","third"],"nested":{"a":2,"z":3},"z":1}')

    expect(canonicalJson({array: ['first', 'second']})).not.toBe(canonicalJson({array: ['second', 'first']}))
    expect(digestJson({z: 1, a: 2})).toBe(digestJson({a: 2, z: 1}))
  })

  it.each([
    ['an undefined object property', {value: undefined}],
    ['an undefined array member', {value: [1, undefined]}],
    ['NaN', {value: Number.NaN}],
    ['positive infinity', {value: Number.POSITIVE_INFINITY}],
    ['negative infinity', {value: Number.NEGATIVE_INFINITY}],
  ])('rejects %s', (_label, fixture) => {
    expect(() => canonicalJson(fixture.value)).toThrow()
  })

  it('keeps decimal strings exact instead of coercing them to numbers', () => {
    const value = {
      exact: '0.000000000000000000000000000001',
      large: '123456789012345678901234567890.12345678901234567890',
    }

    expect(canonicalJson(value)).toBe(`{"exact":"${value.exact}","large":"${value.large}"}`)
    expect(canonicalJson(value)).toContain(value.exact)
    expect(canonicalJson(value)).toContain(value.large)
  })
})
