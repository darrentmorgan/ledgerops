import {isBatchProvenance, MAX_BATCH_MANIFEST_MEMBERS} from './batch-manifest.js'
import {defineSignedRecord, digest, finiteNumber, label, literal, oneOf, shape} from './signed-record.js'
import {
  BATCH_ITEM_OUTCOMES,
  type BatchItemOutcome,
  type BatchProvenance,
  type BatchReceipt,
  type BatchReceiptCounts,
  type BatchReceiptItem,
} from './types.js'

/**
 * ADR-0011: the closing `ledgerops.batch-receipt.v1` record summarizes a
 * batch run — counts and per-item outcome/receipt refs, plus the same
 * provenance block as the manifest it closes. It attests coverage; it never
 * replaces the per-item `ledgerops.audit.v1` receipts.
 */

const IS_LABEL = label()
const IS_DIGEST = digest()

const isBatchReceiptItemShape = shape<BatchReceiptItem>()({
  fields: {
    planId: {check: IS_LABEL},
    outcome: {check: oneOf<BatchItemOutcome>(...BATCH_ITEM_OUTCOMES)},
    receiptId: {check: IS_DIGEST, optional: true},
  },
})

/** `not-attempted` never reached the kernel, so it can never carry a receipt. */
function itemNotAttemptedHasNoReceipt(item: BatchReceiptItem): boolean {
  return item.outcome !== 'not-attempted' || item.receiptId === undefined
}

/** Non-empty, bounded like a manifest, unique plan ids: every member accounted for once. */
function isBatchReceiptItems(value: unknown): value is readonly BatchReceiptItem[] {
  if (!Array.isArray(value)) return false
  if (value.length === 0 || value.length > MAX_BATCH_MANIFEST_MEMBERS) return false
  if (!value.every(item => isBatchReceiptItemShape(item) && itemNotAttemptedHasNoReceipt(item))) return false
  const items = value as readonly BatchReceiptItem[]
  const planIds = new Set(items.map(item => item.planId))
  return planIds.size === items.length
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

const isBatchReceiptCounts = shape<BatchReceiptCounts>()({
  fields: {
    accepted: {check: isNonNegativeInteger},
    stopped: {check: isNonNegativeInteger},
    dispatchedUnverified: {check: isNonNegativeInteger},
    uncertain: {check: isNonNegativeInteger},
    notAttempted: {check: isNonNegativeInteger},
  },
})

function countsOf(items: readonly BatchReceiptItem[]): BatchReceiptCounts {
  const counts = {accepted: 0, stopped: 0, dispatchedUnverified: 0, uncertain: 0, notAttempted: 0}
  for (const item of items) {
    switch (item.outcome) {
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

const batchReceiptRecord = defineSignedRecord<BatchReceipt, 'batchReceiptDigest', 'counts'>({
  label: 'ledgerops.batch-receipt.v1',
  digestField: 'batchReceiptDigest',
  fields: {
    schemaVersion: {check: literal('ledgerops.batch-receipt.v1')},
    batchId: {check: IS_LABEL},
    manifestDigest: {check: IS_DIGEST},
    provenance: {check: isBatchProvenance},
    items: {check: isBatchReceiptItems},
    counts: {check: isBatchReceiptCounts, derive: supplied => countsOf(supplied.items)},
    recordedAt: {check: finiteNumber()},
  },
})

export interface BatchReceiptInput {
  batchId: string
  manifestDigest: string
  provenance: BatchProvenance
  items: readonly BatchReceiptItem[]
  recordedAt: number
}

export function createBatchReceipt(input: BatchReceiptInput): BatchReceipt {
  return batchReceiptRecord.create({
    schemaVersion: 'ledgerops.batch-receipt.v1',
    batchId: input.batchId,
    manifestDigest: input.manifestDigest,
    provenance: input.provenance,
    items: input.items,
    recordedAt: input.recordedAt,
  })
}

export const verifyBatchReceiptIntegrity = batchReceiptRecord.verify

/** Parse-don't-validate: batch paths act only on the snapshot this returns. */
export const parseBatchReceipt = batchReceiptRecord.parse
