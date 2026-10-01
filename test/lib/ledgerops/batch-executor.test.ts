import {describe, expect, it, vi} from 'vitest'
import {
  confirmationTokenFor,
  createBatchManifest,
  createMutationPlan,
  createTargetIdentity,
  deriveOperationId,
  executeBatch,
  executeMutation,
  reconstructBatchCoverage,
  type BatchExecutionResult,
  type BatchLink,
  type BatchManifest,
  type BatchReceipt,
  type MutationGuardContext,
  type MutationPlan,
  type MutationTransport,
  type TargetBinding,
  type TargetIdentity,
  type TargetIdentityInput,
  type TransportDispatchRequest,
  type TransportReadBackRequest,
  type WriteAheadIntent,
  type AuditReceipt,
} from '../../../src/lib/ledgerops/index.js'

const NOW = Date.parse('2026-08-25T00:00:00.000Z')
const PROFILE = 'batch-executor-profile'
const RESOURCE = 'synthetic-resource'
const CAPABILITY = 'ledger.synthetic.write'
const EXTRA_CAPABILITY = 'ledger.synthetic.elevated'
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

const IDENTITY = identityFor()

function planFor(planId: string, overrides: Record<string, unknown> = {}): MutationPlan {
  return createMutationPlan({
    planId,
    profileName: PROFILE,
    resource: RESOURCE,
    operation: 'create',
    target: IDENTITY,
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
    batchId: 'batch-executor-1',
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

/**
 * One in-memory journal standing in for the ADR-0009 append-only store: it
 * accepts the same typed methods the file sink exposes, and its `records` are
 * exactly the lines `reconstructBatchCoverage` reads back.
 */
class JournalSink {
  readonly records: unknown[] = []
  failBatchReceipt = false
  failBatchLinkAtIndex: number | undefined

  writeAhead(intent: WriteAheadIntent): void {
    this.records.push(intent)
  }

  write(receipt: AuditReceipt): void {
    this.records.push(receipt)
  }

  writeBatchManifest(manifest: BatchManifest): void {
    this.records.push(manifest)
  }

  writeBatchLink(link: BatchLink): void {
    if (this.failBatchLinkAtIndex === link.index) throw new Error('synthetic link append failure')
    this.records.push(link)
  }

  writeBatchReceipt(receipt: BatchReceipt): void {
    if (this.failBatchReceipt) throw new Error('synthetic batch receipt append failure')
    this.records.push(receipt)
  }

  get links(): readonly BatchLink[] {
    return this.records.filter(isSchema<BatchLink>('ledgerops.batch-link.v1'))
  }

  get batchReceipts(): readonly BatchReceipt[] {
    return this.records.filter(isSchema<BatchReceipt>('ledgerops.batch-receipt.v1'))
  }
}

function isSchema<T>(schemaVersion: string): (value: unknown) => value is T {
  return (value: unknown): value is T =>
    typeof value === 'object' && value !== null && (value as {schemaVersion?: unknown}).schemaVersion === schemaVersion
}

type ReadBackMode = 'found' | 'missing' | 'throw'

interface TransportOptions {
  /** Plan ids whose dispatch throws, standing in for an unknown remote state. */
  readonly throwDispatchFor?: readonly string[]
  readonly readBackFor?: Readonly<Record<string, ReadBackMode>>
}

/**
 * A synthetic adapter with the live adapter's dedup rule (ADR-0014): the
 * operation id derived from the target and the plan digest is burned on the
 * first dispatch, and a second dispatch of the same operation is refused
 * without reaching the "remote" at all.
 */
function transportFor(
  binding: TargetBinding,
  plans: readonly MutationPlan[],
  options: TransportOptions = {},
  claimed: Set<string> = new Set<string>(),
) {
  const byDigest = new Map(plans.map(plan => [plan.planDigest, plan]))
  const created: string[] = []
  const transport = {
    binding,
    claimed,
    created,
    dispatch: vi.fn(async (input: TransportDispatchRequest) => {
      const plan = byDigest.get(input.planDigest)
      const operationId = deriveOperationId({
        tenantFingerprint: input.targetBinding.tenantFingerprint,
        resource: binding.resource,
        operation: input.operation,
        origin: {planDigest: input.planDigest},
      })
      if (claimed.has(operationId)) throw new Error('DUPLICATE_OPERATION')
      claimed.add(operationId)
      if (plan && options.throwDispatchFor?.includes(plan.planId)) {
        throw new Error('synthetic dispatch failure')
      }
      created.push(input.planDigest)
      return {accepted: true}
    }),
    readBack: vi.fn(async (input: TransportReadBackRequest) => {
      const plan = byDigest.get(input.planDigest)
      const mode = (plan && options.readBackFor?.[plan.planId]) ?? 'found'
      if (mode === 'throw') throw new Error('synthetic read-back failure')
      if (mode === 'missing') return {status: 'missing' as const}
      return {status: 'found' as const, records: [PAYLOAD]}
    }),
  }
  return transport as typeof transport & MutationTransport
}

function contextFor(sink: JournalSink): MutationGuardContext {
  return {
    profileName: PROFILE,
    identity: IDENTITY,
    capabilities: [CAPABILITY],
    scopes: [SCOPE],
    receiptSink: sink,
    now: NOW,
  }
}

function outcomesOf(result: BatchExecutionResult): readonly string[] {
  if (!result.ok) throw new Error(`expected an executed batch, got ${result.code}`)
  return result.members.map(member => member.outcome)
}

/** Every executed run must reconstruct identically from what it durably wrote. */
function expectCoverageRoundTrip(result: BatchExecutionResult, sink: JournalSink): void {
  if (!result.ok) throw new Error(`expected an executed batch, got ${result.code}`)
  const coverage = reconstructBatchCoverage({manifest: result.manifest, records: sink.records})
  expect(coverage.ok).toBe(true)
  if (!coverage.ok) return
  expect(coverage.members.map(member => member.state)).toEqual(result.members.map(member => member.outcome))
  expect(coverage.members.map(member => member.receiptId)).toEqual(result.members.map(member => member.receiptId))
  expect(coverage.counts).toEqual(result.counts)
  expect(coverage.runState).toBe(result.runState)
}

describe('executeBatch', () => {
  it('runs every member in sealed order and closes with one batch receipt', async () => {
    const plans = [planFor('batch-plan-1'), planFor('batch-plan-2'), planFor('batch-plan-3')]
    const manifest = manifestFor(plans)
    const sink = new JournalSink()
    const transport = transportFor(plans[0].targetBinding, plans)

    const result = await executeBatch({
      manifest,
      plans,
      confirmation: confirmationTokenFor(manifest.manifestDigest),
      context: contextFor(sink),
      transport,
      sink,
      now: NOW,
    })

    expect(outcomesOf(result)).toEqual(['accepted', 'accepted', 'accepted'])
    if (!result.ok) throw new Error('expected an executed batch')
    expect(result.runState).toBe('CLOSED')
    expect(result.halted).toBe(false)
    expect(result.counts.accepted).toBe(3)
    expect(sink.links.map(link => link.index)).toEqual([0, 1, 2])
    expect(sink.batchReceipts).toHaveLength(1)
    expect(sink.batchReceipts[0].manifestDigest).toBe(manifest.manifestDigest)
    // The closing receipt is appended last, after every member link.
    expect(sink.records.at(-1)).toBe(sink.batchReceipts[0])
    expect(transport.dispatch).toHaveBeenCalledTimes(3)
    expectCoverageRoundTrip(result, sink)
  })

  it('derives each member confirmation from that member plan digest', async () => {
    const plans = [planFor('batch-plan-1'), planFor('batch-plan-2')]
    const manifest = manifestFor(plans)
    const sink = new JournalSink()
    const transport = transportFor(plans[0].targetBinding, plans)
    const seen: string[] = []

    const result = await executeBatch({
      manifest,
      plans,
      confirmation: confirmationTokenFor(manifest.manifestDigest),
      context: contextFor(sink),
      transport,
      sink,
      now: NOW,
      execute: async input => {
        seen.push(input.confirmation)
        return executeMutation(input)
      },
    })

    expect(seen).toEqual([confirmationTokenFor(plans[0].planDigest), confirmationTokenFor(plans[1].planDigest)])
    // The batch confirmation itself is never handed to the kernel.
    expect(seen).not.toContain(confirmationTokenFor(manifest.manifestDigest))
    expect(outcomesOf(result)).toEqual(['accepted', 'accepted'])
  })

  it('refuses a batch confirmation that is not bound to the manifest digest', async () => {
    const plans = [planFor('batch-plan-1')]
    const manifest = manifestFor(plans)
    const sink = new JournalSink()
    const transport = transportFor(plans[0].targetBinding, plans)

    const result = await executeBatch({
      manifest,
      plans,
      confirmation: confirmationTokenFor(plans[0].planDigest),
      context: contextFor(sink),
      transport,
      sink,
      now: NOW,
    })

    expect(result).toMatchObject({ok: false, code: 'BATCH_CONFIRMATION_MISMATCH'})
    expect(transport.dispatch).not.toHaveBeenCalled()
    expect(sink.records).toEqual([])
  })

  it('halts on a pre-dispatch STOP under the default halt-on-stop policy', async () => {
    const plans = [
      planFor('batch-plan-1'),
      planFor('batch-plan-2', {requiredCapabilities: [CAPABILITY, EXTRA_CAPABILITY]}),
      planFor('batch-plan-3'),
    ]
    const manifest = manifestFor(plans)
    const sink = new JournalSink()
    const transport = transportFor(plans[0].targetBinding, plans)

    const result = await executeBatch({
      manifest,
      plans,
      confirmation: confirmationTokenFor(manifest.manifestDigest),
      context: contextFor(sink),
      transport,
      sink,
      now: NOW,
    })

    expect(outcomesOf(result)).toEqual(['accepted', 'stopped', 'not-attempted'])
    if (!result.ok) throw new Error('expected an executed batch')
    expect(result.halted).toBe(true)
    expect(result.haltedAtIndex).toBe(1)
    expect(result.members[2].receiptId).toBeUndefined()
    expect(result.members[2].result).toBeUndefined()
    // A guard refusal, before the transport was ever touched.
    expect(result.members[1].result?.receipt).toMatchObject({
      reasonCode: 'CAPABILITY_REQUIRED',
      dispatchState: 'not-dispatched',
    })
    expect(transport.dispatch).toHaveBeenCalledTimes(1)
    expect(sink.batchReceipts).toHaveLength(1)
    expectCoverageRoundTrip(result, sink)
  })

  it('runs later members after a pre-dispatch STOP under continue-on-stop', async () => {
    const plans = [
      planFor('batch-plan-1'),
      planFor('batch-plan-2', {requiredCapabilities: [CAPABILITY, EXTRA_CAPABILITY]}),
      planFor('batch-plan-3'),
    ]
    const manifest = manifestFor(plans, {haltPolicy: 'continue-on-stop'})
    const sink = new JournalSink()
    const transport = transportFor(plans[0].targetBinding, plans)

    const result = await executeBatch({
      manifest,
      plans,
      confirmation: confirmationTokenFor(manifest.manifestDigest),
      context: contextFor(sink),
      transport,
      sink,
      now: NOW,
    })

    expect(outcomesOf(result)).toEqual(['accepted', 'stopped', 'accepted'])
    if (!result.ok) throw new Error('expected an executed batch')
    expect(result.halted).toBe(false)
    expect(transport.dispatch).toHaveBeenCalledTimes(2)
    expectCoverageRoundTrip(result, sink)
  })

  it('always halts on UNCERTAIN, even under continue-on-stop', async () => {
    const plans = [planFor('batch-plan-1'), planFor('batch-plan-2'), planFor('batch-plan-3')]
    const manifest = manifestFor(plans, {haltPolicy: 'continue-on-stop'})
    const sink = new JournalSink()
    const transport = transportFor(plans[0].targetBinding, plans, {
      throwDispatchFor: ['batch-plan-2'],
    })

    const result = await executeBatch({
      manifest,
      plans,
      confirmation: confirmationTokenFor(manifest.manifestDigest),
      context: contextFor(sink),
      transport,
      sink,
      now: NOW,
    })

    expect(outcomesOf(result)).toEqual(['accepted', 'uncertain', 'not-attempted'])
    if (!result.ok) throw new Error('expected an executed batch')
    expect(result.halted).toBe(true)
    expect(result.haltedAtIndex).toBe(1)
    expect(result.members[1].result?.receipt).toMatchObject({
      outcome: 'UNCERTAIN',
      reasonCode: 'DISPATCH_UNCERTAIN',
    })
    expect(transport.dispatch).toHaveBeenCalledTimes(2)
    expectCoverageRoundTrip(result, sink)
  })

  it('always halts on a dispatched-unverified member, even under continue-on-stop', async () => {
    const plans = [planFor('batch-plan-1'), planFor('batch-plan-2'), planFor('batch-plan-3')]
    const manifest = manifestFor(plans, {haltPolicy: 'continue-on-stop'})
    const sink = new JournalSink()
    const transport = transportFor(plans[0].targetBinding, plans, {
      readBackFor: {'batch-plan-2': 'missing'},
    })

    const result = await executeBatch({
      manifest,
      plans,
      confirmation: confirmationTokenFor(manifest.manifestDigest),
      context: contextFor(sink),
      transport,
      sink,
      now: NOW,
    })

    expect(outcomesOf(result)).toEqual(['accepted', 'dispatched-unverified', 'not-attempted'])
    if (!result.ok) throw new Error('expected an executed batch')
    expect(result.halted).toBe(true)
    expect(result.haltedAtIndex).toBe(1)
    // The mutation was accepted; the read-back could not vouch for it.
    expect(result.members[1].result?.receipt).toMatchObject({
      outcome: 'MISSING',
      dispatchState: 'accepted',
    })
    expectCoverageRoundTrip(result, sink)
  })

  it('dispatches nothing and writes nothing when preflight refuses the set', async () => {
    const plans = [planFor('batch-plan-1'), planFor('batch-plan-2')]
    const manifest = manifestFor(plans)
    const sink = new JournalSink()
    const transport = transportFor(plans[0].targetBinding, plans)

    const result = await executeBatch({
      manifest,
      plans: [plans[1], plans[0]],
      confirmation: confirmationTokenFor(manifest.manifestDigest),
      context: contextFor(sink),
      transport,
      sink,
      now: NOW,
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refused batch')
    expect(result.code).toBe('PREFLIGHT_FAILED')
    expect(result.preflight).toMatchObject({ok: false, code: 'PLAN_ID_MISMATCH', index: 0})
    expect(transport.dispatch).not.toHaveBeenCalled()
    expect(transport.readBack).not.toHaveBeenCalled()
    expect(sink.records).toEqual([])
  })

  it('reports UNCERTAIN when the closing batch receipt cannot be appended', async () => {
    const plans = [planFor('batch-plan-1'), planFor('batch-plan-2')]
    const manifest = manifestFor(plans)
    const sink = new JournalSink()
    sink.failBatchReceipt = true
    const transport = transportFor(plans[0].targetBinding, plans)

    const result = await executeBatch({
      manifest,
      plans,
      confirmation: confirmationTokenFor(manifest.manifestDigest),
      context: contextFor(sink),
      transport,
      sink,
      now: NOW,
    })

    expect(outcomesOf(result)).toEqual(['accepted', 'accepted'])
    if (!result.ok) throw new Error('expected an executed batch')
    expect(result.runState).toBe('UNCERTAIN')
    expect(result.closingReceipt).toBeUndefined()
    // Durable evidence: every member link landed; only the closing receipt did not.
    expect(sink.links.map(link => link.outcome)).toEqual(['accepted', 'accepted'])
    expect(sink.batchReceipts).toEqual([])
    expectCoverageRoundTrip(result, sink)
  })

  it('halts UNCERTAIN when a member link cannot be appended', async () => {
    const plans = [planFor('batch-plan-1'), planFor('batch-plan-2'), planFor('batch-plan-3')]
    const manifest = manifestFor(plans)
    const sink = new JournalSink()
    sink.failBatchLinkAtIndex = 1
    const transport = transportFor(plans[0].targetBinding, plans)

    const result = await executeBatch({
      manifest,
      plans,
      confirmation: confirmationTokenFor(manifest.manifestDigest),
      context: contextFor(sink),
      transport,
      sink,
      now: NOW,
    })

    if (!result.ok) throw new Error('expected an executed batch')
    expect(result.runState).toBe('UNCERTAIN')
    expect(result.halted).toBe(true)
    expect(result.members[2].outcome).toBe('not-attempted')
    expect(transport.dispatch).toHaveBeenCalledTimes(2)
    // A store that proved it cannot persist never gets to attest closure.
    expect(sink.batchReceipts).toEqual([])
    expectCoverageRoundTrip(result, sink)
  })

  it('is refused by transport dedup when a second batch re-enumerates an accepted member', async () => {
    const plans = [planFor('batch-plan-1'), planFor('batch-plan-2')]
    const first = manifestFor(plans)
    const claimed = new Set<string>()
    const firstSink = new JournalSink()
    const transport = transportFor(plans[0].targetBinding, plans, {}, claimed)

    const firstRun = await executeBatch({
      manifest: first,
      plans,
      confirmation: confirmationTokenFor(first.manifestDigest),
      context: contextFor(firstSink),
      transport,
      sink: firstSink,
      now: NOW,
    })
    expect(outcomesOf(firstRun)).toEqual(['accepted', 'accepted'])
    expect(transport.created).toHaveLength(2)

    // A second, freshly confirmed manifest that wrongly re-enumerates member 1.
    const second = manifestFor(plans, {batchId: 'batch-executor-2'})
    const secondSink = new JournalSink()
    const secondRun = await executeBatch({
      manifest: second,
      plans,
      confirmation: confirmationTokenFor(second.manifestDigest),
      context: contextFor(secondSink),
      transport,
      sink: secondSink,
      now: NOW,
    })

    expect(outcomesOf(secondRun)).toEqual(['uncertain', 'not-attempted'])
    if (!secondRun.ok) throw new Error('expected an executed batch')
    expect(secondRun.members[0].result?.receipt).toMatchObject({
      outcome: 'UNCERTAIN',
      reasonCode: 'DISPATCH_UNCERTAIN',
      dispatchState: 'attempted',
    })
    // Refused by the adapter, not re-sent: no second mutation exists.
    expect(transport.created).toHaveLength(2)
    expect(transport.claimed.size).toBe(2)
    expectCoverageRoundTrip(secondRun, secondSink)
  })
})
