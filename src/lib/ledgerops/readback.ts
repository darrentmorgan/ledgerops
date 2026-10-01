import {canonicalJson, cloneCanonical, digestJson} from './canonical.js'
import {createTargetBinding, isSafeTargetBinding} from './identity.js'
import {defineSignedRecord, digest, label, literal} from './signed-record.js'
import type {
  ReadBackAuthorityKey,
  ReadBackAuthorityRequirement,
  ReadBackClassification,
  ReadBackExpectation,
  ReadBackTransportResult,
  TargetBinding,
  TargetIdentity,
  TargetIdentityInput,
} from './types.js'
import {READ_BACK_AUTHORITY_KEYS} from './types.js'

export interface ReadBackExpectationInput {
  resource: string
  target: TargetIdentity | TargetIdentityInput | TargetBinding
  expected: unknown
  /**
   * Optional projection naming the top-level fields the equality digest
   * covers. Declaring one is how a live create can reach VERIFIED while the
   * provider adds server-side fields: everything outside the projection is
   * tolerated except the authority keys, which are checked separately and
   * always fail closed.
   *
   * **There is no minimum-projection floor, by decision (issue #71).** A
   * projection of `['reference']` is accepted, and the resulting VERIFIED
   * means only that `reference` matched and no authority key moved — the
   * total, the contact, and the line items were never compared and may differ
   * freely from the plan. The floor is not enforced here because this kernel
   * is resource-agnostic: `resource` is an opaque label (ADR-0007), so there
   * is no non-arbitrary per-resource field set to require, and a generic
   * "at least N fields" rule would buy confidence it cannot justify.
   *
   * The consequence is that **the caller declaring the projection owns how
   * much its VERIFIED is worth.** Declare every field whose divergence you
   * would want to catch. A projection is a narrowing you are choosing to
   * accept, not a shortcut the kernel will second-guess.
   */
  projection?: readonly string[]
}

function isProjection(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length === 0) return false
  if (!value.every(key => typeof key === 'string' && key.trim() !== '')) return false
  for (let index = 1; index < value.length; index += 1) {
    if (value[index - 1] >= value[index]) return false
  }
  return true
}

function isAuthorityRequirements(value: unknown): value is readonly ReadBackAuthorityRequirement[] {
  if (!Array.isArray(value)) return false
  let previousKey: string | undefined
  return value.every(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false
    if (Object.getPrototypeOf(item) !== Object.prototype) return false
    const keys = Object.keys(item).sort()
    if (keys.length !== 2 || keys[0] !== 'key' || keys[1] !== 'value') return false
    const requirement = item as {key: unknown; value: unknown}
    if (
      typeof requirement.key !== 'string' ||
      !(READ_BACK_AUTHORITY_KEYS as readonly string[]).includes(requirement.key)
    )
      return false
    if (!isJsonPrimitive(requirement.value)) return false
    const key = requirement.key as ReadBackAuthorityKey
    if (previousKey !== undefined && previousKey >= key) return false
    previousKey = key
    return true
  })
}

function isJsonPrimitive(value: unknown): value is null | boolean | number | string {
  return value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string'
}

const readBackExpectationRecord = defineSignedRecord<ReadBackExpectation, 'expectationDigest'>({
  label: 'ledgerops.readback.v1',
  digestField: 'expectationDigest',
  fields: {
    schemaVersion: {check: literal('ledgerops.readback.v1')},
    resource: {check: label()},
    targetBinding: {check: isSafeTargetBinding},
    expectedDigest: {check: digest()},
    maxMatches: {check: literal(1)},
    projection: {check: isProjection, optional: true},
    authority: {check: isAuthorityRequirements, optional: true},
  },
  invariants: [authorityRequiresProjection],
})

function authorityRequiresProjection(record: ReadBackExpectation): boolean {
  return record.authority === undefined || record.projection !== undefined
}

/** Deterministic canonical form: non-empty, duplicate-free, sorted. */
function normalizeProjection(projection: readonly string[]): readonly string[] {
  if (!Array.isArray(projection)) {
    throw new TypeError('read-back projection must be an array of field names')
  }
  if (projection.length === 0) {
    throw new TypeError('read-back projection must name at least one field')
  }
  for (const key of projection) {
    if (typeof key !== 'string' || key.trim() === '') {
      throw new TypeError('read-back projection fields must be non-empty strings')
    }
  }
  const unique = [...new Set(projection)].sort()
  if (unique.length !== projection.length) {
    throw new TypeError('read-back projection must not repeat a field')
  }
  return Object.freeze(unique)
}

/**
 * The projection narrows which fields participate in the digest; it may never
 * widen what the expectation claims. A projected field the expected record
 * does not have would compare the planned shape against a different one, so
 * it is refused at plan time instead of at classification time.
 */
function requireProjectedFieldsInExpected(expected: unknown, projection: readonly string[]): void {
  if (
    !expected ||
    typeof expected !== 'object' ||
    Array.isArray(expected) ||
    Object.getPrototypeOf(expected) !== Object.prototype
  ) {
    throw new TypeError('a read-back projection requires a plain-object expected record')
  }
  const record = expected as Record<string, unknown>
  for (const key of projection) {
    if (!Object.hasOwn(record, key)) {
      throw new TypeError(`read-back projection field ${key} is not present in the expected record`)
    }
  }
}

/**
 * Authority-relevant fields are captured out of the expected record and signed
 * into the expectation, so classification can fail closed on them even when
 * the projection excludes them from the digest comparison.
 */
function captureAuthorityRequirements(
  expected: Record<string, unknown>,
): readonly ReadBackAuthorityRequirement[] | undefined {
  const requirements: ReadBackAuthorityRequirement[] = []
  for (const key of READ_BACK_AUTHORITY_KEYS) {
    if (!Object.hasOwn(expected, key)) continue
    const value = expected[key]
    if (!isJsonPrimitive(value)) {
      throw new TypeError(`authority-relevant field ${key} must hold a JSON primitive`)
    }
    requirements.push({key, value})
  }
  // isAuthorityRequirements demands lexicographic key order; sort here so
  // capture always matches parse regardless of READ_BACK_AUTHORITY_KEYS'
  // declaration order.
  requirements.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return requirements.length === 0 ? undefined : requirements
}

/**
 * Seal what a later read-back must agree with. Validation here is about
 * determinism and coherence — the projection is non-empty, sorted, unique, and
 * every projected field exists on the expected record — not about *sufficiency*.
 * A one-field projection is a well-formed expectation and is accepted (issue
 * #71); see `ReadBackExpectationInput.projection` for why the floor is the
 * caller's to set and what a VERIFIED built on a narrow projection does and
 * does not claim.
 */
export function createReadBackExpectation(input: ReadBackExpectationInput): ReadBackExpectation {
  if (typeof input.resource !== 'string' || input.resource.trim() === '') {
    throw new TypeError('read-back resource must be a non-empty string')
  }
  const projection = input.projection === undefined ? undefined : normalizeProjection(input.projection)
  if (projection !== undefined) {
    requireProjectedFieldsInExpected(input.expected, projection)
  }
  return readBackExpectationRecord.create({
    schemaVersion: 'ledgerops.readback.v1',
    resource: input.resource.trim(),
    targetBinding: createTargetBinding(input.target),
    expectedDigest: digestJson(
      projection === undefined ? input.expected : projectRecord(input.expected as Record<string, unknown>, projection),
    ),
    maxMatches: 1,
    ...(projection === undefined ? {} : {projection}),
    ...(projection === undefined
      ? {}
      : {authority: captureAuthorityRequirements(input.expected as Record<string, unknown>)}),
  })
}

export const verifyReadBackExpectation = readBackExpectationRecord.verify

/** Parse-don't-validate: kernel paths act only on the snapshot this returns. */
export const parseReadBackExpectation = readBackExpectationRecord.parse

/**
 * Compare a read-back result against its sealed expectation.
 *
 * **What `'verified'` claims, exactly (issue #71):** the expectation parsed and
 * still matches its own digest; the transport found exactly one record; every
 * authority key agrees with what was planned (and none appeared or vanished);
 * and the fields the expectation *declared* digest identically. When the
 * expectation carries no projection those declared fields are the whole record,
 * so `'verified'` is full equality. When it carries a projection, `'verified'`
 * is scoped to that projection and says nothing whatsoever about any field
 * outside it.
 *
 * (The explicit `authorityHolds` check runs only on the projected branch, which
 * is why it is absent from the whole-record branch below: with no projection
 * the digest covers the entire record, so an authority key that changed,
 * vanished, or appeared already breaks digest equality. The separate check
 * exists precisely because a projection can otherwise hide such a change.)
 *
 * So `'verified'` is never a standalone claim that "the live record is what we
 * planned" — it is "the declared check passed". Read it together with the
 * expectation's `projection` before rendering it to a human or mapping it to a
 * success state downstream. `executor.ts` maps it to the `VERIFIED` outcome,
 * which `batch-executor.ts` maps to `accepted`; both inherit exactly this
 * scope, no more. Every other path — a tampered expectation, a wrong match
 * count, a thrown comparison — fails closed to `'mismatch'` or `'ambiguous'`.
 */
export function classifyReadBack(
  result: ReadBackTransportResult,
  expectation: ReadBackExpectation,
): ReadBackClassification {
  const parsed = parseReadBackExpectation(expectation)
  if (!parsed) return 'mismatch'
  if (!result || typeof result !== 'object') return 'ambiguous'
  if (result.status === 'missing') return 'missing'
  if (result.status === 'ambiguous') return 'ambiguous'
  if (result.status !== 'found' || !Array.isArray(result.records)) return 'ambiguous'
  if (result.records.length !== parsed.maxMatches) return 'ambiguous'

  try {
    if (parsed.projection === undefined) {
      return digestJson(result.records[0]) === parsed.expectedDigest ? 'verified' : 'mismatch'
    }
    // Snapshot through the canonical representation once, so every check
    // below — authority and projection alike — reads the same bytes.
    const snapshot = cloneCanonical(result.records[0])
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return 'mismatch'
    if (!authorityHolds(parsed.authority ?? [], snapshot as Record<string, unknown>)) return 'mismatch'
    return digestJson(projectRecord(snapshot as Record<string, unknown>, parsed.projection)) === parsed.expectedDigest
      ? 'verified'
      : 'mismatch'
  } catch {
    return 'mismatch'
  }
}

/** Pick the projected top-level fields that are present; absent fields digest differently. */
function projectRecord(record: Record<string, unknown>, projection: readonly string[]): Record<string, unknown> {
  const projected: Record<string, unknown> = {}
  for (const key of projection) {
    if (Object.hasOwn(record, key)) projected[key] = record[key]
  }
  return projected
}

/**
 * Fail closed on every authority-relevant field, projected or not: a value
 * that changed or vanished, or an authority field the expectation never
 * planned for, refuses classification as verified.
 */
function authorityHolds(
  requirements: readonly ReadBackAuthorityRequirement[],
  record: Record<string, unknown>,
): boolean {
  const required = new Map<string, unknown>(requirements.map(item => [item.key, item.value]))
  for (const key of READ_BACK_AUTHORITY_KEYS) {
    if (!Object.hasOwn(record, key)) {
      if (required.has(key)) return false
      continue
    }
    if (!required.has(key)) return false
    if (!sameJsonValue(required.get(key), record[key])) return false
  }
  return true
}

function sameJsonValue(expected: unknown, actual: unknown): boolean {
  if (expected === actual) return true
  try {
    return canonicalJson(expected) === canonicalJson(actual)
  } catch {
    return false
  }
}
