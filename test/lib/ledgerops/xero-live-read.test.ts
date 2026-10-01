import {describe, expect, it, vi} from 'vitest'
import {
  createTargetBinding,
  createTargetIdentity,
  createXeroLiveReadTransport,
  executeRead,
  InMemoryReadReceiptSink,
  READ_RESOURCE_NAMES,
  READ_RESOURCES,
  XeroLiveReadFailure,
  type XeroLiveReadClient,
} from '../../../src/lib/ledgerops/index.js'

const NOW = Date.parse('2026-08-07T00:00:00.000Z')
const PROFILE = 'synthetic-live-profile'
const TENANT = 'synthetic-tenant-guid'

function identityFor(resource: string) {
  const spec = READ_RESOURCES[resource]
  return createTargetIdentity({
    profileName: PROFILE,
    tenantId: TENANT,
    resource,
    isDemoCompany: false,
    observedAt: NOW,
    freshUntil: NOW + 60_000,
    capabilities: [spec.capability],
    scopes: spec.scopes.map(group => group[0]),
  })
}

class SyntheticAccount {
  constructor(
    readonly code: string,
    readonly name: string,
  ) {}
}

function fakeClient(records: Record<string, unknown[]>): XeroLiveReadClient {
  const respond = (field: string) => async () => ({body: {[field]: records[field] ?? []}})
  return {
    setTokenSet: vi.fn(),
    accountingApi: {
      getAccounts: respond('accounts'),
      getContacts: respond('contacts'),
      getCurrencies: respond('currencies'),
      getTaxRates: respond('taxRates'),
      getReportProfitAndLoss: respond('reports'),
      getReportBalanceSheet: respond('reports'),
      getReportTrialBalance: respond('reports'),
      getReportAgedReceivablesByContact: respond('reports'),
      getReportAgedPayablesByContact: respond('reports'),
      getJournals: respond('journals'),
      getBankTransactions: respond('bankTransactions'),
      getPayments: respond('payments'),
      getInvoices: respond('invoices'),
      getCreditNotes: respond('creditNotes'),
      getManualJournals: respond('manualJournals'),
    },
  }
}

function depsFor(client: XeroLiveReadClient, overrides: Record<string, unknown> = {}) {
  return {
    fileExists: () => true,
    readClientId: () => 'synthetic-client-id',
    readTokenSet: () => ({
      accessToken: 'synthetic-access-token-value',
      expiresAt: NOW + 30 * 60_000,
      tenantId: TENANT,
    }),
    createClient: () => client,
    now: () => NOW,
    ...overrides,
  }
}

describe('xero live read adapter', () => {
  it('covers every allowlisted resource with a fetcher and returns plain JSON', async () => {
    for (const resource of READ_RESOURCE_NAMES) {
      const identity = identityFor(resource)
      const transport = createXeroLiveReadTransport(
        identity,
        depsFor(
          fakeClient({
            accounts: [new SyntheticAccount('200', 'Sales')],
            contacts: [{name: 'Synthetic Pty'}],
            currencies: [{code: 'AUD'}],
            taxRates: [{name: 'GST'}],
            reports: [{reportName: 'Synthetic'}],
            journals: [{journalNumber: 1}],
            bankTransactions: [{type: 'SPEND'}],
            payments: [{amount: 10}],
            invoices: [{invoiceNumber: 'INV-0001'}],
            creditNotes: [{creditNoteNumber: 'CN-0001'}],
            manualJournals: [{narration: 'Synthetic'}],
          }),
        ),
      )
      const query: Record<string, string> = resource.startsWith('report-aged')
        ? {contactId: 'synthetic-contact-guid'}
        : {}
      const page = await transport.read({
        resource,
        targetBinding: createTargetBinding(identity),
        query,
        call: 1,
      })
      expect(page.done).toBe(true)
      expect(Array.isArray(page.records)).toBe(true)
      expect(page.records.length).toBeGreaterThan(0)
      for (const record of page.records) {
        expect(Object.getPrototypeOf(record)).toBe(Object.prototype)
      }
    }
  })

  it('throws on a binding it was not constructed for and on a resource drift', async () => {
    const identity = identityFor('accounts')
    const other = identityFor('contacts')
    const transport = createXeroLiveReadTransport(identity, depsFor(fakeClient({})))

    await expect(
      transport.read({
        resource: 'accounts',
        targetBinding: createTargetBinding(other),
        query: {},
        call: 1,
      }),
    ).rejects.toMatchObject({reasonCode: 'BINDING_MISMATCH'})

    await expect(
      transport.read({
        resource: 'contacts',
        targetBinding: createTargetBinding(identity),
        query: {},
        call: 1,
      }),
    ).rejects.toMatchObject({reasonCode: 'BINDING_MISMATCH'})
  })

  it('refuses to act without config, token, tenant match, or a live-enough token', async () => {
    const identity = identityFor('accounts')
    const binding = createTargetBinding(identity)
    const request = {resource: 'accounts', targetBinding: binding, query: {}, call: 1}
    const client = fakeClient({accounts: [{code: '200'}]})

    const noConfig = createXeroLiveReadTransport(identity, depsFor(client, {fileExists: () => false}))
    await expect(noConfig.read(request)).rejects.toMatchObject({reasonCode: 'CONFIG_MISSING'})

    const noToken = createXeroLiveReadTransport(identity, depsFor(client, {readTokenSet: () => null}))
    await expect(noToken.read(request)).rejects.toMatchObject({reasonCode: 'TOKEN_MISSING'})

    const wrongTenant = createXeroLiveReadTransport(
      identity,
      depsFor(client, {
        readTokenSet: () => ({accessToken: 'synthetic', expiresAt: NOW + 30 * 60_000, tenantId: 'other-tenant'}),
      }),
    )
    await expect(wrongTenant.read(request)).rejects.toMatchObject({reasonCode: 'TENANT_MISMATCH'})

    const nearExpiry = createXeroLiveReadTransport(
      identity,
      depsFor(client, {
        readTokenSet: () => ({accessToken: 'synthetic', expiresAt: NOW + 30_000, tenantId: TENANT}),
      }),
    )
    await expect(nearExpiry.read(request)).rejects.toMatchObject({reasonCode: 'TOKEN_NEAR_EXPIRY'})
  })

  it('requires contactId for aged reports and rejects malformed query values', async () => {
    const identity = identityFor('report-aged-receivables')
    const binding = createTargetBinding(identity)
    const transport = createXeroLiveReadTransport(identity, depsFor(fakeClient({reports: [{}]})))

    await expect(
      transport.read({
        resource: 'report-aged-receivables',
        targetBinding: binding,
        query: {},
        call: 1,
      }),
    ).rejects.toMatchObject({reasonCode: 'QUERY_INVALID'})

    const contacts = identityFor('contacts')
    const contactsTransport = createXeroLiveReadTransport(contacts, depsFor(fakeClient({contacts: []})))
    await expect(
      contactsTransport.read({
        resource: 'contacts',
        targetBinding: createTargetBinding(contacts),
        query: {page: -1},
        call: 1,
      }),
    ).rejects.toMatchObject({reasonCode: 'QUERY_INVALID'})
  })

  it('honors journal pagination flags and rejects malformed journal queries', async () => {
    const identity = identityFor('journals')
    const binding = createTargetBinding(identity)
    const client = fakeClient({journals: [{journalNumber: 7}]})
    const getJournals = vi.spyOn(client.accountingApi, 'getJournals')
    const transport = createXeroLiveReadTransport(identity, depsFor(client))

    const page = await transport.read({
      resource: 'journals',
      targetBinding: binding,
      query: {offset: 100, paymentsOnly: true},
      call: 1,
    })
    expect(page.records).toEqual([{journalNumber: 7}])
    // The receipt signs the query digest, so the signed values must be the
    // ones the SDK request actually carried.
    expect(getJournals).toHaveBeenCalledExactlyOnceWith(TENANT, undefined, 100, true)

    await expect(
      transport.read({
        resource: 'journals',
        targetBinding: binding,
        query: {offset: -1},
        call: 1,
      }),
    ).rejects.toMatchObject({reasonCode: 'QUERY_INVALID'})

    await expect(
      transport.read({
        resource: 'journals',
        targetBinding: binding,
        query: {paymentsOnly: 'yes'},
        call: 1,
      }),
    ).rejects.toMatchObject({reasonCode: 'QUERY_INVALID'})
  })

  it('forwards matching-lane where/order/page to the SDK exactly as signed', async () => {
    const identity = identityFor('bank-transactions')
    const client = fakeClient({bankTransactions: [{type: 'SPEND'}]})
    const getBankTransactions = vi.spyOn(client.accountingApi, 'getBankTransactions')
    const transport = createXeroLiveReadTransport(identity, depsFor(client))

    const page = await transport.read({
      resource: 'bank-transactions',
      targetBinding: createTargetBinding(identity),
      query: {where: 'Type=="SPEND"', order: 'Date', page: 2},
      call: 1,
    })
    expect(page.records).toEqual([{type: 'SPEND'}])
    // The receipt signs the query digest, so the signed values must be the
    // ones the SDK request actually carried.
    expect(getBankTransactions).toHaveBeenCalledExactlyOnceWith(TENANT, undefined, 'Type=="SPEND"', 'Date', 2)

    await expect(
      transport.read({
        resource: 'bank-transactions',
        targetBinding: createTargetBinding(identity),
        query: {page: 1.5},
        call: 1,
      }),
    ).rejects.toMatchObject({reasonCode: 'QUERY_INVALID'})
  })

  it('keeps the invoices page argument in the SDK position after the id filters', async () => {
    const identity = identityFor('invoices')
    const client = fakeClient({invoices: [{invoiceNumber: 'INV-0001'}]})
    const getInvoices = vi.spyOn(client.accountingApi, 'getInvoices')
    const transport = createXeroLiveReadTransport(identity, depsFor(client))

    await transport.read({
      resource: 'invoices',
      targetBinding: createTargetBinding(identity),
      query: {page: 3},
      call: 1,
    })
    expect(getInvoices).toHaveBeenCalledExactlyOnceWith(
      TENANT,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      3,
    )
  })

  it('rejects query keys the fetcher would silently ignore', async () => {
    const identity = identityFor('accounts')
    const transport = createXeroLiveReadTransport(identity, depsFor(fakeClient({accounts: [{code: '200'}]})))

    await expect(
      transport.read({
        resource: 'accounts',
        targetBinding: createTargetBinding(identity),
        query: {wheree: 'Code=="200"'},
        call: 1,
      }),
    ).rejects.toMatchObject({reasonCode: 'QUERY_INVALID'})

    await expect(
      transport.read({
        resource: 'accounts',
        targetBinding: createTargetBinding(identity),
        query: [],
        call: 1,
      }),
    ).rejects.toMatchObject({reasonCode: 'QUERY_INVALID'})
  })

  it('never lets the raw SDK response cross the seam', async () => {
    const identity = identityFor('accounts')
    const client = fakeClient({})
    client.accountingApi.getAccounts = async () => ({
      response: {headers: {authorization: 'Bearer raw-secret'}},
      body: {accounts: [new SyntheticAccount('200', 'Sales')], provider: 'xero'},
    })
    const transport = createXeroLiveReadTransport(identity, depsFor(client))

    const page = await transport.read({
      resource: 'accounts',
      targetBinding: createTargetBinding(identity),
      query: {},
      call: 1,
    })

    expect(page.records).toEqual([{code: '200', name: 'Sales'}])
  })

  it('withholds a live response carrying a raw tenant identifier', async () => {
    const identity = identityFor('bank-transactions')
    const client = fakeClient({})
    client.accountingApi.getBankTransactions = async () => ({
      body: {bankTransactions: [{type: 'SPEND', tenantId: 'raw-tenant-guid-must-not-leak'}]},
    })
    const transport = createXeroLiveReadTransport(identity, depsFor(client))

    await expect(
      transport.read({
        resource: 'bank-transactions',
        targetBinding: createTargetBinding(identity),
        query: {},
        call: 1,
      }),
    ).rejects.toMatchObject({reasonCode: 'RESPONSE_UNSAFE'})
  })

  it('answers a typed failure, not a stack overflow, for a pathologically deep live record', async () => {
    const identity = identityFor('accounts')
    let deep: Record<string, unknown> = {leaf: true}
    for (let i = 0; i < 3000; i++) deep = {child: deep}
    const client = fakeClient({})
    client.accountingApi.getAccounts = async () => ({body: {accounts: [deep]}})
    const transport = createXeroLiveReadTransport(identity, depsFor(client))

    await expect(
      transport.read({
        resource: 'accounts',
        targetBinding: createTargetBinding(identity),
        query: {},
        call: 1,
      }),
    ).rejects.toMatchObject({reasonCode: 'RESPONSE_UNSAFE'})
  })

  it('treats an absent record collection as a malformed response, not an empty read', async () => {
    const identity = identityFor('accounts')
    const client = fakeClient({})
    client.accountingApi.getAccounts = async () => ({body: {}})
    const transport = createXeroLiveReadTransport(identity, depsFor(client))

    await expect(
      transport.read({
        resource: 'accounts',
        targetBinding: createTargetBinding(identity),
        query: {},
        call: 1,
      }),
    ).rejects.toMatchObject({reasonCode: 'RESPONSE_INVALID'})

    const empty = createXeroLiveReadTransport(identity, depsFor(fakeClient({accounts: []})))
    const page = await empty.read({
      resource: 'accounts',
      targetBinding: createTargetBinding(identity),
      query: {},
      call: 1,
    })
    expect(page).toEqual({records: [], done: true})
  })

  it('maps unexpected SDK failures to a typed failure, not provider output', async () => {
    const identity = identityFor('accounts')
    const client = fakeClient({})
    client.accountingApi.getAccounts = async () => {
      throw new Error('response with token material')
    }
    const transport = createXeroLiveReadTransport(identity, depsFor(client))

    let failure: unknown
    try {
      await transport.read({
        resource: 'accounts',
        targetBinding: createTargetBinding(identity),
        query: {},
        call: 1,
      })
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(XeroLiveReadFailure)
    expect((failure as XeroLiveReadFailure).reasonCode).toBe('AUTH_FAILED')
    expect((failure as XeroLiveReadFailure).message).toBe('AUTH_FAILED')
  })

  it('completes an offline end-to-end read through executeRead with a signed receipt', async () => {
    const identity = identityFor('accounts')
    const sink = new InMemoryReadReceiptSink()
    const transport = createXeroLiveReadTransport(
      identity,
      depsFor(
        fakeClient({
          accounts: [new SyntheticAccount('200', 'Sales'), new SyntheticAccount('400', 'Rent')],
        }),
      ),
    )

    const result = await executeRead(
      {profileName: PROFILE, resource: 'accounts'},
      {identity, receiptSink: sink, now: NOW},
      transport,
    )

    expect(result.status).toBe('ok')
    expect(result.records).toEqual([
      {code: '200', name: 'Sales'},
      {code: '400', name: 'Rent'},
    ])
    expect(sink.receipts).toHaveLength(1)
    expect(sink.receipts[0].outcome).toBe('OK')
    expect(sink.receipts[0].recordCount).toBe(2)
  })
})
