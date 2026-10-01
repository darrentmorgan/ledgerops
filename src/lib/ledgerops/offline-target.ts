import {readFileSync} from 'node:fs'
import {containsSecretShapedData} from './data-hygiene.js'
import {createTargetIdentity} from './identity.js'
import {parseMutationPlan} from './plan.js'
import type {MutationOperation, MutationPlan, MutationRequest, TargetIdentity, TargetIdentityInput} from './types.js'

/**
 * The CLI-side loader for offline target files. It turns identity and plan JSON
 * into verified kernel values and owns the one error vocabulary the offline
 * commands raise. It is not kernel vocabulary, so commands import it directly
 * rather than through the barrel.
 *
 * Messages name the field or file role that failed, never the value that failed:
 * an offline file may hold a tenant identifier or a payload, and neither belongs
 * in an error string.
 */
export const OFFLINE_TARGET_ERROR_CODES = [
  'FILE_UNREADABLE',
  'IDENTITY_INVALID',
  'PLAN_INVALID',
  'TARGET_MISMATCH',
  'DATA_HYGIENE_REJECTED',
] as const

export type OfflineTargetErrorCode = (typeof OFFLINE_TARGET_ERROR_CODES)[number]

export class OfflineTargetError extends Error {
  readonly code: OfflineTargetErrorCode

  constructor(code: OfflineTargetErrorCode, reason: string) {
    super(`${code}: ${reason}`)
    this.name = 'OfflineTargetError'
    this.code = code
  }
}

/** The validated shape of a `target plan` input file. */
export interface OfflinePlanInput {
  readonly planId?: string
  readonly operation: MutationOperation
  readonly payload: unknown
  readonly expected: unknown
  readonly requiredCapabilities: readonly string[]
  readonly requiredScopes: readonly string[]
  readonly createdAt?: number
  readonly expiresAt?: number
}

export function loadOfflineIdentity(path: string, profileName: string, resource: string): TargetIdentity {
  const value = readJsonObject(path, 'identity')
  if (value.profileName !== profileName) {
    throw new OfflineTargetError('TARGET_MISMATCH', 'Identity profile does not match --profile')
  }
  if (value.resource !== resource) {
    throw new OfflineTargetError('TARGET_MISMATCH', 'Identity resource does not match --resource')
  }
  if (typeof value.tenantId !== 'string' || value.tenantId.trim() === '') {
    throw new OfflineTargetError('IDENTITY_INVALID', 'Identity tenantId is required')
  }
  if (typeof value.isDemoCompany !== 'boolean') {
    throw new OfflineTargetError('IDENTITY_INVALID', 'Identity isDemoCompany must be explicit')
  }
  if (typeof value.observedAt !== 'number') {
    throw new OfflineTargetError('IDENTITY_INVALID', 'Identity observedAt must be a timestamp')
  }

  const input: TargetIdentityInput = {
    profileName,
    tenantId: value.tenantId,
    resource,
    ...(typeof value.objectId === 'string' ? {objectId: value.objectId} : {}),
    isDemoCompany: value.isDemoCompany,
    observedAt: value.observedAt,
    ...(typeof value.freshUntil === 'number' ? {freshUntil: value.freshUntil} : {}),
    capabilities: identityStringArray(value.capabilities, 'capabilities'),
    scopes: identityStringArray(value.scopes, 'scopes'),
  }

  try {
    return createTargetIdentity(input)
  } catch {
    throw new OfflineTargetError('IDENTITY_INVALID', 'Identity fields were rejected by the kernel')
  }
}

/**
 * Parse a plan file before anything touches the executor. The guard re-runs
 * `parseMutationPlan` (PLAN_TAMPERED) as belt-and-braces; this is the load
 * seam, so a tampered file fails here with a clear code instead of as a late
 * STOP receipt. Expiry is deliberately not checked: an expired plan is a
 * legitimate refused attempt and earns its guard-side PLAN_EXPIRED receipt.
 */
export function loadOfflinePlan(path: string, profileName: string, resource: string): MutationPlan {
  const value: unknown = readJsonObject(path, 'plan')
  const plan = parseMutationPlan(value)
  if (!plan) {
    throw new OfflineTargetError('PLAN_INVALID', 'The plan file is not a verifiable mutation plan')
  }
  if (plan.profileName !== profileName || plan.resource !== resource) {
    throw new OfflineTargetError('TARGET_MISMATCH', 'Plan does not match the explicit profile and resource')
  }
  if (containsSecretShapedData(plan.payload)) {
    throw new OfflineTargetError('DATA_HYGIENE_REJECTED', 'Plan payload is secret-shaped and is not accepted')
  }
  return plan
}

/**
 * Apply executes exactly the verified plan, so the request is derived from it
 * rather than re-supplied. The guard's request-vs-plan checks are vacuous here
 * by design; they defend programmatic callers.
 */
export function applyRequestFor(plan: MutationPlan): MutationRequest {
  return {
    profileName: plan.profileName,
    resource: plan.resource,
    operation: plan.operation,
    payload: plan.payload,
    objectCount: 1,
    readBackExpectation: plan.readBackExpectation,
  }
}

export function loadPlanInput(path: string): OfflinePlanInput {
  const value = readJsonObject(path, 'plan input')
  const expected = value.expected ?? value.payload
  if (containsSecretShapedData(value.payload) || containsSecretShapedData(expected)) {
    throw new OfflineTargetError('DATA_HYGIENE_REJECTED', 'Secret-shaped payload or expected input is not accepted')
  }

  return {
    ...(typeof value.planId === 'string' ? {planId: value.planId} : {}),
    operation: requireString(value.operation, 'operation'),
    payload: value.payload,
    expected,
    requiredCapabilities: inputStringArray(value.requiredCapabilities, 'requiredCapabilities'),
    requiredScopes: inputStringArray(value.requiredScopes, 'requiredScopes'),
    ...(typeof value.createdAt === 'number' ? {createdAt: value.createdAt} : {}),
    ...(typeof value.expiresAt === 'number' ? {expiresAt: value.expiresAt} : {}),
  }
}

/**
 * Load a synthetic records fixture for `target read --records`. Records files
 * are the one offline input that is a JSON array rather than an object, so
 * they get their own reader; hygiene is checked at load so a secret-shaped
 * fixture fails here instead of as a late STOP receipt.
 */
export function loadOfflineReadRecords(path: string): readonly unknown[] {
  const value = readJsonValue(path, 'records')
  if (!Array.isArray(value)) {
    throw new OfflineTargetError('FILE_UNREADABLE', 'The records file must contain one JSON array')
  }
  if (containsSecretShapedData(value)) {
    throw new OfflineTargetError('DATA_HYGIENE_REJECTED', 'Secret-shaped records fixture is not accepted')
  }
  return value
}

function readJsonObject(path: string, role: string): Record<string, unknown> {
  const value = readJsonValue(path, role)
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OfflineTargetError('FILE_UNREADABLE', `The ${role} file must contain one JSON object`)
  }
  return value as Record<string, unknown>
}

function readJsonValue(path: string, role: string): unknown {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    throw new OfflineTargetError('FILE_UNREADABLE', `The ${role} file could not be read`)
  }

  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new OfflineTargetError('FILE_UNREADABLE', `The ${role} file is not valid JSON`)
  }

  return value
}

function identityStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    throw new OfflineTargetError('IDENTITY_INVALID', `Identity ${label} must be an array of strings`)
  }
  return value
}

function inputStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(item => typeof item === 'string')) {
    throw new OfflineTargetError('PLAN_INVALID', `Plan input ${label} must be a non-empty array of strings`)
  }
  return value
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new OfflineTargetError('PLAN_INVALID', `Plan input ${label} is required`)
  }
  return value
}
