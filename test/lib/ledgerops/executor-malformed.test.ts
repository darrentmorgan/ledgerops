import {describe, expect, it, vi} from 'vitest'
import {
  AUDIT_RECEIPT_ALLOWED_KEYS,
  InMemoryReceiptSink,
  confirmationTokenFor,
  createMutationPlan,
  createTargetIdentity,
  executeMutation,
  isAuditReceipt,
  type MutationTransport,
  type TargetBinding,
} from '../../../src/lib/ledgerops/index.js'

const NOW = Date.parse('2026-08-07T00:00:00.000Z')
const PROFILE = 'synthetic-demo-profile'
const RESOURCE = 'synthetic-resource'
const CAPABILITY = 'ledger.synthetic.write'
const SCOPE = 'ledger.synthetic.scope'
const PAYLOAD = {amount: '10.01'}

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
    planId: 'executor-malformed-regression-plan',
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
  const request = {
    profileName: PROFILE,
    resource: RESOURCE,
    operation: 'create' as const,
    payload: PAYLOAD,
    objectCount: 1 as const,
    readBackExpectation: plan.readBackExpectation,
  }
  return {identity, plan, request}
}

function transport(binding: TargetBinding) {
  return {
    binding,
    dispatch: vi.fn(async () => ({accepted: true})),
    readBack: vi.fn(async () => ({status: 'found' as const, records: [PAYLOAD]})),
  } satisfies MutationTransport
}

function expectStop(result: Awaited<ReturnType<typeof executeMutation>>) {
  expect(result).toEqual(
    expect.objectContaining({
      outcome: 'STOP',
      terminal: 'STOP',
      stop: true,
      dispatched: false,
      dispatchState: 'not-dispatched',
      readBackClassification: 'not-run',
    }),
  )
  expect(isAuditReceipt(result.receipt)).toBe(true)
  expect(result.receipt).toEqual(
    expect.objectContaining({
      outcome: 'STOP',
      terminal: 'STOP',
      dispatchState: 'not-dispatched',
      readBackClassification: 'not-run',
    }),
  )
  expect(
    Object.keys(result.receipt).every(key => (AUDIT_RECEIPT_ALLOWED_KEYS as readonly string[]).includes(key)),
  ).toBe(true)
}

describe('executeMutation malformed strict input', () => {
  it('returns one allowlisted STOP receipt for null without transport access', async () => {
    const result = await executeMutation(null as never)

    expectStop(result)
  })

  it.each([
    ['null request', (base: ReturnType<typeof fixture>) => ({...base, request: null})],
    ['null plan', (base: ReturnType<typeof fixture>) => ({...base, plan: null})],
    ['null context', (base: ReturnType<typeof fixture>) => ({...base, context: null})],
    [
      'malformed nested shapes',
      (base: ReturnType<typeof fixture>) => ({
        ...base,
        request: {...base.request, profileName: null, readBackExpectation: {unexpected: true}},
        plan: {...base.plan, targetBinding: null, readBackExpectation: {unexpected: true}},
        context: {...base.context, identity: {profileName: null, capabilities: null}},
      }),
    ],
  ])('%s returns one STOP receipt and never dispatches or reads back', async (_label, mutate) => {
    const {identity, plan, request} = fixture()
    const calls = transport(plan.targetBinding)
    const sink = new InMemoryReceiptSink()
    const base = {
      request,
      plan,
      confirmation: confirmationTokenFor(plan),
      context: {profileName: PROFILE, identity, receiptSink: sink, now: NOW + 1},
      transport: calls,
      now: NOW + 1,
    }
    const input = mutate(base)
    const result = await executeMutation(input as never)

    expectStop(result)
    expect(calls.dispatch).not.toHaveBeenCalled()
    expect(calls.readBack).not.toHaveBeenCalled()
    if (input.context?.receiptSink) {
      expect(sink.receipts).toHaveLength(1)
    }
  })
})
