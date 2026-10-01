import {describe, expect, it, vi} from 'vitest'
import {
  createBatchManifest,
  createMutationPlan,
  createTargetIdentity,
  preflightBatch,
  type BatchManifest,
  type BatchPreflightFailureCode,
  type MutationPlan,
  type MutationTransport,
  type ReceiptSink,
  type TargetIdentity,
  type TargetIdentityInput,
} from '../../../src/lib/ledgerops/index.js'

const NOW = Date.parse('2026-08-25T00:00:00.000Z')
const PROFILE = 'batch-preflight-profile'
const RESOURCE = 'synthetic-resource'
const CAPABILITY = 'ledger.synthetic.write'
const SCOPE = 'ledger.synthetic.scope'
const PAYLOAD = {amount: '10.01'}

function identityFor(overrides: Partial<TargetIdentityInput> = {}): TargetIdentity {
  return createTargetIdentity({
    profileName: PROFILE,
    tenantId: 'batch-tenant',
    resource: RESOURCE,
    isDemoCompany: true,
    observedAt: NOW,
    freshUntil: NOW + 60_000,
    capabilities: [CAPABILITY],
    scopes: [SCOPE],
    ...overrides,
  })
}

function planFor(
  planId: string,
  overrides: Record<string, unknown> = {},
  target: TargetIdentity = identityFor(),
): MutationPlan {
  return createMutationPlan({
    planId,
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

function manifestFor(plans: readonly MutationPlan[], overrides: Record<string, unknown> = {}): BatchManifest {
  return createBatchManifest({
    batchId: 'batch-preflight-1',
    profileName: PROFILE,
    entries: plans.map(plan => ({planId: plan.planId, planDigest: plan.planDigest})),
    provenance: {
      sourceReceiptId: plans[0].planDigest,
      sourceManifestHashes: [plans[0].planDigest],
    },
    createdAt: NOW,
    expiresAt: NOW + 300_000,
    ...overrides,
  })
}

/** A passing fixture: three members sharing a profile and tenant. */
function passing(): {manifest: BatchManifest; plans: readonly MutationPlan[]} {
  const plans = [planFor('batch-plan-1'), planFor('batch-plan-2'), planFor('batch-plan-3')]
  return {manifest: manifestFor(plans), plans}
}

interface Sinks {
  receiptSink: ReceiptSink
  transport: MutationTransport
}

/** Spies proving preflight never reaches a sink or a transport, on any path. */
function spySinks(): Sinks {
  return {
    receiptSink: {write: vi.fn(), writeAhead: vi.fn()},
    transport: {
      binding: {
        profileName: PROFILE,
        resource: RESOURCE,
        tenantFingerprint: 'x'.repeat(64),
        targetFingerprint: 'x'.repeat(64),
      },
      dispatch: vi.fn(),
      readBack: vi.fn(),
    },
  }
}

function assertNoSideEffects(sinks: Sinks): void {
  expect(sinks.receiptSink.write).not.toHaveBeenCalled()
  expect(sinks.receiptSink.writeAhead).not.toHaveBeenCalled()
  expect(sinks.transport.dispatch).not.toHaveBeenCalled()
  expect(sinks.transport.readBack).not.toHaveBeenCalled()
}

describe('preflightBatch', () => {
  it('accepts a coherent batch and returns defensive parsed snapshots only', () => {
    const {manifest, plans} = passing()
    const sinks = spySinks()

    const decision = preflightBatch({manifest, plans, now: NOW})

    expect(decision.ok).toBe(true)
    if (!decision.ok) throw new Error('expected success')
    expect(decision.manifest).toEqual(manifest)
    expect(decision.plans.map(plan => plan.planId)).toEqual(plans.map(plan => plan.planId))
    expect(Object.isFrozen(decision.plans)).toBe(true)
    assertNoSideEffects(sinks)
  })

  type FailureCase = {
    readonly name: string
    readonly code: BatchPreflightFailureCode
    readonly index?: number
    readonly build: () => {manifest: unknown; plans: readonly unknown[]}
  }

  const cases: readonly FailureCase[] = [
    {
      name: 'manifest is not a parseable signed record',
      code: 'MANIFEST_INVALID',
      build: () => {
        const {plans} = passing()
        return {manifest: {not: 'a manifest'}, plans}
      },
    },
    {
      name: 'manifest digest was tampered',
      code: 'MANIFEST_INVALID',
      build: () => {
        const {manifest, plans} = passing()
        return {manifest: {...manifest, batchId: 'tampered-batch-id'}, plans}
      },
    },
    {
      name: 'manifest is expired at preflight time',
      code: 'MANIFEST_EXPIRED',
      build: () => {
        const plans = [planFor('batch-plan-1'), planFor('batch-plan-2')]
        const manifest = manifestFor(plans, {createdAt: NOW - 400_000, expiresAt: NOW - 100_000})
        return {manifest, plans}
      },
    },
    {
      name: 'supplied plan count does not match manifest member count',
      code: 'MEMBER_COUNT_MISMATCH',
      build: () => {
        const {manifest, plans} = passing()
        return {manifest, plans: plans.slice(0, 2)}
      },
    },
    {
      name: 'a supplied plan does not parse as a signed record',
      code: 'PLAN_INVALID',
      index: 1,
      build: () => {
        const {manifest, plans} = passing()
        return {manifest, plans: [plans[0], {...plans[1], planDigest: 'not-a-digest'}, plans[2]]}
      },
    },
    {
      name: 'a supplied plan id does not exactly match its manifest entry (untrimmed vs trimmed)',
      code: 'PLAN_ID_MISMATCH',
      index: 0,
      build: () => {
        const plans = [planFor('batch-plan-1'), planFor('batch-plan-2')]
        // The manifest entry seals the plan id verbatim, including surrounding
        // whitespace; the plan itself trims on creation. Preflight must compare
        // exact-byte and refuse, never normalize either side.
        const manifest = createBatchManifest({
          batchId: 'batch-preflight-untrimmed',
          profileName: PROFILE,
          entries: [
            {planId: ` ${plans[0].planId} `, planDigest: plans[0].planDigest},
            {planId: plans[1].planId, planDigest: plans[1].planDigest},
          ],
          provenance: {sourceReceiptId: plans[0].planDigest, sourceManifestHashes: [plans[0].planDigest]},
          createdAt: NOW,
          expiresAt: NOW + 300_000,
        })
        return {manifest, plans}
      },
    },
    {
      name: 'a supplied plan digest does not match its manifest entry',
      code: 'PLAN_DIGEST_MISMATCH',
      index: 2,
      build: () => {
        const {manifest, plans} = passing()
        const swapped = [plans[0], plans[1], planFor('batch-plan-3', {payload: {amount: '999.99'}})]
        return {manifest, plans: swapped}
      },
    },
    {
      name: 'supplied plans are reordered against the sealed member order',
      code: 'PLAN_ID_MISMATCH',
      index: 0,
      build: () => {
        const {manifest, plans} = passing()
        return {manifest, plans: [plans[1], plans[0], plans[2]]}
      },
    },
    {
      name: "a member's profileName does not equal the manifest's sealed profileName",
      code: 'PROFILE_MISMATCH',
      index: 1,
      build: () => {
        const plans = [planFor('batch-plan-1'), planFor('batch-plan-2')]
        const _manifest = manifestFor(plans)
        const otherProfilePlan = createMutationPlan({
          planId: 'batch-plan-2',
          profileName: 'other-profile',
          resource: RESOURCE,
          operation: 'create',
          target: identityFor({profileName: 'other-profile'}),
          payload: PAYLOAD,
          requiredCapabilities: [CAPABILITY],
          requiredScopes: [SCOPE],
          readBack: {expected: PAYLOAD},
          createdAt: NOW,
          expiresAt: NOW + 120_000,
        })
        // Force the manifest entry to still name this plan's real id/digest so
        // the mismatch under test is profileName, not planId/planDigest.
        const retargeted = manifestFor([plans[0], otherProfilePlan])
        return {manifest: retargeted, plans: [plans[0], otherProfilePlan]}
      },
    },
    {
      name: 'members bind more than one tenant fingerprint',
      code: 'TENANT_MISMATCH',
      index: 1,
      build: () => {
        const first = planFor('batch-plan-1')
        const second = planFor('batch-plan-2', {}, identityFor({tenantId: 'a-different-tenant'}))
        const manifest = manifestFor([first, second])
        return {manifest, plans: [first, second]}
      },
    },
    {
      name: 'a member plan is expired at preflight time',
      code: 'PLAN_EXPIRED',
      index: 1,
      build: () => {
        const first = planFor('batch-plan-1')
        const second = planFor('batch-plan-2', {createdAt: NOW - 200_000, expiresAt: NOW - 100_000})
        const manifest = manifestFor([first, second])
        return {manifest, plans: [first, second]}
      },
    },
  ]

  for (const testCase of cases) {
    it(`refuses the whole batch with zero dispatches: ${testCase.name}`, () => {
      const {manifest, plans} = testCase.build()
      const sinks = spySinks()

      const decision = preflightBatch({manifest, plans, now: NOW})

      expect(decision.ok).toBe(false)
      if (decision.ok) throw new Error('expected failure')
      expect(decision.code).toBe(testCase.code)
      expect(decision.index).toBe(testCase.index)
      assertNoSideEffects(sinks)
    })
  }
})
