import {describe, expect, it} from 'vitest'
import {
  MAX_BATCH_MANIFEST_MEMBERS,
  createBatchLink,
  digestJson,
  parseBatchLink,
  verifyBatchLinkIntegrity,
  type BatchLink,
  type BatchLinkInput,
} from '../../../src/lib/ledgerops/index.js'

const BATCH_ID = 'batch-1'

function syntheticDigest(seed: string): string {
  return digestJson({seed})
}

const MANIFEST_DIGEST = syntheticDigest('manifest')
const PLAN_DIGEST = syntheticDigest('plan')
const RECEIPT_ID = syntheticDigest('receipt')

function linkInput(overrides: Partial<BatchLinkInput> = {}): BatchLinkInput {
  return {
    batchId: BATCH_ID,
    manifestDigest: MANIFEST_DIGEST,
    index: 0,
    planId: 'batch-plan-1',
    planDigest: PLAN_DIGEST,
    outcome: 'accepted',
    receiptId: RECEIPT_ID,
    ...overrides,
  }
}

function link(overrides: Partial<BatchLinkInput> = {}): BatchLink {
  return createBatchLink(linkInput(overrides))
}

/** Mutate a signed link without re-signing it. */
function tampered(base: BatchLink, patch: Record<string, unknown>): unknown {
  return {...(JSON.parse(JSON.stringify(base)) as Record<string, unknown>), ...patch}
}

describe('ledgerops.batch-link.v1 creation', () => {
  it('seals batch identity, member identity, index and outcome into the link digest', () => {
    const record = link()

    expect(record.schemaVersion).toBe('ledgerops.batch-link.v1')
    expect(record.batchId).toBe(BATCH_ID)
    expect(record.manifestDigest).toBe(MANIFEST_DIGEST)
    expect(record.index).toBe(0)
    expect(record.planId).toBe('batch-plan-1')
    expect(record.planDigest).toBe(PLAN_DIGEST)
    expect(record.outcome).toBe('accepted')
    expect(record.receiptId).toBe(RECEIPT_ID)
    expect(record.linkDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(Object.isFrozen(record)).toBe(true)
  })

  it('accepts every batch item outcome', () => {
    for (const outcome of ['accepted', 'stopped', 'dispatched-unverified', 'uncertain'] as const) {
      expect(link({outcome, receiptId: RECEIPT_ID}).outcome).toBe(outcome)
    }
  })

  it('omits receiptId for an accounted-for member that never dispatched', () => {
    const record = link({outcome: 'not-attempted', receiptId: undefined})
    expect(record.outcome).toBe('not-attempted')
    expect(record.receiptId).toBeUndefined()
  })

  it('refuses a not-attempted member carrying a receiptId', () => {
    expect(() => link({outcome: 'not-attempted', receiptId: RECEIPT_ID})).toThrow()
  })

  it('refuses an unknown outcome', () => {
    expect(() => link({outcome: 'unknown' as BatchLinkInput['outcome']})).toThrow()
  })

  it('refuses an index outside the manifest bounds', () => {
    expect(() => link({index: -1})).toThrow()
    expect(() => link({index: 1.5})).toThrow()
    expect(() => link({index: MAX_BATCH_MANIFEST_MEMBERS})).toThrow()
  })

  it('refuses a blank batchId or planId, or a malformed digest', () => {
    expect(() => link({batchId: ''})).toThrow()
    expect(() => link({planId: ''})).toThrow()
    expect(() => link({manifestDigest: 'not-a-digest'})).toThrow()
    expect(() => link({planDigest: 'not-a-digest'})).toThrow()
    expect(() => link({receiptId: 'not-a-digest'})).toThrow()
  })
})

describe('ledgerops.batch-link.v1 parsing', () => {
  it('round-trips a signed link through canonical JSON', () => {
    const record = link()
    const parsed = parseBatchLink(JSON.parse(JSON.stringify(record)))

    expect(parsed).toEqual(record)
    expect(verifyBatchLinkIntegrity(record)).toBe(true)
  })

  it('refuses values that are not signed link objects', () => {
    for (const value of [undefined, null, 'link', 42, [], () => undefined, new Date()]) {
      expect(parseBatchLink(value)).toBeUndefined()
      expect(verifyBatchLinkIntegrity(value)).toBe(false)
    }
  })

  it('refuses an extra key outside the sealed key set', () => {
    expect(parseBatchLink(tampered(link(), {note: 'extra'}))).toBeUndefined()
  })

  it('refuses a missing key inside the sealed key set', () => {
    const record = JSON.parse(JSON.stringify(link())) as Record<string, unknown>
    delete record.outcome
    expect(parseBatchLink(record)).toBeUndefined()
  })

  it('refuses tampered scalars and digest', () => {
    const record = link()
    expect(parseBatchLink(tampered(record, {index: 1}))).toBeUndefined()
    expect(parseBatchLink(tampered(record, {outcome: 'stopped'}))).toBeUndefined()
    expect(parseBatchLink(tampered(record, {planId: 'other-plan'}))).toBeUndefined()
    expect(parseBatchLink(tampered(record, {linkDigest: syntheticDigest('forged')}))).toBeUndefined()
  })

  it('refuses a not-attempted member smuggled with a receiptId outside create()', () => {
    const record = link({outcome: 'not-attempted', receiptId: undefined})
    expect(parseBatchLink(tampered(record, {receiptId: RECEIPT_ID}))).toBeUndefined()
  })
})
