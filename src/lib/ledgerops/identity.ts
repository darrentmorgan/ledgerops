import {deepFreeze, digestJson, type Digest, type JsonValue} from './canonical.js'
import {fingerprintCapabilities, fingerprintScopes, normalizeCapabilities, normalizeScopes} from './capabilities.js'
import {digest, finiteNumber, label, shape, stringArray, type FieldCheck} from './signed-record.js'
import type {RedactedTargetIdentity, TargetBinding, TargetIdentity, TargetIdentityInput} from './types.js'

const DEFAULT_IDENTITY_FRESHNESS_MS = 5 * 60 * 1000

/** The binding shape every signed record accepts: five redacted fields, nothing else. */
export const isSafeTargetBinding: FieldCheck<TargetBinding> = shape<TargetBinding>()({
  fields: {
    profileName: {check: label()},
    resource: {check: label()},
    tenantFingerprint: {check: digest()},
    objectFingerprint: {check: digest(), optional: true},
    targetFingerprint: {check: digest()},
  },
})

export function createTargetIdentity(input: TargetIdentityInput): TargetIdentity {
  requireLabel(input.profileName, 'profile')
  requireLabel(input.tenantId, 'tenant')
  requireLabel(input.resource, 'resource')
  if (input.objectId !== undefined) requireLabel(input.objectId, 'object')
  if (typeof input.isDemoCompany !== 'boolean') {
    throw new TypeError('isDemoCompany must be boolean')
  }
  requireTimestamp(input.observedAt, 'observedAt')

  const freshUntil = input.freshUntil ?? input.observedAt + (input.freshnessMs ?? DEFAULT_IDENTITY_FRESHNESS_MS)
  requireTimestamp(freshUntil, 'freshUntil')
  if (freshUntil <= input.observedAt) {
    throw new RangeError('freshUntil must be after observedAt')
  }

  const capabilities = normalizeCapabilities(input.capabilities)
  const scopes = normalizeScopes(input.scopes)
  return deepFreeze({
    profileName: input.profileName.trim(),
    tenantId: input.tenantId,
    resource: input.resource.trim(),
    ...(input.objectId === undefined ? {} : {objectId: input.objectId}),
    isDemoCompany: input.isDemoCompany,
    observedAt: input.observedAt,
    freshUntil,
    capabilities,
    scopes,
    capabilitiesFingerprint: fingerprintCapabilities(capabilities),
    scopesFingerprint: fingerprintScopes(scopes),
  })
}

export function createTargetBinding(target: TargetIdentity | TargetIdentityInput | TargetBinding): TargetBinding {
  if (!target || typeof target !== 'object') throw new TypeError('target identity or binding is required')
  if (isBinding(target)) {
    requireLabel(target.profileName, 'profile')
    requireLabel(target.resource, 'resource')
    requireDigest(target.tenantFingerprint, 'tenant fingerprint')
    if (target.objectFingerprint !== undefined) requireDigest(target.objectFingerprint, 'object fingerprint')
    requireDigest(target.targetFingerprint, 'target fingerprint')
    return deepFreeze({
      profileName: target.profileName.trim(),
      resource: target.resource.trim(),
      tenantFingerprint: target.tenantFingerprint,
      ...(target.objectFingerprint === undefined ? {} : {objectFingerprint: target.objectFingerprint}),
      targetFingerprint: target.targetFingerprint,
    })
  }

  const identity =
    'freshUntil' in target && 'capabilities' in target
      ? (target as TargetIdentity)
      : createTargetIdentity(target as TargetIdentityInput)
  const binding = {
    profileName: identity.profileName,
    resource: identity.resource,
    tenantFingerprint: digestJson({kind: 'ledgerops.tenant.v1', tenantId: identity.tenantId}),
    ...(identity.objectId === undefined
      ? {}
      : {objectFingerprint: digestJson({kind: 'ledgerops.object.v1', objectId: identity.objectId})}),
    targetFingerprint: digestJson({
      kind: 'ledgerops.target.v1',
      profileName: identity.profileName,
      resource: identity.resource,
      tenantId: identity.tenantId,
      objectId: identity.objectId ?? null,
    }),
  }
  return deepFreeze(binding)
}

export function redactTargetIdentity(identity: TargetIdentity): RedactedTargetIdentity {
  const binding = createTargetBinding(identity)
  return deepFreeze({
    ...binding,
    isDemoCompany: identity.isDemoCompany,
    observedAt: identity.observedAt,
    freshUntil: identity.freshUntil,
    capabilitiesFingerprint: identity.capabilitiesFingerprint,
    scopesFingerprint: identity.scopesFingerprint,
  })
}

/**
 * Binding equality is all five fields; the target fingerprint alone is never
 * proof of sameness. Every seam that compares bindings calls this.
 */
export function sameBinding(left: TargetBinding, right: TargetBinding): boolean {
  return (
    left.profileName === right.profileName &&
    left.resource === right.resource &&
    left.tenantFingerprint === right.tenantFingerprint &&
    (left.objectFingerprint ?? null) === (right.objectFingerprint ?? null) &&
    left.targetFingerprint === right.targetFingerprint
  )
}

export function targetMatches(identity: TargetIdentity, binding: TargetBinding): boolean {
  return sameBinding(createTargetBinding(identity), binding)
}

export function isIdentityFresh(identity: TargetIdentity, now = Date.now()): boolean {
  return (
    verifyTargetIdentity(identity) && Number.isFinite(now) && now >= identity.observedAt && now < identity.freshUntil
  )
}

const booleanValue: FieldCheck<boolean> = (value): value is boolean => typeof value === 'boolean'

const isTargetIdentityShape = shape<TargetIdentity>()({
  fields: {
    profileName: {check: label()},
    tenantId: {check: label()},
    resource: {check: label()},
    objectId: {check: label(), optional: true},
    isDemoCompany: {check: booleanValue},
    observedAt: {check: finiteNumber()},
    freshUntil: {check: finiteNumber()},
    capabilities: {check: stringArray()},
    scopes: {check: stringArray()},
    capabilitiesFingerprint: {check: digest()},
    scopesFingerprint: {check: digest()},
  },
})

export function verifyTargetIdentity(identity: TargetIdentity): boolean {
  try {
    if (!isTargetIdentityShape(identity)) return false
    if (identity.freshUntil <= identity.observedAt) return false
    const capabilities = normalizeCapabilities(identity.capabilities)
    const scopes = normalizeScopes(identity.scopes)
    return (
      capabilities.join('|') === identity.capabilities.join('|') &&
      scopes.join('|') === identity.scopes.join('|') &&
      identity.capabilitiesFingerprint === fingerprintCapabilities(capabilities) &&
      identity.scopesFingerprint === fingerprintScopes(scopes)
    )
  } catch {
    return false
  }
}

/**
 * ADR-0014 general kernel rule: the stable, timestamp-independent identity of
 * a real-world operation.
 *
 *   operationId = sha256Hex(canonicalJson({tenantFingerprint, resource, operation, origin}))
 *
 * `tenantFingerprint` names the org, never `targetFingerprint` and never
 * `profileName` -- identity is org-scoped, so a profile rename or a second
 * profile onto the same org derives the identical id. `origin` is supplied
 * entirely by the calling lane and must name the real-world thing being
 * acted on precisely enough that two dispatches sharing it are the same
 * operation. Nothing time-varying, run-varying, or operator-varying belongs
 * in any of these fields: the type below has no timestamp, ttl, planId,
 * planDigest, nonce, or batch-position field to read from.
 *
 * This is derivation only. It does not check a journal, take a lock, or
 * refuse a duplicate -- see ADR-0014 section 3 (issue #33) for replay
 * protection built on top of this value.
 */
export interface OperationIdentityInput {
  readonly tenantFingerprint: Digest
  readonly resource: string
  readonly operation: string
  readonly origin: JsonValue
}

export function deriveOperationId(input: OperationIdentityInput): Digest {
  requireDigest(input.tenantFingerprint, 'tenant fingerprint')
  requireLabel(input.resource, 'resource')
  requireLabel(input.operation, 'operation')
  if (input.origin === null || typeof input.origin !== 'object' || Array.isArray(input.origin)) {
    throw new TypeError('origin must be a plain JSON object')
  }
  return digestJson({
    tenantFingerprint: input.tenantFingerprint,
    resource: input.resource.trim(),
    operation: input.operation.trim(),
    origin: input.origin,
  })
}

function isBinding(value: TargetIdentity | TargetIdentityInput | TargetBinding): value is TargetBinding {
  return 'tenantFingerprint' in value && 'targetFingerprint' in value
}

function requireLabel(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`)
  }
}

function requireTimestamp(value: number, field: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${field} must be a finite number`)
  }
}

function requireDigest(value: unknown, field: string): asserts value is Digest {
  if (!isDigest(value)) throw new TypeError(`${field} must be a SHA-256 digest`)
}

function isDigest(value: unknown): value is Digest {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}
