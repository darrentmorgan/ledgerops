import {describe, expect, it, vi} from 'vitest'
import {
  AUDIT_RECEIPT_ALLOWED_KEYS,
  confirmationTokenFor,
  createMutationPlan,
  createTargetBinding,
  createTargetIdentity,
  executeMutation,
  isAuditReceipt,
  type MutationTransport,
  type TargetBinding,
  InMemoryReceiptSink,
} from '../../../src/lib/ledgerops/index.js'

const NOW = Date.parse('2026-08-07T00:00:00.000Z')
const PROFILE = 'synthetic-demo-profile'
const RESOURCE = 'synthetic-resource'
const CAPABILITY = 'ledger.synthetic.write'
const SCOPE = 'ledger.synthetic.scope'
const PAYLOAD = {amount: '10.01'}

function fixture(freshUntil = NOW + 60_000) {
  const identity = createTargetIdentity({
    profileName: PROFILE,
    tenantId: 'synthetic-tenant',
    resource: RESOURCE,
    isDemoCompany: true,
    observedAt: NOW,
    freshUntil,
    capabilities: [CAPABILITY],
    scopes: [SCOPE],
  })
  const plan = createMutationPlan({
    planId: 'executor-stop-regression-plan',
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

function transport(binding: TargetBinding) {
  return {
    binding,
    dispatch: vi.fn(async () => ({accepted: true})),
    readBack: vi.fn(async () => ({status: 'found' as const, records: [PAYLOAD]})),
  } satisfies MutationTransport
}

function expectAllowlistedReceipt(sink: InMemoryReceiptSink): void {
  expect(sink.receipts).toHaveLength(1)
  const receipt = sink.receipts[0]
  expect(isAuditReceipt(receipt)).toBe(true)
  expect(Object.keys(receipt).every(key => (AUDIT_RECEIPT_ALLOWED_KEYS as readonly string[]).includes(key))).toBe(true)
}

describe('strict executor pre-dispatch STOP contract', () => {
  it('stops confirmation mismatch before dispatch and read-back', async () => {
    const data = fixture()
    const calls = transport(data.plan.targetBinding)
    const sink = new InMemoryReceiptSink()

    const result = await executeMutation({
      ...data,
      confirmation: `CONFIRM ${'0'.repeat(64)}`,
      context: {
        profileName: PROFILE,
        identity: data.identity,
        receiptSink: sink,
        now: NOW + 1,
      },
      transport: calls,
      now: NOW + 1,
    })

    expect(result).toEqual(
      expect.objectContaining({
        outcome: 'STOP',
        terminal: 'STOP',
        stop: true,
        dispatched: false,
        dispatchState: 'not-dispatched',
        readBackClassification: 'not-run',
        guard: {allowed: false, code: 'CONFIRMATION_MISMATCH'},
      }),
    )
    expect(calls.dispatch).not.toHaveBeenCalled()
    expect(calls.readBack).not.toHaveBeenCalled()
    expectAllowlistedReceipt(sink)
    expect(sink.receipts[0]).toEqual(
      expect.objectContaining({
        outcome: 'STOP',
        terminal: 'STOP',
        dispatchState: 'not-dispatched',
        readBackClassification: 'not-run',
        reasonCode: 'CONFIRMATION_MISMATCH',
      }),
    )
  })

  it('stops stale identity before dispatch and read-back', async () => {
    const data = fixture(NOW + 1)
    const calls = transport(data.plan.targetBinding)
    const sink = new InMemoryReceiptSink()

    const result = await executeMutation({
      ...data,
      confirmation: confirmationTokenFor(data.plan),
      context: {
        profileName: PROFILE,
        identity: data.identity,
        receiptSink: sink,
        now: NOW + 2,
      },
      transport: calls,
      now: NOW + 2,
    })

    expect(result).toEqual(
      expect.objectContaining({
        outcome: 'STOP',
        terminal: 'STOP',
        stop: true,
        dispatched: false,
        dispatchState: 'not-dispatched',
        readBackClassification: 'not-run',
        guard: {allowed: false, code: 'IDENTITY_STALE'},
      }),
    )
    expect(calls.dispatch).not.toHaveBeenCalled()
    expect(calls.readBack).not.toHaveBeenCalled()
    expectAllowlistedReceipt(sink)
    expect(sink.receipts[0]).toEqual(
      expect.objectContaining({
        outcome: 'STOP',
        terminal: 'STOP',
        dispatchState: 'not-dispatched',
        readBackClassification: 'not-run',
        reasonCode: 'IDENTITY_STALE',
      }),
    )
  })

  it('stops a transport bound to another target before dispatch', async () => {
    const data = fixture()
    const calls = transport(
      createTargetBinding({
        profileName: PROFILE,
        tenantId: 'other-synthetic-tenant',
        resource: RESOURCE,
        isDemoCompany: true,
        observedAt: NOW,
        freshUntil: NOW + 60_000,
      }),
    )
    const sink = new InMemoryReceiptSink()

    const result = await executeMutation({
      ...data,
      confirmation: confirmationTokenFor(data.plan),
      context: {
        profileName: PROFILE,
        identity: data.identity,
        receiptSink: sink,
        now: NOW + 1,
      },
      transport: calls,
      now: NOW + 1,
    })

    expect(result.guard.allowed).toBe(true)
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
    expect(calls.dispatch).not.toHaveBeenCalled()
    expect(calls.readBack).not.toHaveBeenCalled()
    expectAllowlistedReceipt(sink)
    expect(sink.receipts[0]).toEqual(
      expect.objectContaining({
        outcome: 'STOP',
        terminal: 'STOP',
        dispatchState: 'not-dispatched',
        readBackClassification: 'not-run',
        reasonCode: 'TRANSPORT_BINDING_MISMATCH',
      }),
    )
  })

  it('keeps stop false on a verified read-back', async () => {
    const data = fixture()
    const calls = transport(data.plan.targetBinding)
    const sink = new InMemoryReceiptSink()

    const result = await executeMutation({
      ...data,
      confirmation: confirmationTokenFor(data.plan),
      context: {
        profileName: PROFILE,
        identity: data.identity,
        receiptSink: sink,
        now: NOW + 1,
      },
      transport: calls,
      now: NOW + 1,
    })

    expect(result).toEqual(
      expect.objectContaining({
        status: 'verified',
        outcome: 'VERIFIED',
        terminal: 'CONTINUE',
        stop: false,
        dispatched: true,
        dispatchState: 'accepted',
        readBackClassification: 'verified',
      }),
    )
    expect(calls.dispatch).toHaveBeenCalledOnce()
    expect(calls.readBack).toHaveBeenCalledOnce()
    expectAllowlistedReceipt(sink)
    expect(sink.receipts[0]).toEqual(
      expect.objectContaining({
        outcome: 'VERIFIED',
        terminal: 'CONTINUE',
        dispatchState: 'accepted',
        readBackClassification: 'verified',
      }),
    )
  })
})
