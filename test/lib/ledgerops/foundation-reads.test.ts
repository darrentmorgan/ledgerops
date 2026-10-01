import {describe, expect, it} from 'vitest'
import {
  createFixtureReadTransport,
  createTargetBinding,
  createTargetIdentity,
  FOUNDATION_READ_RESOURCES,
  InMemoryReadReceiptSink,
  isFoundationReadResource,
  isReadReceipt,
  READ_RESOURCES,
  runFoundationRead,
} from '../../../src/lib/ledgerops/index.js'

const NOW = Date.parse('2026-08-07T00:00:00.000Z')
const PROFILE = 'synthetic-foundation-profile'

function identityFor(resource: string) {
  const spec = READ_RESOURCES[resource]
  return createTargetIdentity({
    profileName: PROFILE,
    tenantId: 'synthetic-foundation-tenant',
    resource,
    isDemoCompany: false,
    observedAt: NOW,
    freshUntil: NOW + 60_000,
    capabilities: [spec.capability],
    scopes: spec.scopes.map(group => group[0]),
  })
}

describe('foundation reads workflow', () => {
  it('covers exactly the four Tier 0 reference resources, all kernel-allowlisted', () => {
    expect([...FOUNDATION_READ_RESOURCES]).toEqual(['accounts', 'contacts', 'currencies', 'tax-rates'])
    for (const resource of FOUNDATION_READ_RESOURCES) {
      expect(isFoundationReadResource(resource)).toBe(true)
      expect(READ_RESOURCES[resource]).toBeDefined()
    }
    expect(isFoundationReadResource('report-profit-and-loss')).toBe(false)
  })

  it('runs each foundation resource end to end with a persisted OK receipt', async () => {
    for (const resource of FOUNDATION_READ_RESOURCES) {
      const identity = identityFor(resource)
      const receiptSink = new InMemoryReadReceiptSink()
      const records = [{name: `synthetic-${resource}-record`, position: 1}]

      const result = await runFoundationRead({
        request: {profileName: PROFILE, resource},
        context: {identity, receiptSink, now: NOW},
        transport: createFixtureReadTransport(identity, records),
      })

      expect(result.status).toBe('ok')
      expect(result.records).toEqual(records)
      expect(result.recordCount).toBe(1)
      expect(result.receipt && isReadReceipt(result.receipt)).toBe(true)
      expect(receiptSink.receipts).toHaveLength(1)
      expect(receiptSink.receipts[0]).toEqual(result.receipt)
      expect(result.receipt?.resource).toBe(resource)
    }
  })

  it('stops a kernel-allowlisted reporting resource at the workflow boundary', async () => {
    const resource = 'report-profit-and-loss'
    const identity = identityFor(resource)
    const receiptSink = new InMemoryReadReceiptSink()
    let transportTouched = false

    const result = await runFoundationRead({
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
  })

  it('binds the fixture transport to one target and rejects every other', async () => {
    const identity = identityFor('accounts')
    const foreign = identityFor('contacts')
    const transport = createFixtureReadTransport(identity, [{code: '200'}])

    expect(() =>
      transport.read({
        resource: 'accounts',
        targetBinding: createTargetBinding(foreign),
        query: {},
        call: 1,
      }),
    ).toThrow('bound to a different target')

    const result = await runFoundationRead({
      request: {profileName: PROFILE, resource: 'contacts'},
      context: {identity: foreign, receiptSink: new InMemoryReadReceiptSink(), now: NOW},
      transport,
    })
    expect(result).toMatchObject({status: 'stop', reasonCode: 'TRANSPORT_BINDING_MISMATCH'})
  })

  it('rejects a same-resource identity for another tenant at the transport seam', async () => {
    const identity = identityFor('accounts')
    const foreignTenant = createTargetIdentity({
      profileName: PROFILE,
      tenantId: 'synthetic-other-tenant',
      resource: 'accounts',
      isDemoCompany: false,
      observedAt: NOW,
      freshUntil: NOW + 60_000,
      capabilities: [READ_RESOURCES.accounts.capability],
      scopes: READ_RESOURCES.accounts.scopes.map(group => group[0]),
    })
    const transport = createFixtureReadTransport(identity, [{code: '200'}])

    expect(() =>
      transport.read({
        resource: 'accounts',
        targetBinding: createTargetBinding(foreignTenant),
        query: {},
        call: 1,
      }),
    ).toThrow('bound to a different target')

    const result = await runFoundationRead({
      request: {profileName: PROFILE, resource: 'accounts'},
      context: {identity: foreignTenant, receiptSink: new InMemoryReadReceiptSink(), now: NOW},
      transport,
    })
    expect(result).toMatchObject({status: 'stop', reasonCode: 'TRANSPORT_BINDING_MISMATCH'})
  })

  it('keeps kernel INVALID_REQUEST STOPs for malformed request shapes', async () => {
    const identity = identityFor('accounts')
    const transport = createFixtureReadTransport(identity, [])
    const context = () => ({identity, receiptSink: new InMemoryReadReceiptSink(), now: NOW})

    const nullRequest = await runFoundationRead({
      request: null as unknown as Parameters<typeof runFoundationRead>[0]['request'],
      context: context(),
      transport,
    })
    expect(nullRequest).toMatchObject({status: 'stop', reasonCode: 'INVALID_REQUEST'})

    const emptyResource = await runFoundationRead({
      request: {profileName: PROFILE, resource: '   '},
      context: context(),
      transport,
    })
    expect(emptyResource).toMatchObject({status: 'stop', reasonCode: 'INVALID_REQUEST'})
  })

  it('answers only the query the fixture was authored for', async () => {
    const identity = identityFor('accounts')
    const query = {where: 'Code=="200"'}
    const transport = createFixtureReadTransport(identity, [{code: '200'}], query)
    const binding = createTargetBinding(identity)

    expect(() => transport.read({resource: 'accounts', targetBinding: binding, query: {}, call: 1})).toThrow(
      'not authored for this query',
    )

    const result = await runFoundationRead({
      request: {profileName: PROFILE, resource: 'accounts', query},
      context: {identity, receiptSink: new InMemoryReadReceiptSink(), now: NOW},
      transport,
    })
    expect(result.status).toBe('ok')
    expect(result.records).toEqual([{code: '200'}])
  })

  it('refuses secret-shaped fixture records at construction', () => {
    const identity = identityFor('accounts')
    expect(() => createFixtureReadTransport(identity, [{accessToken: 'synthetic-secret-value'}])).toThrow(
      'secret-shaped',
    )
  })

  it('refuses fixture records carrying tenant-identifier fields', () => {
    const identity = identityFor('accounts')
    expect(() => createFixtureReadTransport(identity, [{tenantId: 'synthetic-raw-tenant'}])).toThrow(
      'tenant-identifier',
    )
    expect(() => createFixtureReadTransport(identity, [{nested: [{TenantID: 'synthetic-raw-tenant'}]}])).toThrow(
      'tenant-identifier',
    )
  })

  it('hands out canonical clones so a caller cannot mutate the fixture page', async () => {
    const identity = identityFor('accounts')
    const transport = createFixtureReadTransport(identity, [{code: '200'}])
    const binding = createTargetBinding(identity)

    const first = await transport.read({resource: 'accounts', targetBinding: binding, query: {}, call: 1})
    ;(first.records[0] as {code: string}).code = 'tampered'
    const second = await transport.read({resource: 'accounts', targetBinding: binding, query: {}, call: 1})

    expect(second.records).toEqual([{code: '200'}])
  })
})
