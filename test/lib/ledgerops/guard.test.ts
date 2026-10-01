import {describe, expect, it, vi} from 'vitest'
import {
  confirmationTokenFor,
  createMutationPlan,
  createReadBackExpectation,
  createTargetIdentity,
  evaluateMutationGuard,
  type MutationGuardDecision,
  type MutationGuardInput,
  type MutationPlan,
  type MutationRequest,
  type TargetIdentity,
  type TargetIdentityInput,
} from '../../../src/lib/ledgerops/index.js'

const NOW = Date.parse('2026-08-07T00:00:00.000Z')
const PROFILE = 'synthetic-demo-profile'
const RESOURCE = 'synthetic-resource'
const CAPABILITY = 'ledger.synthetic.write'
const SCOPE = 'ledger.synthetic.scope'
const PAYLOAD = {amount: '10.01'}
const OTHER_PAYLOAD = {amount: '99.99'}

function identityFor(overrides: Partial<TargetIdentityInput> = {}): TargetIdentity {
  return createTargetIdentity({
    profileName: PROFILE,
    tenantId: 'synthetic-tenant',
    resource: RESOURCE,
    isDemoCompany: true,
    observedAt: NOW,
    freshUntil: NOW + 60_000,
    capabilities: [CAPABILITY],
    scopes: [SCOPE],
    ...overrides,
  })
}

function planFor(target: TargetIdentity, overrides: Record<string, unknown> = {}): MutationPlan {
  return createMutationPlan({
    planId: 'guard-coverage-plan',
    profileName: PROFILE,
    resource: RESOURCE,
    operation: 'create',
    target,
    payload: PAYLOAD,
    requiredCapabilities: [CAPABILITY],
    requiredScopes: [SCOPE],
    readBack: {expected: PAYLOAD},
    createdAt: NOW,
    expiresAt: NOW + 120_000,
    ...overrides,
  })
}

function requestFor(plan: MutationPlan, overrides: Partial<MutationRequest> = {}): MutationRequest {
  return {
    profileName: PROFILE,
    resource: RESOURCE,
    operation: 'create',
    payload: PAYLOAD,
    objectCount: 1,
    readBackExpectation: plan.readBackExpectation,
    ...overrides,
  }
}

/**
 * A fixture that the guard allows. Every failure test below starts here and
 * breaks exactly one thing, so the asserted code is the only reachable one.
 */
function passing(): MutationGuardInput & {identity: TargetIdentity} {
  const identity = identityFor()
  const plan = planFor(identity)
  return {
    identity,
    request: requestFor(plan),
    plan,
    confirmation: confirmationTokenFor(plan),
    context: {
      profileName: PROFILE,
      identity,
      receiptSink: {write: vi.fn(), writeAhead: vi.fn()},
      now: NOW + 1,
    },
  }
}

function decide(input: MutationGuardInput): MutationGuardDecision {
  return evaluateMutationGuard({
    request: input.request,
    plan: input.plan,
    confirmation: input.confirmation,
    context: input.context,
  })
}

function expectCode(input: MutationGuardInput, code: string): void {
  expect(decide(input)).toEqual({allowed: false, code})
}

describe('evaluateMutationGuard allow path', () => {
  it('allows a fully satisfied mutation and returns the plan target binding', () => {
    const fixture = passing()

    expect(decide(fixture)).toEqual({
      allowed: true,
      code: 'ALLOWED',
      binding: fixture.plan.targetBinding,
      plan: fixture.plan,
    })
  })
})

describe('evaluateMutationGuard failure codes', () => {
  it('stops INVALID_REQUEST when the request or plan is not an object', () => {
    const fixture = passing()

    expectCode({...fixture, request: null as unknown as MutationRequest}, 'INVALID_REQUEST')
    expectCode({...fixture, plan: 'not-a-plan' as unknown as MutationPlan}, 'INVALID_REQUEST')
  })

  it('stops RECEIPT_SINK_REQUIRED when no usable receipt sink is supplied', () => {
    const fixture = passing()

    expectCode({...fixture, context: {...fixture.context, receiptSink: undefined}}, 'RECEIPT_SINK_REQUIRED')
    expectCode({...fixture, context: {...fixture.context, receiptSink: {} as never}}, 'RECEIPT_SINK_REQUIRED')
    expectCode(
      {...fixture, context: {...fixture.context, receiptSink: {write: vi.fn()} as never}},
      'RECEIPT_SINK_REQUIRED',
    )
    expectCode(
      {...fixture, context: {...fixture.context, receiptSink: {writeAhead: vi.fn()} as never}},
      'RECEIPT_SINK_REQUIRED',
    )
  })

  it('stops PROFILE_REQUIRED when either the context or the request has no profile', () => {
    const fixture = passing()

    expectCode({...fixture, context: {...fixture.context, profileName: undefined}}, 'PROFILE_REQUIRED')
    expectCode({...fixture, request: requestFor(fixture.plan, {profileName: '   '})}, 'PROFILE_REQUIRED')
  })

  it('stops PROFILE_MISMATCH when the request profile does not bind to the plan', () => {
    const fixture = passing()

    expectCode(
      {
        ...fixture,
        request: requestFor(fixture.plan, {profileName: 'other-profile'}),
        context: {...fixture.context, profileName: 'other-profile'},
      },
      'PROFILE_MISMATCH',
    )
  })

  it('stops IDENTITY_REQUIRED when the context carries no verified identity', () => {
    const fixture = passing()

    expectCode({...fixture, context: {...fixture.context, identity: undefined}}, 'IDENTITY_REQUIRED')
  })

  it('stops IDENTITY_STALE when the identity is past its freshness window', () => {
    const identity = identityFor({freshUntil: NOW + 1})
    const plan = planFor(identity)

    expectCode(
      {
        request: requestFor(plan),
        plan,
        confirmation: confirmationTokenFor(plan),
        context: {profileName: PROFILE, identity, receiptSink: {write: vi.fn(), writeAhead: vi.fn()}, now: NOW + 2},
      },
      'IDENTITY_STALE',
    )
  })

  it('stops PLAN_TAMPERED when the plan no longer matches its own digest', () => {
    const fixture = passing()

    expectCode({...fixture, plan: {...fixture.plan, payload: OTHER_PAYLOAD}}, 'PLAN_TAMPERED')
  })

  it('stops PLAN_EXPIRED once the evaluation time reaches the plan expiry', () => {
    const identity = identityFor()
    const plan = planFor(identity, {expiresAt: NOW + 10})

    expectCode(
      {
        request: requestFor(plan),
        plan,
        confirmation: confirmationTokenFor(plan),
        context: {profileName: PROFILE, identity, receiptSink: {write: vi.fn(), writeAhead: vi.fn()}, now: NOW + 20},
      },
      'PLAN_EXPIRED',
    )
  })

  it('stops RESOURCE_MISMATCH when the request resource differs from the plan', () => {
    const fixture = passing()

    expectCode({...fixture, request: requestFor(fixture.plan, {resource: 'other-resource'})}, 'RESOURCE_MISMATCH')
  })

  it('stops OPERATION_MISMATCH when the request operation differs from the plan', () => {
    const fixture = passing()

    expectCode({...fixture, request: requestFor(fixture.plan, {operation: 'update'})}, 'OPERATION_MISMATCH')
  })

  it('stops DEMO_COMPANY_REQUIRED when the verified identity is not a demo company', () => {
    const identity = identityFor({isDemoCompany: false})
    const plan = planFor(identity)

    expectCode(
      {
        request: requestFor(plan),
        plan,
        confirmation: confirmationTokenFor(plan),
        context: {profileName: PROFILE, identity, receiptSink: {write: vi.fn(), writeAhead: vi.fn()}, now: NOW + 1},
      },
      'DEMO_COMPANY_REQUIRED',
    )
  })

  it('stops TARGET_MISMATCH when the current identity is not the planned target', () => {
    const fixture = passing()
    const otherTenant = identityFor({tenantId: 'other-tenant'})

    expectCode({...fixture, context: {...fixture.context, identity: otherTenant}}, 'TARGET_MISMATCH')
  })

  it('stops TARGET_MISMATCH when the request names a target the plan did not bind', () => {
    const fixture = passing()
    const otherTenant = identityFor({tenantId: 'other-tenant'})

    expectCode({...fixture, request: requestFor(fixture.plan, {target: otherTenant})}, 'TARGET_MISMATCH')
  })

  it('stops CAPABILITY_REQUIRED when the identity lacks a required capability', () => {
    const identity = identityFor({capabilities: []})
    const plan = planFor(identity)

    expectCode(
      {
        request: requestFor(plan),
        plan,
        confirmation: confirmationTokenFor(plan),
        context: {profileName: PROFILE, identity, receiptSink: {write: vi.fn(), writeAhead: vi.fn()}, now: NOW + 1},
      },
      'CAPABILITY_REQUIRED',
    )
  })

  it('stops SCOPE_REQUIRED when the identity lacks a required scope', () => {
    const identity = identityFor({scopes: []})
    const plan = planFor(identity)

    expectCode(
      {
        request: requestFor(plan),
        plan,
        confirmation: confirmationTokenFor(plan),
        context: {profileName: PROFILE, identity, receiptSink: {write: vi.fn(), writeAhead: vi.fn()}, now: NOW + 1},
      },
      'SCOPE_REQUIRED',
    )
  })

  it('stops PLAN_COUNT_BOUND when the request asks for more than one object', () => {
    const fixture = passing()

    expectCode({...fixture, request: requestFor(fixture.plan, {objectCount: 2})}, 'PLAN_COUNT_BOUND')
  })

  it('stops PAYLOAD_MISMATCH when the request payload is not the planned payload', () => {
    const fixture = passing()

    expectCode({...fixture, request: requestFor(fixture.plan, {payload: OTHER_PAYLOAD})}, 'PAYLOAD_MISMATCH')
  })

  it('stops READBACK_EXPECTATION_REQUIRED when the supplied expectation does not verify', () => {
    const fixture = passing()
    const unverifiable = {...fixture.plan.readBackExpectation, expectationDigest: '0'.repeat(64)}

    expectCode(
      {...fixture, request: requestFor(fixture.plan, {readBackExpectation: unverifiable})},
      'READBACK_EXPECTATION_REQUIRED',
    )
  })

  it('stops READBACK_EXPECTATION_MISMATCH when a valid expectation is not the planned one', () => {
    const fixture = passing()
    const otherExpectation = createReadBackExpectation({
      resource: RESOURCE,
      target: fixture.identity,
      expected: OTHER_PAYLOAD,
    })

    expectCode(
      {...fixture, request: requestFor(fixture.plan, {readBackExpectation: otherExpectation})},
      'READBACK_EXPECTATION_MISMATCH',
    )
  })

  it('stops CONFIRMATION_MISMATCH when the token does not bind to the plan digest', () => {
    const fixture = passing()

    expectCode({...fixture, confirmation: `CONFIRM ${'0'.repeat(64)}`}, 'CONFIRMATION_MISMATCH')
  })
})
