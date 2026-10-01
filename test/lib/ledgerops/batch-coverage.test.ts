import {describe, expect, it} from 'vitest'
import {
  buildResumeManifest,
  createAuditReceipt,
  createBatchLink,
  createBatchManifest,
  createBatchReceipt,
  createMutationPlan,
  createTargetIdentity,
  createWriteAheadIntent,
  parseBatchManifest,
  reconstructBatchCoverage,
  type AuditReceipt,
  type BatchCoverageSuccess,
  type BatchItemOutcome,
  type BatchManifest,
  type BatchProvenance,
  type MutationPlan,
  type TargetIdentity,
  type TargetIdentityInput,
} from '../../../src/lib/ledgerops/index.js'

/**
 * ADR-0011 coverage reconstruction: a batch's coverage is rebuilt from what is
 * durable — write-ahead intents, per-item receipts, and batch-link records —
 * before any resume manifest is built. These cases are the crash-injection
 * matrix issue #57 requires: an incomplete tail, duplicate links, conflicting
 * outcomes for one index, and a torn tail with no closing batch receipt.
 */

const NOW = Date.parse('2026-08-25T00:00:00.000Z')
const PROFILE = 'batch-coverage-profile'
const RESOURCE = 'synthetic-resource'
const CAPABILITY = 'ledger.synthetic.write'
const SCOPE = 'ledger.synthetic.scope'
const PAYLOAD = {amount: '10.01'}
const CONFIRMATION_DIGEST = 'c'.repeat(64)

function identityFor(overrides: Partial<TargetIdentityInput> = {}): TargetIdentity {
  return createTargetIdentity({
    profileName: PROFILE,
    tenantId: 'batch-coverage-tenant',
    resource: RESOURCE,
    isDemoCompany: true,
    observedAt: NOW,
    freshUntil: NOW + 60_000,
    capabilities: [CAPABILITY],
    scopes: [SCOPE],
    ...overrides,
  })
}

function planFor(planId: string, overrides: Record<string, unknown> = {}): MutationPlan {
  return createMutationPlan({
    planId,
    profileName: PROFILE,
    resource: RESOURCE,
    operation: 'create',
    target: identityFor(),
    payload: PAYLOAD,
    requiredCapabilities: [CAPABILITY],
    requiredScopes: [SCOPE],
    readBack: {expected: PAYLOAD},
    createdAt: NOW,
    expiresAt: NOW + 120_000,
    ...overrides,
  })
}

function provenanceFor(plans: readonly MutationPlan[]): BatchProvenance {
  return {sourceReceiptId: plans[0].planDigest, sourceManifestHashes: [plans[0].planDigest]}
}

function manifestFor(plans: readonly MutationPlan[], overrides: Record<string, unknown> = {}): BatchManifest {
  return createBatchManifest({
    batchId: 'batch-coverage-1',
    profileName: PROFILE,
    entries: plans.map(plan => ({planId: plan.planId, planDigest: plan.planDigest})),
    provenance: provenanceFor(plans),
    createdAt: NOW,
    expiresAt: NOW + 300_000,
    ...overrides,
  })
}

function intentFor(plan: MutationPlan): unknown {
  return createWriteAheadIntent({
    recordedAt: NOW + 1,
    profileName: PROFILE,
    resource: RESOURCE,
    operation: 'create',
    target: plan.targetBinding,
    planDigest: plan.planDigest,
    confirmationDigest: CONFIRMATION_DIGEST,
  })
}

/** A VERIFIED receipt by default; overrides drive the other reconstructed states. */
function receiptFor(plan: MutationPlan, overrides: Record<string, unknown> = {}): AuditReceipt {
  return createAuditReceipt({
    recordedAt: NOW + 2,
    profileName: PROFILE,
    resource: RESOURCE,
    operation: 'create',
    target: plan.targetBinding,
    planDigest: plan.planDigest,
    confirmationDigest: CONFIRMATION_DIGEST,
    requiredCapabilityFingerprint: plan.capabilitiesFingerprint,
    requiredScopeFingerprint: plan.scopesFingerprint,
    dispatchState: 'accepted',
    readBackClassification: 'verified',
    outcome: 'VERIFIED',
    terminal: 'CONTINUE',
    ...overrides,
  })
}

function linkFor(
  manifest: BatchManifest,
  plan: MutationPlan,
  index: number,
  outcome: BatchItemOutcome,
  receiptId?: string,
): unknown {
  return createBatchLink({
    batchId: manifest.batchId,
    manifestDigest: manifest.manifestDigest,
    index,
    planId: plan.planId,
    planDigest: plan.planDigest,
    outcome,
    receiptId,
  })
}

interface Halted {
  readonly manifest: BatchManifest
  readonly plans: readonly MutationPlan[]
  readonly records: readonly unknown[]
}

/**
 * A run that accepted members 1..k and then died: no records at all exist for
 * the tail, and no closing batch receipt was ever appended.
 */
function haltedAfter(k: number, memberCount = 5): Halted {
  const plans = Array.from({length: memberCount}, (_unused, index) => planFor(`batch-plan-${index + 1}`))
  const manifest = manifestFor(plans)
  const records: unknown[] = []
  for (let index = 0; index < k; index += 1) {
    const plan = plans[index]
    const receipt = receiptFor(plan)
    records.push(intentFor(plan), receipt, linkFor(manifest, plan, index, 'accepted', receipt.receiptId))
  }
  return {manifest, plans, records}
}

function expectSuccess(decision: ReturnType<typeof reconstructBatchCoverage>): BatchCoverageSuccess {
  if (!decision.ok) throw new Error(`expected coverage success, got ${decision.code}`)
  return decision
}

describe('reconstructBatchCoverage', () => {
  it('reconstructs an incomplete tail: accepted head, not-attempted remainder', () => {
    const {manifest, plans, records} = haltedAfter(2)

    const coverage = expectSuccess(reconstructBatchCoverage({manifest, records}))

    expect(coverage.members.map(member => member.state)).toEqual([
      'accepted',
      'accepted',
      'not-attempted',
      'not-attempted',
      'not-attempted',
    ])
    expect(coverage.counts).toEqual({
      accepted: 2,
      stopped: 0,
      dispatchedUnverified: 0,
      uncertain: 0,
      notAttempted: 3,
    })
    expect(coverage.remainder.map(member => member.index)).toEqual([2, 3, 4])
    expect(coverage.remainder.map(member => member.planId)).toEqual(plans.slice(2).map(plan => plan.planId))
    expect(coverage.unresolved).toEqual([])
  })

  it('a torn tail (no closing batch receipt) reconstructs but stays UNCERTAIN', () => {
    const {manifest, records} = haltedAfter(2)

    const coverage = expectSuccess(reconstructBatchCoverage({manifest, records}))

    expect(coverage.runState).toBe('UNCERTAIN')
    expect(coverage.closingReceipt).toBeUndefined()
  })

  it('a durable closing batch receipt that agrees closes the run', () => {
    const {manifest, plans, records} = haltedAfter(5)
    const closing = createBatchReceipt({
      batchId: manifest.batchId,
      manifestDigest: manifest.manifestDigest,
      provenance: provenanceFor(plans),
      items: plans.map(plan => ({
        planId: plan.planId,
        outcome: 'accepted' as const,
        receiptId: receiptFor(plan).receiptId,
      })),
      recordedAt: NOW + 10,
    })

    const coverage = expectSuccess(reconstructBatchCoverage({manifest, records: [...records, closing]}))

    expect(coverage.runState).toBe('CLOSED')
    expect(coverage.closingReceipt?.batchReceiptDigest).toBe(closing.batchReceiptDigest)
    expect(coverage.remainder).toEqual([])
  })

  it('a closing batch receipt that disagrees with the durable trace fails closed', () => {
    const {manifest, plans, records} = haltedAfter(2)
    const lying = createBatchReceipt({
      batchId: manifest.batchId,
      manifestDigest: manifest.manifestDigest,
      provenance: provenanceFor(plans),
      // Claims full coverage the journal does not support.
      items: plans.map(plan => ({planId: plan.planId, outcome: 'accepted' as const})),
      recordedAt: NOW + 10,
    })

    const decision = reconstructBatchCoverage({manifest, records: [...records, lying]})

    expect(decision.ok).toBe(false)
    if (decision.ok) throw new Error('expected failure')
    expect(decision.code).toBe('BATCH_RECEIPT_CONFLICT')
  })

  it('derives a member state from intent and receipt when the batch link never landed', () => {
    const plans = [planFor('batch-plan-1'), planFor('batch-plan-2')]
    const manifest = manifestFor(plans)
    const receipt = receiptFor(plans[0])

    const coverage = expectSuccess(
      reconstructBatchCoverage({
        manifest,
        records: [intentFor(plans[0]), receipt],
      }),
    )

    expect(coverage.members[0].state).toBe('accepted')
    expect(coverage.members[0].linked).toBe(false)
    expect(coverage.members[0].receiptId).toBe(receipt.receiptId)
    expect(coverage.members[1].state).toBe('not-attempted')
  })

  it('an intent with no receipt and no link is an interrupted dispatch, never a success', () => {
    const plans = [planFor('batch-plan-1'), planFor('batch-plan-2')]
    const manifest = manifestFor(plans)

    const coverage = expectSuccess(reconstructBatchCoverage({manifest, records: [intentFor(plans[0])]}))

    expect(coverage.members[0].state).toBe('uncertain')
    expect(coverage.members[0].intentRecorded).toBe(true)
    expect(coverage.unresolved.map(member => member.index)).toEqual([0])
    expect(coverage.runState).toBe('UNCERTAIN')
  })

  it('maps a post-dispatch read-back failure to dispatched-unverified', () => {
    const plans = [planFor('batch-plan-1')]
    const manifest = manifestFor(plans)
    const receipt = receiptFor(plans[0], {
      readBackClassification: 'mismatch',
      outcome: 'MISMATCH',
      terminal: 'STOP',
    })

    const coverage = expectSuccess(
      reconstructBatchCoverage({
        manifest,
        records: [intentFor(plans[0]), receipt],
      }),
    )

    expect(coverage.members[0].state).toBe('dispatched-unverified')
    expect(coverage.unresolved.map(member => member.index)).toEqual([0])
  })

  it('maps a pre-dispatch STOP receipt to stopped', () => {
    const plans = [planFor('batch-plan-1')]
    const manifest = manifestFor(plans)
    const receipt = receiptFor(plans[0], {
      dispatchState: 'not-dispatched',
      readBackClassification: 'not-run',
      outcome: 'STOP',
      terminal: 'STOP',
      reasonCode: 'PLAN_EXPIRED',
    })

    const coverage = expectSuccess(
      reconstructBatchCoverage({
        manifest,
        records: [intentFor(plans[0]), receipt],
      }),
    )

    expect(coverage.members[0].state).toBe('stopped')
    // A pre-dispatch STOP dispatched nothing, but ADR-0011 resumes only the
    // not-attempted remainder — a stopped member is replanned, never resumed.
    expect(coverage.remainder).toEqual([])
    expect(coverage.unresolved).toEqual([])
  })

  it('collapses duplicate links that record the same outcome for one index', () => {
    const {manifest, plans, records} = haltedAfter(2)
    const receipt = records.find(
      (record): record is AuditReceipt =>
        (record as AuditReceipt).schemaVersion === 'ledgerops.audit.v1' &&
        (record as AuditReceipt).planDigest === plans[0].planDigest,
    ) as AuditReceipt
    const duplicate = linkFor(manifest, plans[0], 0, 'accepted', receipt.receiptId)

    const coverage = expectSuccess(
      reconstructBatchCoverage({
        manifest,
        records: [...records, duplicate],
      }),
    )

    expect(coverage.members[0].state).toBe('accepted')
    expect(coverage.counts.accepted).toBe(2)
  })

  it('fails closed when duplicate links disagree on the outcome for one index', () => {
    const {manifest, plans, records} = haltedAfter(2)
    const conflicting = linkFor(manifest, plans[0], 0, 'uncertain')

    const decision = reconstructBatchCoverage({manifest, records: [...records, conflicting]})

    expect(decision.ok).toBe(false)
    if (decision.ok) throw new Error('expected failure')
    expect(decision.code).toBe('LINK_OUTCOME_CONFLICT')
    expect(decision.index).toBe(0)
  })

  it('fails closed when duplicate links disagree on the receipt they link', () => {
    const {manifest, plans, records} = haltedAfter(2)
    const otherReceipt = receiptFor(plans[0], {recordedAt: NOW + 99})
    const conflicting = linkFor(manifest, plans[0], 0, 'accepted', otherReceipt.receiptId)

    const decision = reconstructBatchCoverage({manifest, records: [...records, conflicting]})

    expect(decision.ok).toBe(false)
    if (decision.ok) throw new Error('expected failure')
    expect(decision.code).toBe('LINK_OUTCOME_CONFLICT')
    expect(decision.index).toBe(0)
  })

  it('fails closed when a link and its receipt disagree on the outcome', () => {
    const plans = [planFor('batch-plan-1')]
    const manifest = manifestFor(plans)
    const receipt = receiptFor(plans[0], {
      readBackClassification: 'missing',
      outcome: 'MISSING',
      terminal: 'STOP',
    })
    const link = linkFor(manifest, plans[0], 0, 'accepted', receipt.receiptId)

    const decision = reconstructBatchCoverage({
      manifest,
      records: [intentFor(plans[0]), receipt, link],
    })

    expect(decision.ok).toBe(false)
    if (decision.ok) throw new Error('expected failure')
    expect(decision.code).toBe('LINK_OUTCOME_CONFLICT')
    expect(decision.index).toBe(0)
  })

  it('fails closed when a link names a receipt other than the durable one', () => {
    const plans = [planFor('batch-plan-1')]
    const manifest = manifestFor(plans)
    const receipt = receiptFor(plans[0])
    const link = linkFor(manifest, plans[0], 0, 'accepted', 'd'.repeat(64))

    const decision = reconstructBatchCoverage({
      manifest,
      records: [intentFor(plans[0]), receipt, link],
    })

    expect(decision.ok).toBe(false)
    if (decision.ok) throw new Error('expected failure')
    expect(decision.code).toBe('LINK_RECEIPT_CONFLICT')
    expect(decision.index).toBe(0)
  })

  it('fails closed when two receipts exist for one member plan digest', () => {
    const plans = [planFor('batch-plan-1')]
    const manifest = manifestFor(plans)

    const decision = reconstructBatchCoverage({
      manifest,
      records: [intentFor(plans[0]), receiptFor(plans[0]), receiptFor(plans[0], {recordedAt: NOW + 7})],
    })

    expect(decision.ok).toBe(false)
    if (decision.ok) throw new Error('expected failure')
    expect(decision.code).toBe('RECEIPT_DUPLICATE_CONFLICT')
    expect(decision.index).toBe(0)
  })

  it('fails closed when a link names a member the manifest seals differently', () => {
    const plans = [planFor('batch-plan-1'), planFor('batch-plan-2')]
    const manifest = manifestFor(plans)
    // Index 0 carries member 2's identity: the sealed order is authority.
    const link = linkFor(manifest, plans[1], 0, 'accepted')

    const decision = reconstructBatchCoverage({manifest, records: [link]})

    expect(decision.ok).toBe(false)
    if (decision.ok) throw new Error('expected failure')
    expect(decision.code).toBe('LINK_MEMBER_MISMATCH')
    expect(decision.index).toBe(0)
  })

  it('fails closed when a link is scoped to this manifest but its index is out of the sealed range', () => {
    const plans = [planFor('batch-plan-1'), planFor('batch-plan-2')]
    const manifest = manifestFor(plans)
    // Index 40 against a 2-member manifest: self-contradictory, must not be
    // silently dropped by buildMembers' 0..entries.length loop.
    const link = createBatchLink({
      batchId: manifest.batchId,
      manifestDigest: manifest.manifestDigest,
      index: 40,
      planId: plans[0].planId,
      planDigest: plans[0].planDigest,
      outcome: 'accepted',
    })

    const decision = reconstructBatchCoverage({manifest, records: [link]})

    expect(decision.ok).toBe(false)
    if (decision.ok) throw new Error('expected failure')
    expect(decision.code).toBe('LINK_MEMBER_MISMATCH')
    expect(decision.index).toBe(40)
  })

  it('fails closed when a link binds this manifest digest under another batch id', () => {
    const plans = [planFor('batch-plan-1')]
    const manifest = manifestFor(plans)
    const link = createBatchLink({
      batchId: 'some-other-batch',
      manifestDigest: manifest.manifestDigest,
      index: 0,
      planId: plans[0].planId,
      planDigest: plans[0].planDigest,
      outcome: 'accepted',
    })

    const decision = reconstructBatchCoverage({manifest, records: [link]})

    expect(decision.ok).toBe(false)
    if (decision.ok) throw new Error('expected failure')
    expect(decision.code).toBe('LINK_BATCH_ID_MISMATCH')
  })

  it('ignores records belonging to another batch and to non-member plans', () => {
    const plans = [planFor('batch-plan-1'), planFor('batch-plan-2')]
    const manifest = manifestFor(plans)
    const foreignPlans = [planFor('foreign-plan-1')]
    const foreignManifest = manifestFor(foreignPlans, {batchId: 'foreign-batch'})
    const foreignReceipt = receiptFor(foreignPlans[0])

    const coverage = expectSuccess(
      reconstructBatchCoverage({
        manifest,
        records: [
          intentFor(plans[0]),
          receiptFor(plans[0]),
          linkFor(manifest, plans[0], 0, 'accepted', receiptFor(plans[0]).receiptId),
          intentFor(foreignPlans[0]),
          foreignReceipt,
          linkFor(foreignManifest, foreignPlans[0], 0, 'accepted', foreignReceipt.receiptId),
        ],
      }),
    )

    expect(coverage.members.map(member => member.state)).toEqual(['accepted', 'not-attempted'])
  })

  it('fails closed on a manifest that does not parse as a signed record', () => {
    const decision = reconstructBatchCoverage({manifest: {not: 'a manifest'}, records: []})

    expect(decision.ok).toBe(false)
    if (decision.ok) throw new Error('expected failure')
    expect(decision.code).toBe('MANIFEST_INVALID')
  })

  it('fails closed on a tampered journal record rather than skipping it', () => {
    const plans = [planFor('batch-plan-1')]
    const manifest = manifestFor(plans)
    const receipt = receiptFor(plans[0])

    const decision = reconstructBatchCoverage({
      manifest,
      records: [{...receipt, recordedAt: NOW + 5000}],
    })

    expect(decision.ok).toBe(false)
    if (decision.ok) throw new Error('expected failure')
    expect(decision.code).toBe('JOURNAL_RECORD_INVALID')
    expect(decision.recordIndex).toBe(0)
  })

  it('fails closed on an unregistered journal record rather than coercing it to success', () => {
    const plans = [planFor('batch-plan-1')]
    const manifest = manifestFor(plans)

    const decision = reconstructBatchCoverage({
      manifest,
      records: [{schemaVersion: 'ledgerops.something-new.v1', payload: 'x'}],
    })

    expect(decision.ok).toBe(false)
    if (decision.ok) throw new Error('expected failure')
    expect(decision.code).toBe('JOURNAL_RECORD_UNRECOGNIZED')
    expect(decision.recordIndex).toBe(0)
  })

  it('fails closed when the records input is not an array', () => {
    const plans = [planFor('batch-plan-1')]
    const manifest = manifestFor(plans)

    const decision = reconstructBatchCoverage({manifest, records: undefined as never})

    expect(decision.ok).toBe(false)
    if (decision.ok) throw new Error('expected failure')
    expect(decision.code).toBe('JOURNAL_INPUT_INVALID')
  })

  it('acts only on its own parsed manifest snapshot', () => {
    const {manifest, records} = haltedAfter(1, 2)

    const coverage = expectSuccess(reconstructBatchCoverage({manifest, records}))

    expect(coverage.manifest).toEqual(parseBatchManifest(manifest))
    expect(coverage.manifest).not.toBe(manifest)
    expect(Object.isFrozen(coverage.members)).toBe(true)
  })

  it('deep-freezes each reconstructed member, not just the array', () => {
    const {manifest, records} = haltedAfter(1, 2)

    const coverage = expectSuccess(reconstructBatchCoverage({manifest, records}))

    for (const member of coverage.members) {
      expect(Object.isFrozen(member)).toBe(true)
    }
  })

  it('fails closed when the closing batch receipt names a different provenance than the manifest', () => {
    const {manifest, plans, records} = haltedAfter(5)
    const foreignProvenance = {
      sourceReceiptId: 'f'.repeat(64),
      sourceManifestHashes: ['f'.repeat(64)],
    }
    const closing = createBatchReceipt({
      batchId: manifest.batchId,
      manifestDigest: manifest.manifestDigest,
      provenance: foreignProvenance,
      items: plans.map(plan => ({
        planId: plan.planId,
        outcome: 'accepted' as const,
        receiptId: receiptFor(plan).receiptId,
      })),
      recordedAt: NOW + 10,
    })

    const decision = reconstructBatchCoverage({manifest, records: [...records, closing]})

    expect(decision.ok).toBe(false)
    if (decision.ok) throw new Error('expected failure')
    expect(decision.code).toBe('BATCH_RECEIPT_CONFLICT')
  })
})

describe('buildResumeManifest', () => {
  it('signs a new manifest over the remainder only, never re-enumerating accepted members', () => {
    const {manifest, plans, records} = haltedAfter(2)
    const coverage = expectSuccess(reconstructBatchCoverage({manifest, records}))

    const decision = buildResumeManifest({
      coverage,
      batchId: 'batch-coverage-1-resume',
      createdAt: NOW + 1000,
      expiresAt: NOW + 301_000,
    })

    expect(decision.ok).toBe(true)
    if (!decision.ok) throw new Error('expected success')
    const resume = decision.manifest
    expect(resume.entries).toEqual(
      plans.slice(2).map(plan => ({
        planId: plan.planId,
        planDigest: plan.planDigest,
      })),
    )
    expect(resume.memberCount).toBe(3)
    expect(resume.batchId).toBe('batch-coverage-1-resume')
    expect(resume.profileName).toBe(manifest.profileName)
    expect(resume.haltPolicy).toBe(manifest.haltPolicy)
    expect(resume.provenance).toEqual(manifest.provenance)
    // A new signed record: a fresh confirmation is required, and the accepted
    // members are absent from the sealed enumeration.
    expect(resume.manifestDigest).not.toBe(manifest.manifestDigest)
    expect(parseBatchManifest(resume)).toEqual(resume)
    const resumedIds = resume.entries.map(entry => entry.planId)
    expect(resumedIds).not.toContain(plans[0].planId)
    expect(resumedIds).not.toContain(plans[1].planId)
  })

  it('refuses to reuse the closed batch id', () => {
    const {manifest, records} = haltedAfter(2)
    const coverage = expectSuccess(reconstructBatchCoverage({manifest, records}))

    const decision = buildResumeManifest({coverage, batchId: manifest.batchId, createdAt: NOW + 1000})

    expect(decision.ok).toBe(false)
    if (decision.ok) throw new Error('expected failure')
    expect(decision.code).toBe('RESUME_BATCH_ID_REUSED')
  })

  it('refuses to resume while a member is dispatched-unverified or uncertain', () => {
    const plans = [planFor('batch-plan-1'), planFor('batch-plan-2'), planFor('batch-plan-3')]
    const manifest = manifestFor(plans)
    const coverage = expectSuccess(
      reconstructBatchCoverage({
        manifest,
        // Member 2 has a durable intent and nothing else: a mutation may exist.
        records: [intentFor(plans[1])],
      }),
    )

    const decision = buildResumeManifest({coverage, batchId: 'batch-coverage-1-resume', createdAt: NOW + 1000})

    expect(decision.ok).toBe(false)
    if (decision.ok) throw new Error('expected failure')
    expect(decision.code).toBe('RESUME_UNRESOLVED_MEMBERS')
    expect(decision.indexes).toEqual([1])
  })

  it('refuses to resume a fully covered batch', () => {
    const {manifest, records} = haltedAfter(5)
    const coverage = expectSuccess(reconstructBatchCoverage({manifest, records}))

    const decision = buildResumeManifest({coverage, batchId: 'batch-coverage-1-resume', createdAt: NOW + 1000})

    expect(decision.ok).toBe(false)
    if (decision.ok) throw new Error('expected failure')
    expect(decision.code).toBe('RESUME_REMAINDER_EMPTY')
  })

  it('re-derives the remainder from coverage.members rather than trusting a tampered coverage.remainder', () => {
    const {manifest, records} = haltedAfter(2)
    const coverage = expectSuccess(reconstructBatchCoverage({manifest, records}))
    // A caller-supplied coverage object that lies about the remainder: the
    // members are still truthful (3 not-attempted), only the cached field lies.
    const tampered: BatchCoverageSuccess = {...coverage, remainder: []}

    const decision = buildResumeManifest({
      coverage: tampered,
      batchId: 'batch-coverage-1-resume',
      createdAt: NOW + 1000,
      expiresAt: NOW + 301_000,
    })

    expect(decision.ok).toBe(true)
    if (!decision.ok) throw new Error('expected success')
    expect(decision.manifest.memberCount).toBe(3)
  })

  it('re-derives unresolved members from coverage.members rather than trusting a tampered coverage.unresolved', () => {
    const plans = [planFor('batch-plan-1'), planFor('batch-plan-2'), planFor('batch-plan-3')]
    const manifest = manifestFor(plans)
    const coverage = expectSuccess(
      reconstructBatchCoverage({
        manifest,
        // Member 2 has a durable intent and nothing else: a mutation may exist.
        records: [intentFor(plans[1])],
      }),
    )
    // A caller-supplied coverage object that lies: claims nothing is unresolved.
    const tampered: BatchCoverageSuccess = {...coverage, unresolved: []}

    const decision = buildResumeManifest({
      coverage: tampered,
      batchId: 'batch-coverage-1-resume',
      createdAt: NOW + 1000,
    })

    expect(decision.ok).toBe(false)
    if (decision.ok) throw new Error('expected failure')
    expect(decision.code).toBe('RESUME_UNRESOLVED_MEMBERS')
    expect(decision.indexes).toEqual([1])
  })

  it('produces a resume manifest that preflights against the untouched member plans', async () => {
    const {manifest, plans, records} = haltedAfter(2)
    const coverage = expectSuccess(reconstructBatchCoverage({manifest, records}))
    const decision = buildResumeManifest({
      coverage,
      batchId: 'batch-coverage-1-resume',
      createdAt: NOW + 1000,
      expiresAt: NOW + 301_000,
    })
    if (!decision.ok) throw new Error('expected success')

    const {preflightBatch} = await import('../../../src/lib/ledgerops/index.js')
    const preflight = preflightBatch({
      manifest: decision.manifest,
      plans: plans.slice(2),
      now: NOW + 1000,
    })

    expect(preflight.ok).toBe(true)
  })
})
