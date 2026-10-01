import {describe, expect, it} from 'vitest'
import {
  createFixtureReadTransport,
  createTargetBinding,
  createTargetIdentity,
  FOUNDATION_READ_RESOURCES,
  InMemoryReadReceiptSink,
  isReportingReadResource,
  MATCHING_READ_RESOURCES,
  READ_RESOURCE_NAMES,
  READ_RESOURCES,
  REPORTING_READ_RESOURCES,
  runReportingRead,
} from '../../../src/lib/ledgerops/index.js'

const NOW = Date.parse('2026-08-07T00:00:00.000Z')
const PROFILE = 'synthetic-reporting-profile'

function identityFor(resource: string) {
  const spec = READ_RESOURCES[resource]
  return createTargetIdentity({
    profileName: PROFILE,
    tenantId: 'synthetic-reporting-tenant',
    resource,
    isDemoCompany: false,
    observedAt: NOW,
    freshUntil: NOW + 60_000,
    capabilities: [spec.capability],
    scopes: spec.scopes.map(group => group[0]),
  })
}

describe('reporting reads workflow', () => {
  it('covers the five reports plus journals, all kernel-allowlisted, disjoint from foundation', () => {
    expect([...REPORTING_READ_RESOURCES]).toEqual([
      'report-profit-and-loss',
      'report-balance-sheet',
      'report-trial-balance',
      'report-aged-receivables',
      'report-aged-payables',
      'journals',
    ])
    for (const resource of REPORTING_READ_RESOURCES) {
      expect(isReportingReadResource(resource)).toBe(true)
      expect(READ_RESOURCES[resource]).toBeDefined()
      expect(FOUNDATION_READ_RESOURCES).not.toContain(resource)
      expect(MATCHING_READ_RESOURCES).not.toContain(resource)
    }
    // The three lanes together cover the whole kernel allowlist exactly.
    expect([...FOUNDATION_READ_RESOURCES, ...REPORTING_READ_RESOURCES, ...MATCHING_READ_RESOURCES].sort()).toEqual([
      ...READ_RESOURCE_NAMES,
    ])
  })

  it('runs each reporting resource end to end with a persisted OK receipt', async () => {
    for (const resource of REPORTING_READ_RESOURCES) {
      const identity = identityFor(resource)
      const receiptSink = new InMemoryReadReceiptSink()
      const records = [{name: `synthetic-${resource}-row`, position: 1}]

      const result = await runReportingRead({
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

  it('stops a foundation resource at the workflow boundary without touching the transport', async () => {
    const identity = identityFor('accounts')
    const receiptSink = new InMemoryReadReceiptSink()
    let transportTouched = false

    const result = await runReportingRead({
      request: {profileName: PROFILE, resource: 'accounts'},
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
  })

  it('keeps kernel INVALID_REQUEST STOPs for malformed request shapes', async () => {
    const identity = identityFor('journals')
    const transport = createFixtureReadTransport(identity, [])
    const context = () => ({identity, receiptSink: new InMemoryReadReceiptSink(), now: NOW})

    const nullRequest = await runReportingRead({
      request: null as unknown as Parameters<typeof runReportingRead>[0]['request'],
      context: context(),
      transport,
    })
    expect(nullRequest).toMatchObject({status: 'stop', reasonCode: 'INVALID_REQUEST'})

    const emptyResource = await runReportingRead({
      request: {profileName: PROFILE, resource: '   '},
      context: context(),
      transport,
    })
    expect(emptyResource).toMatchObject({status: 'stop', reasonCode: 'INVALID_REQUEST'})
  })

  it('scopes journals to the granular accounting.journals.read with no write-capable alternative', () => {
    expect(READ_RESOURCES.journals.scopes).toEqual([['accounting.journals.read']])
  })
})
