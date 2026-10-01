import {digestJson} from './canonical.js'
import {hasRequiredCapabilities, hasRequiredScopes} from './capabilities.js'
import {verifyConfirmation} from './confirmation.js'
import {createTargetBinding, isIdentityFresh, sameBinding, targetMatches, verifyTargetIdentity} from './identity.js'
import {parseMutationPlan, isPlanUnexpired} from './plan.js'
import {parseReadBackExpectation} from './readback.js'
import type {
  MutationGuardContext,
  MutationGuardDecision,
  MutationGuardFailure,
  MutationGuardSuccess,
  MutationPlan,
  MutationRequest,
  TargetIdentity,
} from './types.js'

export interface MutationGuardInput {
  request: MutationRequest
  plan: MutationPlan
  confirmation: string
  context?: MutationGuardContext
  profileName?: string
  identity?: TargetIdentity
  capabilities?: readonly string[]
  scopes?: readonly string[]
  receiptSink?: MutationGuardContext['receiptSink']
  now?: number
}

/** Evaluate every pre-dispatch safety requirement without touching a transport. */
export function evaluateMutationGuard(input: MutationGuardInput): MutationGuardDecision {
  if (!isObjectRecord(input) || !isObjectRecord(input.request) || !isObjectRecord(input.plan)) {
    return failure('INVALID_REQUEST')
  }

  const context = resolveContext(input)
  const now = input.now ?? context.now ?? Date.now()

  if (
    !context.receiptSink ||
    typeof context.receiptSink.write !== 'function' ||
    typeof context.receiptSink.writeAhead !== 'function'
  ) {
    return failure('RECEIPT_SINK_REQUIRED')
  }
  if (!hasText(context.profileName) || !hasText(input.request.profileName)) {
    return failure('PROFILE_REQUIRED')
  }
  if (input.request.profileName !== context.profileName || input.request.profileName !== input.plan.profileName) {
    return failure('PROFILE_MISMATCH')
  }
  if (!context.identity) return failure('IDENTITY_REQUIRED')
  if (!verifyTargetIdentity(context.identity) || !isIdentityFresh(context.identity, now)) {
    return failure('IDENTITY_STALE')
  }

  // Parse-don't-validate: from here on every plan read is from the frozen
  // snapshot, so the values checked are the values later dispatched.
  let plan: ReturnType<typeof parseMutationPlan>
  try {
    plan = parseMutationPlan(input.plan)
  } catch {
    plan = undefined
  }
  if (!plan) return failure('PLAN_TAMPERED')
  if (plan.profileName !== context.profileName) return failure('PROFILE_MISMATCH')
  if (!isPlanUnexpired(plan, now)) return failure('PLAN_EXPIRED')

  if (input.request.resource !== plan.resource || context.identity.resource !== plan.resource) {
    return failure('RESOURCE_MISMATCH')
  }
  if (input.request.operation !== plan.operation) return failure('OPERATION_MISMATCH')
  if (!plan.requiresDemoCompany || context.identity.isDemoCompany !== true) {
    return failure('DEMO_COMPANY_REQUIRED')
  }

  let currentMatches = false
  try {
    currentMatches = targetMatches(context.identity, plan.targetBinding)
  } catch {
    currentMatches = false
  }
  if (!currentMatches) return failure('TARGET_MISMATCH')

  if (input.request.target !== undefined) {
    try {
      if (!sameBinding(createTargetBinding(input.request.target), plan.targetBinding)) {
        return failure('TARGET_MISMATCH')
      }
    } catch {
      return failure('TARGET_MISMATCH')
    }
  }

  // Authorisation comes only from the freshly verified identity. Caller-level
  // arrays are compatibility inputs, never an authority-elevation mechanism.
  const capabilities = context.identity.capabilities
  const scopes = context.identity.scopes
  try {
    if (!hasRequiredCapabilities(capabilities, plan.requiredCapabilities)) {
      return failure('CAPABILITY_REQUIRED')
    }
    if (!hasRequiredScopes(scopes, plan.requiredScopes)) return failure('SCOPE_REQUIRED')
  } catch {
    return failure('INVALID_REQUEST')
  }

  const objectCount = input.request.objectCount ?? 1
  if (plan.maxObjects !== 1 || plan.objectCount !== 1 || objectCount !== 1 || objectCount > plan.maxObjects) {
    return failure('PLAN_COUNT_BOUND')
  }

  let payloadMatches = false
  try {
    payloadMatches = digestJson(input.request.payload) === plan.payloadDigest
  } catch {
    payloadMatches = false
  }
  if (!payloadMatches) return failure('PAYLOAD_MISMATCH')

  const expectation = parseReadBackExpectation(input.request.readBackExpectation ?? plan.readBackExpectation)
  if (!expectation) {
    return failure('READBACK_EXPECTATION_REQUIRED')
  }
  if (
    expectation.expectationDigest !== plan.readBackExpectation.expectationDigest ||
    expectation.resource !== plan.resource ||
    !sameBinding(expectation.targetBinding, plan.targetBinding)
  ) {
    return failure('READBACK_EXPECTATION_MISMATCH')
  }

  let exactConfirmation = false
  try {
    exactConfirmation = verifyConfirmation(input.confirmation, plan)
  } catch {
    exactConfirmation = false
  }
  if (!exactConfirmation) return failure('CONFIRMATION_MISMATCH')

  return allowed(plan)
}

function resolveContext(input: MutationGuardInput): MutationGuardContext {
  const suppliedContext = isObjectRecord(input.context) ? input.context : {}
  return {
    ...suppliedContext,
    ...(input.profileName === undefined ? {} : {profileName: input.profileName}),
    ...(input.identity === undefined ? {} : {identity: input.identity}),
    ...(input.capabilities === undefined ? {} : {capabilities: input.capabilities}),
    ...(input.scopes === undefined ? {} : {scopes: input.scopes}),
    ...(input.receiptSink === undefined ? {} : {receiptSink: input.receiptSink}),
    ...(input.now === undefined ? {} : {now: input.now}),
  }
}

function allowed(plan: MutationPlan): MutationGuardSuccess {
  return {allowed: true, code: 'ALLOWED', binding: plan.targetBinding, plan}
}

function failure(code: MutationGuardFailure['code']): MutationGuardFailure {
  return {allowed: false, code}
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
