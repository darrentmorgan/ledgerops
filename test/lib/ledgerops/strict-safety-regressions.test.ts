import {describe, expect, it, vi} from 'vitest'
import {
  confirmationTokenFor,
  createMutationPlan,
  createTargetIdentity,
  evaluateMutationGuard,
  executeMutation,
} from '../../../src/lib/ledgerops/index.js'
import {createDryRunTransport} from '../../../src/lib/ledgerops/dry-run-transport.js'

const NOW = Date.parse('2026-08-07T00:00:00.000Z')
const PROFILE = 'synthetic-demo-profile'
const RESOURCE = 'synthetic-resource'
const CAPABILITY = 'ledger.synthetic.write'
const SCOPE = 'ledger.synthetic.scope'
const PAYLOAD = {amount: '10.01'}

function fixture(capabilities: readonly string[] = [CAPABILITY], scopes: readonly string[] = [SCOPE]) {
  const identity = createTargetIdentity({
    profileName: PROFILE,
    tenantId: 'synthetic-tenant',
    resource: RESOURCE,
    isDemoCompany: true,
    observedAt: NOW,
    freshUntil: NOW + 60_000,
    capabilities,
    scopes,
  })
  const plan = createMutationPlan({
    planId: 'strict-regression-plan',
    profileName: PROFILE,
    resource: RESOURCE,
    operation: 'create',
    target: identity,
    payload: PAYLOAD,
    requiredCapabilities: [CAPABILITY],
    requiredScopes: [SCOPE],
    readBack: {expected: PAYLOAD},
    createdAt: NOW,
    expiresAt: NOW + 30_000,
  })
  const request = {
    profileName: PROFILE,
    resource: RESOURCE,
    operation: 'create',
    payload: PAYLOAD,
    objectCount: 1,
    readBackExpectation: plan.readBackExpectation,
  } as const
  return {identity, plan, request}
}

describe('strict LedgerOps mutation safety regressions', () => {
  it('does not let caller arrays elevate identity capabilities or scopes', () => {
    const missingCapability = fixture([], [SCOPE])
    const capabilityDecision = evaluateMutationGuard({
      ...missingCapability,
      confirmation: confirmationTokenFor(missingCapability.plan),
      context: {
        profileName: PROFILE,
        identity: missingCapability.identity,
        capabilities: [CAPABILITY],
        scopes: [SCOPE],
        receiptSink: {write: vi.fn(), writeAhead: vi.fn()},
        now: NOW + 1,
      },
    })
    expect(capabilityDecision).toEqual({allowed: false, code: 'CAPABILITY_REQUIRED'})

    const missingScope = fixture([CAPABILITY], [])
    const scopeDecision = evaluateMutationGuard({
      ...missingScope,
      confirmation: confirmationTokenFor(missingScope.plan),
      context: {
        profileName: PROFILE,
        identity: missingScope.identity,
        capabilities: [CAPABILITY],
        scopes: [SCOPE],
        receiptSink: {write: vi.fn(), writeAhead: vi.fn()},
        now: NOW + 1,
      },
    })
    expect(scopeDecision).toEqual({allowed: false, code: 'SCOPE_REQUIRED'})
  })

  it('returns terminal uncertainty when a post-dispatch receipt cannot be persisted', async () => {
    const data = fixture()
    const result = await executeMutation({
      ...data,
      confirmation: confirmationTokenFor(data.plan),
      context: {
        profileName: PROFILE,
        identity: data.identity,
        receiptSink: {
          write: vi.fn(async () => {
            throw new Error('synthetic sink failure')
          }),
          writeAhead: vi.fn(),
        },
        now: NOW + 1,
      },
      transport: createDryRunTransport(data.identity),
      now: NOW + 1,
    })

    expect(result).toEqual(
      expect.objectContaining({
        status: 'uncertain',
        outcome: 'UNCERTAIN',
        terminal: 'STOP',
        stop: true,
        receiptWriteFailed: true,
      }),
    )
    expect(result.receipt).toEqual(
      expect.objectContaining({
        outcome: 'UNCERTAIN',
        terminal: 'STOP',
        reasonCode: 'RECEIPT_WRITE_FAILED',
      }),
    )
  })
})
