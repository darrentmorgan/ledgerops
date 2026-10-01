import {MAX_BATCH_MANIFEST_MEMBERS} from './batch-manifest.js'
import {defineSignedRecord, digest, label, literal, oneOf} from './signed-record.js'
import {BATCH_ITEM_OUTCOMES, type BatchItemOutcome, type BatchLink} from './types.js'

/**
 * ADR-0011: one append-only `ledgerops.batch-link.v1` record per batch
 * member, written through the same write-ahead sink as the receipts it
 * links. `ledgerops.audit.v1` stays untouched — batch context never gets
 * smuggled into that frozen schema.
 */

const IS_LABEL = label()
const IS_DIGEST = digest()

function isIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < MAX_BATCH_MANIFEST_MEMBERS
}

/** `not-attempted` never reached the kernel, so it can never carry a receipt. */
function notAttemptedHasNoReceipt(record: BatchLink): boolean {
  return record.outcome !== 'not-attempted' || record.receiptId === undefined
}

const batchLinkRecord = defineSignedRecord<BatchLink, 'linkDigest'>({
  label: 'ledgerops.batch-link.v1',
  digestField: 'linkDigest',
  fields: {
    schemaVersion: {check: literal('ledgerops.batch-link.v1')},
    batchId: {check: IS_LABEL},
    manifestDigest: {check: IS_DIGEST},
    index: {check: isIndex},
    planId: {check: IS_LABEL},
    planDigest: {check: IS_DIGEST},
    outcome: {check: oneOf<BatchItemOutcome>(...BATCH_ITEM_OUTCOMES)},
    receiptId: {check: IS_DIGEST, optional: true},
  },
  invariants: [notAttemptedHasNoReceipt],
})

export interface BatchLinkInput {
  batchId: string
  manifestDigest: string
  index: number
  planId: string
  planDigest: string
  outcome: BatchItemOutcome
  receiptId?: string
}

export function createBatchLink(input: BatchLinkInput): BatchLink {
  return batchLinkRecord.create({
    schemaVersion: 'ledgerops.batch-link.v1',
    batchId: input.batchId,
    manifestDigest: input.manifestDigest,
    index: input.index,
    planId: input.planId,
    planDigest: input.planDigest,
    outcome: input.outcome,
    receiptId: input.receiptId,
  })
}

export const verifyBatchLinkIntegrity = batchLinkRecord.verify

/** Parse-don't-validate: batch paths act only on the snapshot this returns. */
export const parseBatchLink = batchLinkRecord.parse
