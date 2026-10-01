import {describe, expect, it} from 'vitest'
import {
  confirmationTokenFor,
  createMutationPlan,
  createTargetBinding,
  createTargetIdentity,
  executeMutation,
  InMemoryReceiptSink,
} from '../../../src/lib/ledgerops/index.js'
import {createDryRunTransport} from '../../../src/lib/ledgerops/dry-run-transport.js'

const NOW = Date.parse('2026-08-07T00:00:00.000Z')
const PROFILE = 'synthetic-demo-profile'
const RESOURCE = 'synthetic-resource'
const CAPABILITY = 'ledger.synthetic.write'
const SCOPE = 'ledger.synthetic.scope'
const PAYLOAD = {amount: '10.01'}

const OTHER_BINDING = createTargetBinding({
  profileName: PROFILE,
  tenantId: 'other-synthetic-tenant',
  resource: RESOURCE,
  isDemoCompany: true,
  observedAt: NOW,
  freshUntil: NOW + 60_000,
})

function fixture() {
  const identity = createTargetIdentity({
    profileName: PROFILE,
    tenantId: 'synthetic-tenant',
    resource: RESOURCE,
    isDemoCompany: true,
    observedAt: NOW,
    freshUntil: NOW + 60_000,
    capabilities: [CAPABILITY],
    scopes: [SCOPE],
  })
  const plan = createMutationPlan({
    planId: 'dry-run-transport-plan',
    profileName: PROFILE,
    resource: RESOURCE,
    operation: 'create',
    target: identity,
    payload: PAYLOAD,
    requiredCapabilities: [CAPABILITY],
    requiredScopes: [SCOPE],
    readBack: {expected: PAYLOAD},
    createdAt: NOW,
    expiresAt: NOW + 120_000,
  })
  return {
    identity,
    plan,
    request: {
      profileName: PROFILE,
      resource: RESOURCE,
      operation: 'create' as const,
      payload: PAYLOAD,
      objectCount: 1 as const,
      readBackExpectation: plan.readBackExpectation,
    },
  }
}

describe('dry-run transport', () => {
  it('reads back what one dispatch put in', async () => {
    const data = fixture()
    const sink = new InMemoryReceiptSink()

    const result = await executeMutation({
      ...data,
      confirmation: confirmationTokenFor(data.plan),
      context: {profileName: PROFILE, identity: data.identity, receiptSink: sink, now: NOW + 1},
      transport: createDryRunTransport(data.identity),
      now: NOW + 1,
    })

    expect(result).toEqual(
      expect.objectContaining({
        status: 'verified',
        outcome: 'VERIFIED',
        terminal: 'CONTINUE',
        dispatchState: 'accepted',
        readBackClassification: 'verified',
      }),
    )
  })

  it('reports the plan missing until it has been dispatched', () => {
    const {identity, plan} = fixture()
    const adapter = createDryRunTransport(identity)

    expect(adapter.readBack({targetBinding: plan.targetBinding, planDigest: plan.planDigest})).toEqual({
      status: 'missing',
    })
  })

  it('throws on either call for a target it is not bound to', () => {
    const {identity, plan} = fixture()
    const adapter = createDryRunTransport(identity)

    expect(() =>
      adapter.dispatch({
        operation: plan.operation,
        payload: plan.payload,
        targetBinding: OTHER_BINDING,
        planDigest: plan.planDigest,
      }),
    ).toThrow()
    expect(() => adapter.readBack({targetBinding: OTHER_BINDING, planDigest: plan.planDigest})).toThrow()
  })

  it('leaves the executor uncertain when an adapter misreports its binding', async () => {
    const data = fixture()
    const sink = new InMemoryReceiptSink()
    // Advertising the plan's target while bound elsewhere is the one way past the
    // kernel's pre-dispatch check; the adapter must still refuse to write.
    const misreporting = {
      ...createDryRunTransport(OTHER_BINDING),
      binding: data.plan.targetBinding,
    }

    const result = await executeMutation({
      ...data,
      confirmation: confirmationTokenFor(data.plan),
      context: {profileName: PROFILE, identity: data.identity, receiptSink: sink, now: NOW + 1},
      transport: misreporting,
      now: NOW + 1,
    })

    expect(result).toEqual(
      expect.objectContaining({
        status: 'uncertain',
        outcome: 'UNCERTAIN',
        terminal: 'STOP',
        stop: true,
        dispatchState: 'attempted',
        readBackClassification: 'not-run',
      }),
    )
    expect(sink.receipts[0]).toEqual(
      expect.objectContaining({
        outcome: 'UNCERTAIN',
        terminal: 'STOP',
        reasonCode: 'DISPATCH_UNCERTAIN',
      }),
    )
  })
})
