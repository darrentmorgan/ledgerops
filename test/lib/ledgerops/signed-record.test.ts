import {describe, expect, it} from 'vitest'
import {digestJson, type Digest, type JsonPrimitive, type JsonValue} from '../../../src/lib/ledgerops/canonical.js'
import {
  canonicalValue,
  defineSignedRecord,
  digest,
  finiteNumber,
  label,
  literal,
  oneOf,
  shape,
  stringArray,
} from '../../../src/lib/ledgerops/signed-record.js'

const HEX = 'a'.repeat(64)
const OTHER_HEX = 'b'.repeat(64)

interface Widget {
  readonly kind: 'widget.v1'
  readonly name: string
  readonly grade: 'gold' | 'silver'
  readonly count: number
  readonly tags: readonly string[]
  readonly body: JsonValue
  readonly bodyDigest: Digest
  readonly note?: string
  readonly widgetDigest: Digest
}

function countMatchesTags(widget: Widget): boolean {
  return widget.count === widget.tags.length
}

const widgetRecord = defineSignedRecord<Widget, 'widgetDigest', 'bodyDigest'>({
  label: 'test.widget.v1',
  digestField: 'widgetDigest',
  fields: {
    kind: {check: literal('widget.v1')},
    name: {check: label()},
    grade: {check: oneOf('gold', 'silver')},
    count: {check: finiteNumber()},
    tags: {check: stringArray()},
    body: {check: canonicalValue()},
    bodyDigest: {check: digest(), derive: supplied => digestJson(supplied.body)},
    note: {check: label(), optional: true},
  },
  invariants: [countMatchesTags],
})

type WidgetFields = Parameters<typeof widgetRecord.create>[0]

function widgetFields(overrides: Partial<Record<string, unknown>> = {}): WidgetFields {
  return {
    kind: 'widget.v1',
    name: 'first',
    grade: 'gold',
    count: 2,
    tags: ['a', 'b'],
    body: {amount: '1.00'},
    ...overrides,
  } as WidgetFields
}

/** Sign an arbitrary field map the way the module does, to forge records the digest cannot catch. */
function forge(fields: Record<string, unknown>, preamble?: Record<string, JsonPrimitive>): Record<string, unknown> {
  return {...fields, widgetDigest: digestJson(preamble === undefined ? fields : {...preamble, ...fields})}
}

function unsignedOf(widget: Widget): Record<string, unknown> {
  const {widgetDigest: _ignored, ...rest} = widget
  return {...rest}
}

describe('signed record create and verify', () => {
  it('round trips a created record', () => {
    const widget = widgetRecord.create(widgetFields())

    expect(widgetRecord.verify(widget)).toBe(true)
    expect(widget.bodyDigest).toBe(digestJson({amount: '1.00'}))
    expect(widget.widgetDigest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('reports its sorted key set including the digest field', () => {
    expect(widgetRecord.keys).toEqual([
      'body',
      'bodyDigest',
      'count',
      'grade',
      'kind',
      'name',
      'note',
      'tags',
      'widgetDigest',
    ])
    expect(widgetRecord.digestField).toBe('widgetDigest')
    expect(widgetRecord.label).toBe('test.widget.v1')
  })

  it('assembles properties in declaration order with the digest last', () => {
    expect(Object.keys(widgetRecord.create(widgetFields({note: 'seen'})))).toEqual([
      'kind',
      'name',
      'grade',
      'count',
      'tags',
      'body',
      'bodyDigest',
      'note',
      'widgetDigest',
    ])
  })

  it('deep freezes the record it returns', () => {
    const widget = widgetRecord.create(widgetFields())

    expect(Object.isFrozen(widget)).toBe(true)
    expect(Object.isFrozen(widget.body)).toBe(true)
  })

  it('never digests the descriptor label', () => {
    const renamed = defineSignedRecord<Widget, 'widgetDigest', 'bodyDigest'>({
      label: 'test.widget.renamed',
      digestField: 'widgetDigest',
      fields: {
        kind: {check: literal('widget.v1')},
        name: {check: label()},
        grade: {check: oneOf('gold', 'silver')},
        count: {check: finiteNumber()},
        tags: {check: stringArray()},
        body: {check: canonicalValue()},
        bodyDigest: {check: digest(), derive: supplied => digestJson(supplied.body)},
        note: {check: label(), optional: true},
      },
    })

    expect(renamed.create(widgetFields()).widgetDigest).toBe(widgetRecord.create(widgetFields()).widgetDigest)
  })
})

describe('signed record field checks', () => {
  it('throws naming the record and the field when a supplied value fails its check', () => {
    expect(() => widgetRecord.create(widgetFields({name: '   '}))).toThrow(
      new TypeError('test.widget.v1.name failed its field check'),
    )
    expect(() => widgetRecord.create(widgetFields({grade: 'bronze'}))).toThrow(
      new TypeError('test.widget.v1.grade failed its field check'),
    )
    expect(() => widgetRecord.create(widgetFields({count: Number.NaN}))).toThrow(
      new TypeError('test.widget.v1.count failed its field check'),
    )
    expect(() => widgetRecord.create(widgetFields({kind: 'widget.v2'}))).toThrow(
      new TypeError('test.widget.v1.kind failed its field check'),
    )
    expect(() => widgetRecord.create(widgetFields({tags: ['a', 2]}))).toThrow(
      new TypeError('test.widget.v1.tags failed its field check'),
    )
    expect(() => widgetRecord.create(widgetFields({body: undefined}))).toThrow(
      new TypeError('test.widget.v1.body failed its field check'),
    )
  })

  it('rejects a stored value that fails its check', () => {
    const widget = widgetRecord.create(widgetFields())

    expect(widgetRecord.verify(forge({...unsignedOf(widget), name: ''}))).toBe(false)
    expect(widgetRecord.verify(forge({...unsignedOf(widget), grade: 'bronze'}))).toBe(false)
    expect(widgetRecord.verify(forge({...unsignedOf(widget), count: '2'}))).toBe(false)
    expect(widgetRecord.verify({...unsignedOf(widget), count: Number.POSITIVE_INFINITY, widgetDigest: HEX})).toBe(false)
  })
})

describe('signed record optional fields', () => {
  it('omits an optional field supplied as undefined', () => {
    const omitted = widgetRecord.create(widgetFields({note: undefined}))

    expect('note' in omitted).toBe(false)
    expect(omitted.widgetDigest).toBe(widgetRecord.create(widgetFields()).widgetDigest)
    expect(widgetRecord.verify(omitted)).toBe(true)
  })

  it('signs an optional field that is present', () => {
    const present = widgetRecord.create(widgetFields({note: 'seen'}))

    expect(present.note).toBe('seen')
    expect(present.widgetDigest).not.toBe(widgetRecord.create(widgetFields()).widgetDigest)
    expect(widgetRecord.verify(present)).toBe(true)
  })

  it('rejects an optional key that is present but undefined', () => {
    const widget = widgetRecord.create(widgetFields())

    expect(widgetRecord.verify({...widget, note: undefined})).toBe(false)
    expect(widgetRecord.verify({...widgetRecord.create(widgetFields({note: 'seen'})), note: undefined})).toBe(false)
  })

  it('rejects a missing required field', () => {
    const widget = widgetRecord.create(widgetFields())
    const {name: _dropped, ...rest} = unsignedOf(widget)

    expect(widgetRecord.verify(forge(rest))).toBe(false)
  })
})

describe('signed record extra keys', () => {
  it('rejects an undeclared key on create', () => {
    expect(() => widgetRecord.create(widgetFields({extra: 1}))).toThrow(
      new TypeError('test.widget.v1.extra is not a supplied field'),
    )
  })

  it('rejects the digest field and derived fields on create', () => {
    expect(() => widgetRecord.create(widgetFields({widgetDigest: HEX}))).toThrow(
      new TypeError('test.widget.v1.widgetDigest is not a supplied field'),
    )
    expect(() => widgetRecord.create(widgetFields({bodyDigest: HEX}))).toThrow(
      new TypeError('test.widget.v1.bodyDigest is not a supplied field'),
    )
  })

  it('rejects an undeclared key on verify even when the digest covers it', () => {
    const widget = widgetRecord.create(widgetFields())

    expect(widgetRecord.verify({...widget, extra: 1})).toBe(false)
    expect(widgetRecord.verify(forge({...unsignedOf(widget), extra: 1}))).toBe(false)
  })
})

describe('signed record derived fields', () => {
  it('recomputes a derived field from the record itself', () => {
    const widget = widgetRecord.create(widgetFields())

    expect(widgetRecord.verify(forge({...unsignedOf(widget), bodyDigest: digestJson({amount: '9.99'})}))).toBe(false)
  })

  it('rejects a body swapped under a re-signed record', () => {
    const widget = widgetRecord.create(widgetFields())

    expect(widgetRecord.verify(forge({...unsignedOf(widget), body: {amount: '9.99'}}))).toBe(false)
  })
})

describe('signed record invariants', () => {
  it('throws naming the invariant on create', () => {
    expect(() => widgetRecord.create(widgetFields({count: 3}))).toThrow(
      new TypeError('test.widget.v1 invariant countMatchesTags does not hold'),
    )
  })

  it('returns false on verify for a re-signed record that breaks an invariant', () => {
    const widget = widgetRecord.create(widgetFields())

    expect(widgetRecord.verify(forge({...unsignedOf(widget), count: 3}))).toBe(false)
  })

  it('treats a throwing invariant as a failure on both sides', () => {
    function alwaysThrows(): boolean {
      throw new Error('invariant exploded')
    }
    const brittle = defineSignedRecord<{readonly value: string; readonly recordDigest: Digest}, 'recordDigest'>({
      label: 'test.brittle.v1',
      digestField: 'recordDigest',
      fields: {value: {check: label()}},
      invariants: [alwaysThrows],
    })

    expect(() => brittle.create({value: 'x'})).toThrow(
      new TypeError('test.brittle.v1 invariant alwaysThrows does not hold'),
    )
    expect(brittle.verify({value: 'x', recordDigest: digestJson({value: 'x'})})).toBe(false)
  })
})

describe('signed record digest preamble', () => {
  interface Stamped {
    readonly value: string
    readonly stampDigest: Digest
  }

  const PREAMBLE = {kind: 'test.stamp.v1'} as const

  const stamped = defineSignedRecord<Stamped, 'stampDigest'>({
    label: 'test.stamped.v1',
    digestField: 'stampDigest',
    digestPreamble: PREAMBLE,
    fields: {value: {check: label()}},
  })

  const unstamped = defineSignedRecord<Stamped, 'stampDigest'>({
    label: 'test.unstamped.v1',
    digestField: 'stampDigest',
    fields: {value: {check: label()}},
  })

  it('mixes the preamble into the digest without attaching it to the record', () => {
    const record = stamped.create({value: 'x'})

    expect(Object.keys(record)).toEqual(['value', 'stampDigest'])
    expect(record.stampDigest).toBe(digestJson({kind: 'test.stamp.v1', value: 'x'}))
    expect(record.stampDigest).not.toBe(unstamped.create({value: 'x'}).stampDigest)
    expect(stamped.verify(record)).toBe(true)
    expect(unstamped.verify(record)).toBe(false)
  })

  it('throws at define time when a preamble key collides', () => {
    expect(() =>
      defineSignedRecord<Stamped, 'stampDigest'>({
        label: 'test.collide.v1',
        digestField: 'stampDigest',
        digestPreamble: {value: 'x'},
        fields: {value: {check: label()}},
      }),
    ).toThrow(new TypeError('test.collide.v1 digest preamble key value collides with a record field'))

    expect(() =>
      defineSignedRecord<Stamped, 'stampDigest'>({
        label: 'test.collide.v2',
        digestField: 'stampDigest',
        digestPreamble: {stampDigest: 'x'},
        fields: {value: {check: label()}},
      }),
    ).toThrow(new TypeError('test.collide.v2 digest preamble key stampDigest collides with a record field'))
  })
})

describe('signed record verify is total', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['a string', 'widget'],
    ['a boolean', true],
    ['an array', [1, 2, 3]],
    ['an empty object', {}],
    ['a function', () => 'widget'],
  ])('returns false for %s', (_name, value) => {
    expect(widgetRecord.verify(value)).toBe(false)
  })

  it('returns false for a circular value', () => {
    const widget = widgetRecord.create(widgetFields())
    const body: Record<string, unknown> = {}
    body.self = body

    expect(widgetRecord.verify({...unsignedOf(widget), body, widgetDigest: HEX})).toBe(false)
  })

  it('returns false for a class instance', () => {
    class Widgetish {
      readonly kind = 'widget.v1'
    }

    expect(widgetRecord.verify(new Widgetish())).toBe(false)
    expect(widgetRecord.verify(Object.assign(new Widgetish(), widgetRecord.create(widgetFields())))).toBe(false)
  })

  it('returns false for a symbol-keyed record', () => {
    const widget = widgetRecord.create(widgetFields())

    expect(widgetRecord.verify({...widget, [Symbol('smuggled')]: 'payload'})).toBe(false)
  })

  it('returns false without rethrowing a throwing getter', () => {
    const widget = widgetRecord.create(widgetFields())
    const hostile: Record<string, unknown> = {...widget}
    Object.defineProperty(hostile, 'name', {
      enumerable: true,
      get() {
        throw new Error('getter exploded')
      },
    })

    expect(widgetRecord.verify(hostile)).toBe(false)
  })

  it('returns false for an accessor-backed field even when the getter answers correctly', () => {
    const widget = widgetRecord.create(widgetFields())
    const hostile: Record<string, unknown> = {...widget}
    Object.defineProperty(hostile, 'name', {
      enumerable: true,
      configurable: true,
      get() {
        return widget.name
      },
    })

    expect(widgetRecord.verify(hostile)).toBe(false)
  })

  it('returns false for a hidden non-enumerable accessor on a declared optional field', () => {
    const widget = widgetRecord.create(widgetFields())
    const hostile: Record<string, unknown> = {...widget}
    let read = 0
    Object.defineProperty(hostile, 'note', {
      enumerable: false,
      configurable: true,
      get() {
        read += 1
        return read === 1 ? undefined : 'unsigned value'
      },
    })

    expect(widgetRecord.verify(hostile)).toBe(false)
  })

  it('returns false for a non-enumerable data property', () => {
    const widget = widgetRecord.create(widgetFields())
    const hostile: Record<string, unknown> = {...widget}
    Object.defineProperty(hostile, 'note', {
      enumerable: false,
      configurable: true,
      value: 'hidden',
    })

    expect(widgetRecord.verify(hostile)).toBe(false)
  })

  it('returns false when the digest field is present but undefined', () => {
    const widget = widgetRecord.create(widgetFields())

    expect(widgetRecord.verify({...widget, widgetDigest: undefined})).toBe(false)
    expect(widgetRecord.verify({...unsignedOf(widget)})).toBe(false)
    expect(widgetRecord.verify({...unsignedOf(widget), widgetDigest: OTHER_HEX})).toBe(false)
    expect(widgetRecord.verify({...unsignedOf(widget), widgetDigest: 'not-a-digest'})).toBe(false)
  })

  it('accepts a null-prototype record', () => {
    const widget = widgetRecord.create(widgetFields())

    expect(widgetRecord.verify(Object.assign(Object.create(null), widget))).toBe(true)
  })
})

describe('signed record parse', () => {
  it('returns a frozen snapshot equal to an honest record', () => {
    const widget = widgetRecord.create(widgetFields())
    const parsed = widgetRecord.parse({...widget, body: {amount: '1.00'}})

    expect(parsed).toEqual(widget)
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed?.body)).toBe(true)
  })

  it('returns undefined for everything verify rejects', () => {
    const widget = widgetRecord.create(widgetFields())

    expect(widgetRecord.parse(null)).toBeUndefined()
    expect(widgetRecord.parse({...widget, extra: 1})).toBeUndefined()
    expect(widgetRecord.parse({...unsignedOf(widget)})).toBeUndefined()
  })

  it('a Proxy key-set shift at serialization time cannot smuggle an unsigned field', () => {
    // The proxy answers every key-set question honestly until the first
    // property read — the moment serialization starts — and lies afterwards.
    // Checks that read the input instead of the snapshot pass before the
    // lie begins, so a pre-snapshot exact-key check would admit `extra`.
    const widget = widgetRecord.create(widgetFields())
    const base: Record<string, unknown> = {...widget}
    let readStarted = false
    const hostile = new Proxy(base, {
      ownKeys(target) {
        return readStarted ? [...Reflect.ownKeys(target), 'extra'] : Reflect.ownKeys(target)
      },
      getOwnPropertyDescriptor(target, key) {
        if (key === 'extra') return {configurable: true, enumerable: true, value: 1, writable: true}
        return Reflect.getOwnPropertyDescriptor(target, key)
      },
      get(target, key, receiver) {
        readStarted = true
        return key === 'extra' ? 1 : Reflect.get(target, key, receiver)
      },
    })

    const parsed = widgetRecord.parse(hostile)

    if (parsed !== undefined) {
      expect(Object.keys(parsed).sort()).toEqual(Object.keys(widget).sort())
      expect((parsed as unknown as Record<string, unknown>).extra).toBeUndefined()
    }
  })

  it('snapshots nested accessor values so later reads cannot diverge', () => {
    const widget = widgetRecord.create(widgetFields())
    let reads = 0
    const shiftyBody: Record<string, unknown> = {}
    Object.defineProperty(shiftyBody, 'amount', {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1
        return reads === 1 ? '1.00' : '999.00'
      },
    })
    const hostile = {...unsignedOf(widget), body: shiftyBody, widgetDigest: widget.widgetDigest}

    const parsed = widgetRecord.parse(hostile)

    expect(parsed).toBeDefined()
    expect((parsed?.body as Record<string, unknown> | undefined)?.amount).toBe('1.00')
    expect((parsed?.body as Record<string, unknown> | undefined)?.amount).toBe('1.00')
    expect((hostile.body as Record<string, unknown>).amount).toBe('999.00')
  })
})

describe('field check combinators', () => {
  it('label accepts non-empty strings only', () => {
    const check = label()

    expect(check('name')).toBe(true)
    expect(check(' padded ')).toBe(true)
    expect(check('')).toBe(false)
    expect(check('   ')).toBe(false)
    expect(check(42)).toBe(false)
    expect(check(null)).toBe(false)
    expect(check(undefined)).toBe(false)
    expect(check(['name'])).toBe(false)
  })

  it('digest accepts lowercase sha-256 hex only', () => {
    const check = digest()

    expect(check(HEX)).toBe(true)
    expect(check(HEX.toUpperCase())).toBe(false)
    expect(check('a'.repeat(63))).toBe(false)
    expect(check('a'.repeat(65))).toBe(false)
    expect(check('g'.repeat(64))).toBe(false)
    expect(check(null)).toBe(false)
  })

  it('finiteNumber rejects non-finite numbers and numeric strings', () => {
    const check = finiteNumber()

    expect(check(0)).toBe(true)
    expect(check(-1.5)).toBe(true)
    expect(check(Number.NaN)).toBe(false)
    expect(check(Number.POSITIVE_INFINITY)).toBe(false)
    expect(check('1')).toBe(false)
    expect(check(null)).toBe(false)
  })

  it('literal accepts one primitive value', () => {
    expect(literal('widget.v1')('widget.v1')).toBe(true)
    expect(literal('widget.v1')('widget.v2')).toBe(false)
    expect(literal(1)(1)).toBe(true)
    expect(literal(1)('1')).toBe(false)
    expect(literal(true)(true)).toBe(true)
    expect(literal(true)(1)).toBe(false)
    expect(literal(null)(null)).toBe(true)
    expect(literal(null)(undefined)).toBe(false)
  })

  it('oneOf accepts declared members only', () => {
    const check = oneOf('gold', 'silver')

    expect(check('gold')).toBe(true)
    expect(check('silver')).toBe(true)
    expect(check('bronze')).toBe(false)
    expect(check(null)).toBe(false)
    expect(oneOf<JsonPrimitive>()('gold')).toBe(false)
  })

  it('stringArray accepts arrays of strings only', () => {
    const check = stringArray()

    expect(check([])).toBe(true)
    expect(check(['a', 'b'])).toBe(true)
    expect(check(['a', 1])).toBe(false)
    expect(check('a')).toBe(false)
    expect(check({0: 'a', length: 1})).toBe(false)
  })

  it('canonicalValue accepts exactly what canonical JSON serializes', () => {
    const check = canonicalValue()
    const circular: Record<string, unknown> = {}
    circular.self = circular

    expect(check({a: 1, b: [null, 'x']})).toBe(true)
    expect(check(null)).toBe(true)
    expect(check([1, 2])).toBe(true)
    expect(check(undefined)).toBe(false)
    expect(check(Number.NaN)).toBe(false)
    expect(check(circular)).toBe(false)
    expect(check(new Map())).toBe(false)
    expect(check(() => 'x')).toBe(false)
  })
})

describe('shape', () => {
  interface Pair {
    readonly left: string
    readonly right?: Digest
  }

  const isPair = shape<Pair>()({
    fields: {
      left: {check: label()},
      right: {check: digest(), optional: true},
    },
  })

  it('accepts the exact key set', () => {
    expect(isPair({left: 'a'})).toBe(true)
    expect(isPair({left: 'a', right: HEX})).toBe(true)
    expect(isPair(Object.assign(Object.create(null), {left: 'a'}))).toBe(true)
  })

  it('rejects extra keys, missing required keys and present-but-undefined optionals', () => {
    expect(isPair({left: 'a', extra: 1})).toBe(false)
    expect(isPair({right: HEX})).toBe(false)
    expect(isPair({})).toBe(false)
    expect(isPair({left: 'a', right: undefined})).toBe(false)
    expect(isPair({left: 'a', right: 'not-a-digest'})).toBe(false)
    expect(isPair({left: '', right: HEX})).toBe(false)
  })

  it('is total against hostile values', () => {
    class Pairish {
      readonly left = 'a'
    }
    const hostile: Record<string, unknown> = {}
    Object.defineProperty(hostile, 'left', {
      enumerable: true,
      get() {
        throw new Error('getter exploded')
      },
    })

    expect(isPair(null)).toBe(false)
    expect(isPair(undefined)).toBe(false)
    expect(isPair('left')).toBe(false)
    expect(isPair(['left'])).toBe(false)
    expect(isPair(new Pairish())).toBe(false)
    expect(isPair(hostile)).toBe(false)
  })
})
