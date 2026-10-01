import {describe, expect, it} from 'vitest'
import {
  createBatchReceipt,
  digestJson,
  parseBatchReceipt,
  verifyBatchReceiptIntegrity,
  type BatchReceipt,
  type BatchReceiptInput,
  type BatchReceiptItem,
} from '../../../src/lib/ledgerops/index.js'

const BATCH_ID = 'batch-1'
const CREATED_AT = Date.parse('2026-08-12T00:00:00.000Z')

function syntheticDigest(seed: string): string {
  return digestJson({seed})
}

const MANIFEST_DIGEST = syntheticDigest('manifest')

const PROVENANCE = {
  sourceReceiptId: syntheticDigest('source-receipt'),
  sourceManifestHashes: [syntheticDigest('source-a'), syntheticDigest('source-b')].sort(),
}

function items(): readonly BatchReceiptItem[] {
  return [
    {planId: 'batch-plan-1', outcome: 'accepted', receiptId: syntheticDigest('receipt-1')},
    {planId: 'batch-plan-2', outcome: 'accepted', receiptId: syntheticDigest('receipt-2')},
    {planId: 'batch-plan-3', outcome: 'stopped', receiptId: syntheticDigest('receipt-3')},
    {planId: 'batch-plan-4', outcome: 'not-attempted'},
  ]
}

function receiptInput(overrides: Partial<BatchReceiptInput> = {}): BatchReceiptInput {
  return {
    batchId: BATCH_ID,
    manifestDigest: MANIFEST_DIGEST,
    provenance: PROVENANCE,
    items: items(),
    recordedAt: CREATED_AT,
    ...overrides,
  }
}

function receipt(overrides: Partial<BatchReceiptInput> = {}): BatchReceipt {
  return createBatchReceipt(receiptInput(overrides))
}

/** Mutate a signed receipt without re-signing it. */
function tampered(base: BatchReceipt, patch: Record<string, unknown>): unknown {
  return {...(JSON.parse(JSON.stringify(base)) as Record<string, unknown>), ...patch}
}

describe('ledgerops.batch-receipt.v1 creation', () => {
  it('derives per-outcome counts from the item list and seals the provenance block', () => {
    const record = receipt()

    expect(record.schemaVersion).toBe('ledgerops.batch-receipt.v1')
    expect(record.batchId).toBe(BATCH_ID)
    expect(record.manifestDigest).toBe(MANIFEST_DIGEST)
    expect(record.provenance).toEqual(PROVENANCE)
    expect(record.items).toEqual(items())
    expect(record.counts).toEqual({
      accepted: 2,
      stopped: 1,
      dispatchedUnverified: 0,
      uncertain: 0,
      notAttempted: 1,
    })
    expect(record.batchReceiptDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(Object.isFrozen(record)).toBe(true)
    expect(Object.isFrozen(record.items)).toBe(true)
  })

  it('refuses an empty item list', () => {
    expect(() => receipt({items: []})).toThrow()
  })

  it('refuses duplicate plan ids across items', () => {
    const duplicated = [...items(), items()[0]]
    expect(() => receipt({items: duplicated})).toThrow()
  })

  it('refuses a not-attempted item carrying a receiptId', () => {
    expect(() =>
      receipt({
        items: [{planId: 'batch-plan-1', outcome: 'not-attempted', receiptId: syntheticDigest('receipt-1')}],
      }),
    ).toThrow()
  })

  it('refuses malformed provenance', () => {
    expect(() => receipt({provenance: {sourceReceiptId: 'nope', sourceManifestHashes: []}})).toThrow()
  })

  it('refuses a malformed manifestDigest', () => {
    expect(() => receipt({manifestDigest: 'not-a-digest'})).toThrow()
  })
})

describe('ledgerops.batch-receipt.v1 parsing', () => {
  it('round-trips a signed receipt through canonical JSON', () => {
    const record = receipt()
    const parsed = parseBatchReceipt(JSON.parse(JSON.stringify(record)))

    expect(parsed).toEqual(record)
    expect(verifyBatchReceiptIntegrity(record)).toBe(true)
  })

  it('refuses values that are not signed receipt objects', () => {
    for (const value of [undefined, null, 'receipt', 42, [], () => undefined, new Date()]) {
      expect(parseBatchReceipt(value)).toBeUndefined()
      expect(verifyBatchReceiptIntegrity(value)).toBe(false)
    }
  })

  it('refuses an extra key outside the sealed key set', () => {
    expect(parseBatchReceipt(tampered(receipt(), {note: 'extra'}))).toBeUndefined()
  })

  it('refuses a counts value that disagrees with the item list', () => {
    const record = receipt()
    expect(
      parseBatchReceipt(
        tampered(record, {
          counts: {...record.counts, accepted: record.counts.accepted + 1},
        }),
      ),
    ).toBeUndefined()
  })

  it('refuses a tampered item list, provenance and digest', () => {
    const record = receipt()
    expect(parseBatchReceipt(tampered(record, {items: [...record.items].reverse()}))).toBeUndefined()
    expect(
      parseBatchReceipt(
        tampered(record, {
          provenance: {...record.provenance, sourceReceiptId: syntheticDigest('other-receipt')},
        }),
      ),
    ).toBeUndefined()
    expect(parseBatchReceipt(tampered(record, {batchReceiptDigest: syntheticDigest('forged')}))).toBeUndefined()
  })
})
