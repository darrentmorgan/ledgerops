import {describe, expect, it, vi} from 'vitest'
import {
  confirmationTokenFor,
  createMutationPlan,
  createTargetIdentity,
  createWriteAheadIntent,
  executeMutation,
  InMemoryReceiptSink,
  isWriteAheadIntent,
  WRITE_AHEAD_INTENT_ALLOWED_KEYS,
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
    planId: 'write-ahead-plan',
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

describe('write-ahead readiness before dispatch', () => {
  it('persists a verifiable intent before the transport is touched', async () => {
    const data = fixture()
    const calls = transport(data.plan.targetBinding)
    const sink = new InMemoryReceiptSink()
    const order: string[] = []
    const orderedSink = {
      writeAhead: vi.fn((intent: Parameters<InMemoryReceiptSink['writeAhead']>[0]) => {
        order.push('writeAhead')
        sink.writeAhead(intent)
      }),
      write: vi.fn((receipt: Parameters<InMemoryReceiptSink['write']>[0]) => {
        order.push('write')
        sink.write(receipt)
      }),
    }
    calls.dispatch.mockImplementation(async () => {
      order.push('dispatch')
      return {accepted: true}
    })

    const result = await executeMutation({
      ...data,
      confirmation: confirmationTokenFor(data.plan),
      context: {profileName: PROFILE, identity: data.identity, receiptSink: orderedSink, now: NOW + 1},
      transport: calls,
      now: NOW + 1,
    })

    expect(result.outcome).toBe('VERIFIED')
    expect(order).toEqual(['writeAhead', 'dispatch', 'write'])
    expect(sink.intents).toHaveLength(1)
    const intent = sink.intents[0]
    expect(isWriteAheadIntent(intent)).toBe(true)
    expect(intent).toEqual(
      expect.objectContaining({
        schemaVersion: 'ledgerops.write-ahead.v1',
        profileName: PROFILE,
        resource: RESOURCE,
        operation: 'create',
        planDigest: data.plan.planDigest,
        target: data.plan.targetBinding,
      }),
    )
    expect(Object.keys(intent).every(key => (WRITE_AHEAD_INTENT_ALLOWED_KEYS as readonly string[]).includes(key))).toBe(
      true,
    )
    expect(sink.receipts[0]?.planDigest).toBe(intent.planDigest)
    expect(sink.receipts[0]?.confirmationDigest).toBe(intent.confirmationDigest)
  })

  it('stops RECEIPT_SINK_UNAVAILABLE without dispatching when the write-ahead write fails', async () => {
    const data = fixture()
    const calls = transport(data.plan.targetBinding)
    const receipts = new InMemoryReceiptSink()
    const failingSink = {
      writeAhead: vi.fn(() => {
        throw new Error('synthetic persistence failure')
      }),
      write: vi.fn((receipt: Parameters<InMemoryReceiptSink['write']>[0]) => receipts.write(receipt)),
    }

    const result = await executeMutation({
      ...data,
      confirmation: confirmationTokenFor(data.plan),
      context: {profileName: PROFILE, identity: data.identity, receiptSink: failingSink, now: NOW + 1},
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
      }),
    )
    expect(result.guard.allowed).toBe(true)
    expect(calls.dispatch).not.toHaveBeenCalled()
    expect(calls.readBack).not.toHaveBeenCalled()
    expect(receipts.receipts[0]).toEqual(
      expect.objectContaining({
        outcome: 'STOP',
        terminal: 'STOP',
        dispatchState: 'not-dispatched',
        reasonCode: 'RECEIPT_SINK_UNAVAILABLE',
      }),
    )
  })

  it('rejects a sink without writeAhead before dispatch', async () => {
    const data = fixture()
    const calls = transport(data.plan.targetBinding)

    const result = await executeMutation({
      ...data,
      confirmation: confirmationTokenFor(data.plan),
      context: {
        profileName: PROFILE,
        identity: data.identity,
        receiptSink: {write: vi.fn()} as unknown as InMemoryReceiptSink,
        now: NOW + 1,
      },
      transport: calls,
      now: NOW + 1,
    })

    expect(result.guard).toEqual({allowed: false, code: 'RECEIPT_SINK_REQUIRED'})
    expect(result.dispatched).toBe(false)
    expect(calls.dispatch).not.toHaveBeenCalled()
  })

  it('InMemoryReceiptSink refuses a non-intent write-ahead value', () => {
    const sink = new InMemoryReceiptSink()
    expect(() => sink.writeAhead({forged: true} as never)).toThrow(TypeError)
    const data = fixture()
    const intent = createWriteAheadIntent({
      recordedAt: NOW + 1,
      profileName: PROFILE,
      resource: RESOURCE,
      operation: 'create',
      target: data.plan.targetBinding,
      planDigest: data.plan.planDigest,
      confirmationDigest: data.plan.planDigest,
    })
    expect(() => sink.writeAhead({...intent, planDigest: '0'.repeat(64)})).toThrow(TypeError)
    sink.writeAhead(intent)
    expect(sink.intents).toHaveLength(1)
  })
})
