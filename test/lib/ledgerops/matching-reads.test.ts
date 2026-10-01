import {describe, expect, it} from 'vitest'
import {
  createFixtureReadTransport,
  createTargetBinding,
  createTargetIdentity,
  FOUNDATION_READ_RESOURCES,
  InMemoryReadReceiptSink,
  isMatchingReadResource,
  MATCHING_READ_RESOURCES,
  READ_RESOURCES,
  REPORTING_READ_RESOURCES,
  runMatchingRead,
} from '../../../src/lib/ledgerops/index.js'

const NOW = Date.parse('2026-08-07T00:00:00.000Z')
const PROFILE = 'synthetic-matching-profile'

function identityFor(resource: string) {
  const spec = READ_RESOURCES[resource]
  return createTargetIdentity({
    profileName: PROFILE,
    tenantId: 'synthetic-matching-tenant',
    resource,
    isDemoCompany: false,
    observedAt: NOW,
    freshUntil: NOW + 60_000,
    capabilities: [spec.capability],
    scopes: spec.scopes.map(group => group[0]),
  })
}

describe('matching reads workflow', () => {
  it('covers the five transactional resources, all kernel-allowlisted, disjoint from the other lanes', () => {
    expect([...MATCHING_READ_RESOURCES]).toEqual([
      'bank-transactions',
      'payments',
      'invoices',
      'credit-notes',
      'manual-journals',
    ])
    for (const resource of MATCHING_READ_RESOURCES) {
      expect(isMatchingReadResource(resource)).toBe(true)
      expect(READ_RESOURCES[resource]).toBeDefined()
      expect(FOUNDATION_READ_RESOURCES).not.toContain(resource)
      expect(REPORTING_READ_RESOURCES).not.toContain(resource)
    }
  })

  it('runs each matching resource end to end with a persisted OK receipt', async () => {
    for (const resource of MATCHING_READ_RESOURCES) {
      const identity = identityFor(resource)
      const receiptSink = new InMemoryReadReceiptSink()
      const records = [{name: `synthetic-${resource}-row`, position: 1}]

      const result = await runMatchingRead({
        request: {profileName: PROFILE, resource},
        context: {identity, receiptSink, now: NOW},
        transport: createFixtureReadTransport(identity, records),
      })

      expect(result.status).toBe('ok')
      expect(result.records).toEqual(records)
      expect(receiptSink.receipts).toHaveLength(1)
      expect(receiptSink.receipts[0]).toEqual(result.receipt)
      expect(result.receipt?.resource).toBe(resource)
      expect(result.receipt?.outcome).toBe('OK')
    }
  })

  it('stops resources from the other lanes at the workflow boundary without touching the transport', async () => {
    for (const resource of ['accounts', 'journals']) {
      const identity = identityFor(resource)
      const receiptSink = new InMemoryReadReceiptSink()
      let transportTouched = false

      const result = await runMatchingRead({
        request: {profileName: PROFILE, resource},
        context: {identity, receiptSink, now: NOW},
        transport: {
          binding: createTargetBinding(identity),
          read() {
            transportTouched = true
            return {records: [], done: true}
          },
        },
      })

      expect(result).toMatchObject({status: 'stop', stop: true, reasonCode: 'RESOURCE_NOT_ALLOWED'})
      expect(result.receipt).toBeUndefined()
      expect(transportTouched).toBe(false)
      expect(receiptSink.receipts).toHaveLength(0)
    }
  })

  it('keeps kernel INVALID_REQUEST STOPs for malformed request shapes', async () => {
    const identity = identityFor('invoices')
    const transport = createFixtureReadTransport(identity, [])
    const context = () => ({identity, receiptSink: new InMemoryReadReceiptSink(), now: NOW})

    const nullRequest = await runMatchingRead({
      request: null as unknown as Parameters<typeof runMatchingRead>[0]['request'],
      context: context(),
      transport,
    })
    expect(nullRequest).toMatchObject({status: 'stop', reasonCode: 'INVALID_REQUEST'})

    const emptyResource = await runMatchingRead({
      request: {profileName: PROFILE, resource: '   '},
      context: context(),
      transport,
    })
    expect(emptyResource).toMatchObject({status: 'stop', reasonCode: 'INVALID_REQUEST'})
  })

  it('leads every matching scope group with the granular .read variant', () => {
    // Credit notes sit under the invoices scope: Xero publishes no separate
    // creditnotes scope (granular scopes documentation).
    expect(READ_RESOURCES['bank-transactions'].scopes).toEqual([
      ['accounting.banktransactions.read', 'accounting.banktransactions'],
    ])
    expect(READ_RESOURCES.payments.scopes).toEqual([['accounting.payments.read', 'accounting.payments']])
    expect(READ_RESOURCES.invoices.scopes).toEqual([['accounting.invoices.read', 'accounting.invoices']])
    expect(READ_RESOURCES['credit-notes'].scopes).toEqual([['accounting.invoices.read', 'accounting.invoices']])
    expect(READ_RESOURCES['manual-journals'].scopes).toEqual([
      ['accounting.manualjournals.read', 'accounting.manualjournals'],
    ])
  })

  it('sweeps pages ADR-0008 style: one bounded receipted read per page, never a widened call', async () => {
    const identity = identityFor('bank-transactions')
    const pages: Record<number, unknown[]> = {
      1: [{type: 'SPEND', position: 1}],
      2: [{type: 'RECEIVE', position: 2}],
    }

    const collected: unknown[] = []
    const receiptSink = new InMemoryReadReceiptSink()
    for (const page of [1, 2]) {
      const query = {page}
      const result = await runMatchingRead({
        request: {profileName: PROFILE, resource: 'bank-transactions', query},
        context: {identity, receiptSink, now: NOW},
        transport: createFixtureReadTransport(identity, pages[page], query),
      })
      expect(result.status).toBe('ok')
      expect(result.callCount).toBe(1)
      collected.push(...result.records)
    }

    expect(collected).toEqual([
      {type: 'SPEND', position: 1},
      {type: 'RECEIVE', position: 2},
    ])
    // Each page earned its own signed receipt over its own query digest.
    expect(receiptSink.receipts).toHaveLength(2)
    expect(receiptSink.receipts[0].queryDigest).not.toBe(receiptSink.receipts[1].queryDigest)
  })
})
