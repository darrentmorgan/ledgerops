import {cloneCanonical, digestJson} from './canonical.js'
import {fingerprintCapabilities, fingerprintScopes, normalizeCapabilities, normalizeScopes} from './capabilities.js'
import {createTargetBinding, isSafeTargetBinding, sameBinding} from './identity.js'
import {createReadBackExpectation, verifyReadBackExpectation} from './readback.js'
import {canonicalValue, defineSignedRecord, digest, finiteNumber, label, literal, stringArray} from './signed-record.js'
import type {
  MutationOperation,
  MutationPlan,
  ReadBackExpectation,
  TargetBinding,
  TargetIdentity,
  TargetIdentityInput,
} from './types.js'

const DEFAULT_PLAN_TTL_MS = 5 * 60 * 1000

export interface MutationPlanInput {
  planId?: string
  profileName: string
  resource: string
  operation: MutationOperation
  target: TargetIdentity | TargetIdentityInput | TargetBinding
  payload: unknown
  requiredCapability?: string
  requiredCapabilities?: readonly string[]
  requiredScope?: string
  requiredScopes?: readonly string[]
  readBackExpectation?: ReadBackExpectation
  readBack?: {
    target?: TargetIdentity | TargetIdentityInput | TargetBinding
    expected: unknown
    projection?: readonly string[]
  }
  objectCount?: number
  maxObjects?: number
  createdAt?: number
  expiresAt?: number
  ttlMs?: number
}

function ttlOrdering(plan: MutationPlan): boolean {
  return plan.expiresAt > plan.createdAt
}

function bindingMatchesPlan(plan: MutationPlan): boolean {
  return plan.targetBinding.profileName === plan.profileName && plan.targetBinding.resource === plan.resource
}

function capabilitiesNormalized(plan: MutationPlan): boolean {
  return (
    plan.requiredCapabilities.length > 0 &&
    normalizeCapabilities(plan.requiredCapabilities).join('|') === plan.requiredCapabilities.join('|')
  )
}

function scopesNormalized(plan: MutationPlan): boolean {
  return (
    plan.requiredScopes.length > 0 && normalizeScopes(plan.requiredScopes).join('|') === plan.requiredScopes.join('|')
  )
}

function readBackMatchesPlan(plan: MutationPlan): boolean {
  return (
    plan.readBackExpectation.resource === plan.resource &&
    sameBinding(plan.readBackExpectation.targetBinding, plan.targetBinding)
  )
}

const mutationPlanRecord = defineSignedRecord<
  MutationPlan,
  'planDigest',
  'payloadDigest' | 'requiredCapability' | 'requiredScope' | 'capabilitiesFingerprint' | 'scopesFingerprint'
>({
  label: 'ledgerops.plan.v1',
  digestField: 'planDigest',
  fields: {
    schemaVersion: {check: literal('ledgerops.plan.v1')},
    planId: {check: label()},
    profileName: {check: label()},
    resource: {check: label()},
    operation: {check: label()},
    targetBinding: {check: isSafeTargetBinding},
    payload: {check: canonicalValue()},
    payloadDigest: {check: digest(), derive: supplied => digestJson(supplied.payload)},
    requiredCapability: {check: label(), derive: supplied => supplied.requiredCapabilities[0]},
    requiredCapabilities: {check: stringArray()},
    requiredScope: {check: label(), derive: supplied => supplied.requiredScopes[0]},
    requiredScopes: {check: stringArray()},
    capabilitiesFingerprint: {
      check: digest(),
      derive: supplied => fingerprintCapabilities(supplied.requiredCapabilities),
    },
    scopesFingerprint: {check: digest(), derive: supplied => fingerprintScopes(supplied.requiredScopes)},
    readBackExpectation: {check: verifyReadBackExpectation},
    objectCount: {check: literal(1)},
    maxObjects: {check: literal(1)},
    requiresDemoCompany: {check: literal(true)},
    createdAt: {check: finiteNumber()},
    expiresAt: {check: finiteNumber()},
  },
  invariants: [ttlOrdering, bindingMatchesPlan, capabilitiesNormalized, scopesNormalized, readBackMatchesPlan],
})

export function createMutationPlan(input: MutationPlanInput): MutationPlan {
  const profileName = requireLabel(input.profileName, 'profile')
  const resource = requireLabel(input.resource, 'resource')
  const operation = requireLabel(input.operation, 'operation') as MutationOperation
  const planId = requireLabel(input.planId ?? 'ledgerops-plan', 'plan id')
  const createdAt = input.createdAt ?? Date.now()
  requireTimestamp(createdAt, 'createdAt')
  const expiresAt = input.expiresAt ?? createdAt + (input.ttlMs ?? DEFAULT_PLAN_TTL_MS)
  requireTimestamp(expiresAt, 'expiresAt')
  if (expiresAt <= createdAt) throw new RangeError('expiresAt must be after createdAt')

  if ((input.objectCount ?? 1) !== 1 || (input.maxObjects ?? 1) !== 1) {
    throw new RangeError('LedgerOps plans are limited to exactly one resource')
  }

  const targetBinding = createTargetBinding(input.target)
  if (targetBinding.profileName !== profileName || targetBinding.resource !== resource) {
    throw new Error('Plan target does not match the explicit profile and resource')
  }

  const payload = cloneCanonical(input.payload)
  const requiredCapabilities = normalizeRequiredCapabilities(input.requiredCapability, input.requiredCapabilities)
  const requiredScopes = normalizeScopes([
    ...(input.requiredScopes ?? []),
    ...(input.requiredScope === undefined ? [] : [input.requiredScope]),
  ])
  if (requiredCapabilities.length === 0) throw new RangeError('At least one capability is required')
  if (requiredScopes.length === 0) throw new RangeError('At least one scope is required')

  const suppliedExpectation = input.readBackExpectation
  const readBackExpectation =
    suppliedExpectation ??
    (input.readBack
      ? createReadBackExpectation({
          resource,
          target: input.readBack.target ?? input.target,
          expected: input.readBack.expected,
          ...(input.readBack.projection === undefined ? {} : {projection: input.readBack.projection}),
        })
      : undefined)
  if (!readBackExpectation || !verifyReadBackExpectation(readBackExpectation)) {
    throw new Error('A valid read-back expectation is required')
  }
  if (readBackExpectation.resource !== resource || !sameBinding(readBackExpectation.targetBinding, targetBinding)) {
    throw new Error('Read-back expectation does not match the plan target')
  }

  return mutationPlanRecord.create({
    schemaVersion: 'ledgerops.plan.v1',
    planId,
    profileName,
    resource,
    operation,
    targetBinding,
    payload,
    requiredCapabilities,
    requiredScopes,
    readBackExpectation,
    objectCount: 1,
    maxObjects: 1,
    requiresDemoCompany: true,
    createdAt,
    expiresAt,
  })
}

export const verifyPlanIntegrity = mutationPlanRecord.verify

/** Parse-don't-validate: kernel paths act only on the snapshot this returns. */
export const parseMutationPlan = mutationPlanRecord.parse

export function isPlanUnexpired(plan: MutationPlan, now = Date.now()): boolean {
  return Number.isFinite(now) && now < plan.expiresAt
}

function normalizeRequiredCapabilities(
  requiredCapability: string | undefined,
  requiredCapabilities: readonly string[] | undefined,
): readonly string[] {
  return normalizeCapabilities([
    ...(requiredCapabilities ?? []),
    ...(requiredCapability === undefined ? [] : [requiredCapability]),
  ])
}

function requireLabel(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`)
  return value.trim()
}

function requireTimestamp(value: number, field: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${field} must be finite`)
}
