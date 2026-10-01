import {createBatchLink} from './batch-link.js'
import {preflightBatch} from './batch-preflight.js'
import {createBatchReceipt} from './batch-receipt.js'
import type {Digest} from './canonical.js'
import {confirmationTokenFor} from './confirmation.js'
import {executeMutation} from './executor.js'
import type {
  BatchItemOutcome,
  BatchManifest,
  BatchPreflightFailure,
  BatchReceipt,
  BatchReceiptCounts,
  BatchReceiptItem,
  BatchRecordSink,
  MutationExecutionInput,
  MutationExecutionResult,
  MutationGuardContext,
  MutationPlan,
  MutationRequest,
  MutationTransport,
} from './types.js'

/**
 * ADR-0011: the one place multiplicity executes. Everything below the manifest
 * layer stays strictly single-resource — this module preflights the whole
 * member set, derives one per-member confirmation from the sealed batch
 * confirmation, and then runs the UNCHANGED single-plan `executeMutation` once
 * per member. The kernel never learns that a batch exists.
 *
 * Fail-closed throughout, and there is no rollback anywhere:
 *
 * - any preflight failure refuses the whole batch before anything dispatches;
 * - a batch confirmation not bound to `manifestDigest` refuses it likewise;
 * - VERIFIED proceeds; a pre-dispatch STOP follows the manifest's sealed
 *   `haltPolicy`; UNCERTAIN and dispatched-unverified always halt regardless of
 *   policy; every member after a halt is recorded `not-attempted`;
 * - a `ledgerops.batch-link.v1` record is appended per member as the run goes,
 *   then exactly one closing `ledgerops.batch-receipt.v1`. If any durable
 *   append fails, the run state is UNCERTAIN and nothing further is appended —
 *   an unreliable store never gets to attest closure.
 *
 * Re-dispatch protection is not this module's job: the transport's own
 * digest/operation-identity dedup (ADR-0014) refuses a second dispatch of an
 * already-accepted operation, and `executeMutation` maps that refusal to
 * UNCERTAIN, which halts the batch here.
 */

export const BATCH_EXECUTION_FAILURE_CODES = [
  /** The supplied input is not the shape this executor accepts. */
  'INPUT_INVALID',
  /** The record sink does not expose the ADR-0011 batch append methods. */
  'BATCH_SINK_REQUIRED',
  /** ADR-0011 preflight refused the member set; nothing was dispatched. */
  'PREFLIGHT_FAILED',
  /** The confirmation is not bound to this manifest's sealed digest. */
  'BATCH_CONFIRMATION_MISMATCH',
] as const

export type BatchExecutionFailureCode = (typeof BATCH_EXECUTION_FAILURE_CODES)[number]

/** One member as this run left it. `not-attempted` never reached the kernel. */
export interface BatchExecutionMember {
  /** Zero-based index into the sealed `manifest.entries`. */
  readonly index: number
  readonly planId: string
  readonly planDigest: Digest
  readonly outcome: BatchItemOutcome
  /** Present only when the per-item receipt was durably written. */
  readonly receiptId?: Digest
  /** The kernel's own result, absent for a member that was never attempted. */
  readonly result?: MutationExecutionResult
}

export interface BatchExecutionSuccess {
  readonly ok: true
  /** The parsed manifest snapshot; callers act on this, never on their own object. */
  readonly manifest: BatchManifest
  /** One entry per sealed member, in manifest order. */
  readonly members: readonly BatchExecutionMember[]
  readonly counts: BatchReceiptCounts
  /** `CLOSED` only when the closing batch receipt is durable. */
  readonly runState: 'CLOSED' | 'UNCERTAIN'
  readonly closingReceipt?: BatchReceipt
  readonly halted: boolean
  /** The member index that halted the run. */
  readonly haltedAtIndex?: number
}

export interface BatchExecutionFailure {
  readonly ok: false
  readonly code: BatchExecutionFailureCode
  /** The preflight decision behind a `PREFLIGHT_FAILED` refusal. */
  readonly preflight?: BatchPreflightFailure
}

export type BatchExecutionResult = BatchExecutionSuccess | BatchExecutionFailure

/** Injected so tests drive the executor with synthetic, offline fakes. */
export type ExecuteMutationFn = (input: MutationExecutionInput) => Promise<MutationExecutionResult>

export interface BatchExecutionInput {
  readonly manifest: unknown
  /** Raw plan records, aligned to `manifest.entries` by index. */
  readonly plans: readonly unknown[]
  /** The batch confirmation, bound to `manifestDigest`. */
  readonly confirmation: string
  readonly context: MutationGuardContext
  readonly transport: MutationTransport
  /** The ADR-0009 store the batch records append through. */
  readonly sink: BatchRecordSink
  readonly execute?: ExecuteMutationFn
  readonly now?: number
}

export async function executeBatch(input: BatchExecutionInput): Promise<BatchExecutionResult> {
  if (!isExecutionRequest(input)) return {ok: false, code: 'INPUT_INVALID'}
  if (!isBatchRecordSink(input.sink)) return {ok: false, code: 'BATCH_SINK_REQUIRED'}

  const now = input.now ?? input.context.now ?? Date.now()

  // Zero-dispatch by construction: preflight takes no sink and no transport.
  const preflight = preflightBatch({manifest: input.manifest, plans: input.plans, now})
  if (!preflight.ok) return {ok: false, code: 'PREFLIGHT_FAILED', preflight}

  const {manifest, plans} = preflight

  // One confirmation over N plans, and only over this exact sealed enumeration.
  if (input.confirmation !== confirmationTokenFor(manifest.manifestDigest)) {
    return {ok: false, code: 'BATCH_CONFIRMATION_MISMATCH'}
  }

  const execute = input.execute ?? executeMutation
  const members: BatchExecutionMember[] = []
  let halted = false
  let haltedAtIndex: number | undefined
  let sinkFailed = false

  for (let index = 0; index < plans.length; index += 1) {
    const plan = plans[index]

    if (halted || sinkFailed) {
      members.push({index, planId: plan.planId, planDigest: plan.planDigest, outcome: 'not-attempted'})
      continue
    }

    const result = await runMember(execute, plan, input, now)
    // A kernel that threw left an unknown state behind: never a success.
    const outcome = result === undefined ? 'uncertain' : outcomeOf(result)
    const receiptId = result === undefined || result.receiptWriteFailed ? undefined : result.receipt.receiptId
    members.push({
      index,
      planId: plan.planId,
      planDigest: plan.planDigest,
      outcome,
      ...(receiptId === undefined ? {} : {receiptId}),
      ...(result === undefined ? {} : {result}),
    })

    try {
      await input.sink.writeBatchLink(
        createBatchLink({
          batchId: manifest.batchId,
          manifestDigest: manifest.manifestDigest,
          index,
          planId: plan.planId,
          planDigest: plan.planDigest,
          outcome,
          ...(receiptId === undefined ? {} : {receiptId}),
        }),
      )
    } catch {
      // The store proved it cannot persist. Dispatch nothing further and
      // never let this run claim closure.
      sinkFailed = true
      halted = true
      haltedAtIndex ??= index
      continue
    }

    // `continue-on-stop` is sealed at planning time and applies ONLY to
    // pre-dispatch STOPs; every other non-accepted outcome halts.
    if (outcome === 'accepted') continue
    if (outcome === 'stopped' && manifest.haltPolicy === 'continue-on-stop') continue
    halted = true
    haltedAtIndex = index
  }

  // Every member after a halt is recorded `not-attempted`, in sealed order.
  if (!sinkFailed) {
    for (const member of members) {
      if (member.outcome !== 'not-attempted') continue
      try {
        await input.sink.writeBatchLink(
          createBatchLink({
            batchId: manifest.batchId,
            manifestDigest: manifest.manifestDigest,
            index: member.index,
            planId: member.planId,
            planDigest: member.planDigest,
            outcome: 'not-attempted',
          }),
        )
      } catch {
        sinkFailed = true
        break
      }
    }
  }

  const counts = countsOf(members)
  const closingReceipt = sinkFailed ? undefined : await appendClosingReceipt(input.sink, manifest, members, now)

  return {
    ok: true,
    manifest,
    members: Object.freeze(members),
    counts,
    runState: closingReceipt === undefined ? 'UNCERTAIN' : 'CLOSED',
    ...(closingReceipt === undefined ? {} : {closingReceipt}),
    halted,
    ...(haltedAtIndex === undefined ? {} : {haltedAtIndex}),
  }
}

/**
 * One member, one unchanged single-plan execution. The per-item confirmation is
 * derived here by binding the approved batch to this member's `planDigest`, and
 * the request is projected from the sealed plan snapshot so nothing a caller
 * supplies can diverge from what the manifest digest covered.
 */
async function runMember(
  execute: ExecuteMutationFn,
  plan: MutationPlan,
  input: BatchExecutionInput,
  now: number,
): Promise<MutationExecutionResult | undefined> {
  const request: MutationRequest = {
    profileName: plan.profileName,
    resource: plan.resource,
    operation: plan.operation,
    payload: plan.payload,
    objectCount: 1,
    readBackExpectation: plan.readBackExpectation,
  }
  try {
    const result = await execute({
      request,
      plan,
      confirmation: confirmationTokenFor(plan.planDigest),
      context: input.context,
      transport: input.transport,
      now,
    })
    return isExecutionResult(result) ? result : undefined
  } catch {
    return undefined
  }
}

function isExecutionResult(value: unknown): value is MutationExecutionResult {
  return (
    isObjectRecord(value) &&
    typeof value.outcome === 'string' &&
    typeof value.dispatchState === 'string' &&
    isObjectRecord(value.receipt)
  )
}

/**
 * ADR-0011's outcome mapping, exactly. It mirrors what a durable
 * `ledgerops.audit.v1` receipt says, so a link written here and the coverage
 * reconstructed from the journal can never disagree. Anything unrecognised is
 * `uncertain`; an unknown state never coerces to success.
 */
function outcomeOf(result: MutationExecutionResult): BatchItemOutcome {
  switch (result.outcome) {
    case 'VERIFIED':
      return 'accepted'
    case 'STOP':
      // A pre-dispatch STOP dispatched nothing; anything else already touched
      // the transport and cannot be vouched for.
      return result.dispatchState === 'not-dispatched' ? 'stopped' : 'dispatched-unverified'
    case 'MISMATCH':
    case 'MISSING':
    case 'AMBIGUOUS':
      return 'dispatched-unverified'
    case 'UNCERTAIN':
      return 'uncertain'
    default:
      return 'uncertain'
  }
}

/**
 * ADR-0011: "if that append fails, or the process dies before it is written,
 * the batch's outcome is UNCERTAIN". Returning `undefined` is that UNCERTAIN;
 * a failed close is never reported as success.
 */
async function appendClosingReceipt(
  sink: BatchRecordSink,
  manifest: BatchManifest,
  members: readonly BatchExecutionMember[],
  now: number,
): Promise<BatchReceipt | undefined> {
  // `createBatchReceipt` stores items and provenance by reference and then
  // deep-freezes them: hand it fresh objects, never the sealed manifest's own.
  const items: BatchReceiptItem[] = members.map(member => ({
    planId: member.planId,
    outcome: member.outcome,
    ...(member.receiptId === undefined ? {} : {receiptId: member.receiptId}),
  }))
  const provenance = {
    sourceReceiptId: manifest.provenance.sourceReceiptId,
    sourceManifestHashes: [...manifest.provenance.sourceManifestHashes],
  }

  try {
    const receipt = createBatchReceipt({
      batchId: manifest.batchId,
      manifestDigest: manifest.manifestDigest,
      provenance,
      items,
      recordedAt: now,
    })
    await sink.writeBatchReceipt(receipt)
    return receipt
  } catch {
    return undefined
  }
}

function countsOf(members: readonly BatchExecutionMember[]): BatchReceiptCounts {
  const counts = {accepted: 0, stopped: 0, dispatchedUnverified: 0, uncertain: 0, notAttempted: 0}
  for (const member of members) {
    switch (member.outcome) {
      case 'accepted':
        counts.accepted += 1
        break
      case 'stopped':
        counts.stopped += 1
        break
      case 'dispatched-unverified':
        counts.dispatchedUnverified += 1
        break
      case 'uncertain':
        counts.uncertain += 1
        break
      case 'not-attempted':
        counts.notAttempted += 1
        break
    }
  }
  return counts
}

/** Deliberately not a type predicate: narrowing the input would erase its own types. */
function isExecutionRequest(value: unknown): boolean {
  return (
    isObjectRecord(value) &&
    typeof value.confirmation === 'string' &&
    isObjectRecord(value.context) &&
    isObjectRecord(value.transport)
  )
}

function isBatchRecordSink(value: unknown): value is BatchRecordSink {
  return (
    isObjectRecord(value) && typeof value.writeBatchLink === 'function' && typeof value.writeBatchReceipt === 'function'
  )
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
