import {canonicalJson, deepFreeze, digestJson, type Digest, type JsonPrimitive, type JsonValue} from './canonical.js'

/**
 * Descriptor-driven signed records. A descriptor is the single statement of what
 * a record's digest covers; creation, verification and the key allowlist are all
 * derived from it, so a field can never be attached to a record without being
 * signed. This module is mechanism only — domain policy enters as the checks,
 * derivations and invariants a caller registers.
 */

/** Total membership test for one field value. A field check never throws. */
export type FieldCheck<T> = (value: unknown) => value is T

export function label(): FieldCheck<string> {
  return (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''
}

export function digest(): FieldCheck<Digest> {
  return (value: unknown): value is Digest => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

export function finiteNumber(): FieldCheck<number> {
  return (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
}

export function literal<T extends JsonPrimitive>(expected: T): FieldCheck<T> {
  return (value: unknown): value is T => value === expected
}

export function oneOf<T extends JsonPrimitive>(...members: readonly T[]): FieldCheck<T> {
  return (value: unknown): value is T => members.some(member => member === value)
}

export function stringArray(): FieldCheck<readonly string[]> {
  return (value: unknown): value is readonly string[] =>
    Array.isArray(value) && value.every(item => typeof item === 'string')
}

/** Accepts whatever canonical JSON can serialize; the field's declared type says what that means. */
export function canonicalValue<T extends JsonValue = JsonValue>(): FieldCheck<T> {
  return ((value: unknown): boolean => {
    try {
      canonicalJson(value)
      return true
    } catch {
      return false
    }
  }) as FieldCheck<T>
}

type OptionalFlag<TShape extends object, K extends keyof TShape> =
  // biome-ignore lint/complexity/noBannedTypes: Empty object assignability detects optional properties.
  {} extends Pick<TShape, K> ? {readonly optional: true} : {readonly optional?: never}

export type ShapeFields<TShape extends object> = {
  [K in keyof TShape]-?: {readonly check: FieldCheck<NonNullable<TShape[K]>>} & OptionalFlag<TShape, K>
}

/**
 * Exact-key-set check for a nested object, derived from the interface: an
 * optional member may be absent but never present-and-undefined, and no key
 * outside the interface is tolerated.
 */
export function shape<TShape extends object>(): (spec: {readonly fields: ShapeFields<TShape>}) => FieldCheck<TShape> {
  return spec => {
    const entries = fieldEntries(spec.fields as unknown as Record<string, RawField>)
    return (value: unknown): value is TShape => {
      try {
        return matchesEntries(value, entries)
      } catch {
        return false
      }
    }
  }
}

/** The fields a caller supplies: everything the record does not sign for itself. */
export type SuppliedFields<
  TRecord extends object,
  TDigestField extends keyof TRecord,
  TDerived extends keyof TRecord = never,
> = Omit<TRecord, TDigestField | TDerived>

export type SignedRecordFields<
  TRecord extends object,
  TDigestField extends keyof TRecord,
  TDerived extends Exclude<keyof TRecord, TDigestField> = never,
> = {
  [K in Exclude<keyof TRecord, TDigestField>]-?: {
    readonly check: FieldCheck<NonNullable<TRecord[K]>>
  } & (K extends TDerived
    ? {
        readonly derive: (supplied: SuppliedFields<TRecord, TDigestField, TDerived>) => TRecord[K]
        readonly optional?: never
      }
    : {readonly derive?: never} & OptionalFlag<TRecord, K>)
}

export interface SignedRecordSpec<
  TRecord extends object,
  TDigestField extends keyof TRecord,
  TDerived extends Exclude<keyof TRecord, TDigestField> = never,
> {
  /** Diagnostics only; the label is never part of the digest. */
  readonly label: string
  readonly digestField: TDigestField
  /** Merged into the digest input only, never onto the record. */
  readonly digestPreamble?: Readonly<Record<string, JsonPrimitive>>
  readonly fields: SignedRecordFields<TRecord, TDigestField, TDerived>
  /** Cross-field domain rules. Use named functions: the name is the failure message. */
  readonly invariants?: readonly ((record: TRecord) => boolean)[]
}

export interface SignedRecord<
  TRecord extends object,
  TDigestField extends keyof TRecord,
  TDerived extends Exclude<keyof TRecord, TDigestField> = never,
> {
  readonly label: string
  readonly digestField: TDigestField
  /** Sorted, digest field included. */
  readonly keys: readonly string[]
  create(fields: SuppliedFields<TRecord, TDigestField, TDerived>): TRecord
  verify(value: unknown): value is TRecord
  /**
   * Parse, don't validate: every check runs against a one-read canonical
   * snapshot of the input, and the frozen snapshot — never the caller's
   * object — is what comes back. Use the returned record for anything the
   * kernel later acts on; `verify` only answers whether a parse would succeed.
   */
  parse(value: unknown): TRecord | undefined
}

export function defineSignedRecord<
  TRecord extends object,
  TDigestField extends keyof TRecord,
  TDerived extends Exclude<keyof TRecord, TDigestField> = never,
>(spec: SignedRecordSpec<TRecord, TDigestField, TDerived>): SignedRecord<TRecord, TDigestField, TDerived> {
  const recordLabel = spec.label
  const digestKey = String(spec.digestField)
  const entries = fieldEntries(spec.fields as unknown as Record<string, RawField>)
  const preamble = spec.digestPreamble
  const invariants = spec.invariants ?? []

  for (const key of Object.keys(preamble ?? {})) {
    if (key === digestKey || entries.some(entry => entry.key === key)) {
      throw new TypeError(`${recordLabel} digest preamble key ${key} collides with a record field`)
    }
  }

  const suppliedKeys = new Set(entries.filter(entry => entry.derive === undefined).map(entry => entry.key))

  function signatureOf(unsigned: Record<string, unknown>): Digest {
    return digestJson(preamble === undefined ? unsigned : {...preamble, ...unsigned})
  }

  function create(fields: SuppliedFields<TRecord, TDigestField, TDerived>): TRecord {
    if (!isPlainRecord(fields)) throw new TypeError(`${recordLabel} fields must be a plain object`)
    const input = fields as Record<string, unknown>
    for (const key of Object.keys(input)) {
      if (!suppliedKeys.has(key)) throw new TypeError(`${recordLabel}.${key} is not a supplied field`)
    }

    const values = new Map<string, unknown>()
    for (const entry of entries) {
      if (entry.derive !== undefined) continue
      const item = input[entry.key]
      if (item === undefined && entry.optional) continue
      if (!entry.check(item)) throw new TypeError(`${recordLabel}.${entry.key} failed its field check`)
      values.set(entry.key, item)
    }

    const supplied = Object.fromEntries(values)
    for (const entry of entries) {
      if (entry.derive === undefined) continue
      const derived = entry.derive(supplied)
      if (!entry.check(derived)) throw new TypeError(`${recordLabel}.${entry.key} failed its field check`)
      values.set(entry.key, derived)
    }

    const record: Record<string, unknown> = {}
    for (const entry of entries) {
      if (values.has(entry.key)) record[entry.key] = values.get(entry.key)
    }
    record[digestKey] = signatureOf(record)

    const signed = record as TRecord
    for (const invariant of invariants) {
      let held = false
      try {
        held = invariant(signed) === true
      } catch {
        held = false
      }
      if (!held) throw new TypeError(`${recordLabel} invariant ${nameOf(invariant)} does not hold`)
    }
    return deepFreeze(signed)
  }

  function parse(value: unknown): TRecord | undefined {
    try {
      if (!isPlainRecord(value)) return undefined

      // Snapshot FIRST through canonical JSON: every property, however
      // deeply nested, is read exactly once, and every check below — and
      // every caller — sees only these bytes. A structural check against
      // the input instead of the snapshot would let a Proxy answer the
      // check with one key set and the serializer with another.
      // Present-but-undefined values throw inside canonicalJson, so they
      // reject here without a dedicated check.
      const snapshot = JSON.parse(canonicalJson(value)) as Record<string, unknown>

      const present = Object.keys(snapshot).sort()
      const expected = [digestKey, ...entries.map(entry => entry.key)].filter(key => snapshot[key] !== undefined).sort()
      if (present.length !== expected.length) return undefined
      if (present.some((key, index) => key !== expected[index])) return undefined
      for (const entry of entries) {
        if (entry.optional) continue
        if (snapshot[entry.key] === undefined) return undefined
      }
      if (!IS_DIGEST(snapshot[digestKey])) return undefined

      for (const entry of entries) {
        const item = snapshot[entry.key]
        if (item === undefined) continue
        if (!entry.check(item)) return undefined
      }

      const supplied: Record<string, unknown> = {}
      for (const entry of entries) {
        if (entry.derive !== undefined || snapshot[entry.key] === undefined) continue
        supplied[entry.key] = snapshot[entry.key]
      }
      for (const entry of entries) {
        if (entry.derive === undefined) continue
        if (canonicalJson(entry.derive(supplied)) !== canonicalJson(snapshot[entry.key])) return undefined
      }

      const signed = snapshot as TRecord
      for (const invariant of invariants) {
        if (invariant(signed) !== true) return undefined
      }

      const unsigned: Record<string, unknown> = {}
      for (const entry of entries) {
        if (snapshot[entry.key] === undefined) continue
        unsigned[entry.key] = snapshot[entry.key]
      }
      if (snapshot[digestKey] !== signatureOf(unsigned)) return undefined
      return deepFreeze(signed)
    } catch {
      return undefined
    }
  }

  function verify(value: unknown): value is TRecord {
    return parse(value) !== undefined
  }

  return {
    label: recordLabel,
    digestField: spec.digestField,
    keys: Object.freeze([...entries.map(entry => entry.key), digestKey].sort()),
    create,
    verify,
    parse,
  }
}

interface RawField {
  readonly check: FieldCheck<unknown>
  readonly optional?: true
  readonly derive?: (supplied: Record<string, unknown>) => unknown
}

interface FieldEntry {
  readonly key: string
  readonly check: (value: unknown) => boolean
  readonly optional: boolean
  readonly derive?: (supplied: Record<string, unknown>) => unknown
}

const IS_DIGEST = digest()

function fieldEntries(fields: Record<string, RawField>): readonly FieldEntry[] {
  return Object.keys(fields).map(key => {
    const field = fields[key]
    if (!field || typeof field.check !== 'function') {
      throw new TypeError(`Signed record field ${key} must declare a check`)
    }
    return {
      key,
      check: field.check as (value: unknown) => boolean,
      optional: field.optional === true,
      ...(field.derive === undefined ? {} : {derive: field.derive}),
    }
  })
}

function matchesEntries(value: unknown, entries: readonly FieldEntry[]): boolean {
  if (!isPlainRecord(value)) return false
  const declared = new Set(entries.map(entry => entry.key))
  for (const key of Object.keys(value)) {
    if (!declared.has(key)) return false
  }
  for (const entry of entries) {
    const present = Object.hasOwn(value, entry.key)
    const item = present ? value[entry.key] : undefined
    if (item === undefined) {
      if (!entry.optional || present) return false
      continue
    }
    if (!entry.check(item)) return false
  }
  return true
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  // A symbol key is a field the digest can never cover; canonical JSON rejects it too.
  if (Object.getOwnPropertySymbols(value).length > 0) return false
  // An accessor can answer differently on every read, so the digest binds
  // nothing; a non-enumerable property hides from the shape checks entirely.
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || descriptor.enumerable !== true) return false
    if (descriptor.get !== undefined || descriptor.set !== undefined) return false
  }
  return true
}

function nameOf(invariant: (record: never) => boolean): string {
  return invariant.name === '' ? 'anonymous' : invariant.name
}
