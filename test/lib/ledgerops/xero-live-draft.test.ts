import {describe, expect, it, vi} from 'vitest'
import {
  confirmationTokenFor,
  createMutationPlan,
  createTargetBinding,
  createTargetIdentity,
  createXeroLiveDraftTransport,
  DRAFT_DISPATCH_RESOURCES,
  executeMutation,
  InMemoryReceiptSink,
  XeroLiveDraftFailure,
  type XeroLiveDraftClient,
} from '../../../src/lib/ledgerops/index.js'

const NOW = Date.parse('2026-08-07T00:00:00.000Z')
const PROFILE = 'synthetic-draft-profile'
const TENANT = 'synthetic-draft-tenant-guid'
const INVOICE_ID = 'synthetic-invoice-guid-0001'
const JOURNAL_ID = 'synthetic-journal-guid-0001'

const DRAFT_INVOICE = {
  type: 'ACCPAY',
  status: 'DRAFT',
  reference: 'synthetic-draft-bill',
  lineItems: [{description: 'Cleaning', quantity: 1, unitAmount: '80.00', accountCode: '400'}],
}

function identityFor(resource: string) {
  return createTargetIdentity({
    profileName: PROFILE,
    tenantId: TENANT,
    resource,
    isDemoCompany: true,
    observedAt: NOW,
    freshUntil: NOW + 60_000,
    capabilities: ['draft.create'],
    scopes: ['accounting.invoices'],
  })
}

function fakeDraftClient(overrides: Partial<XeroLiveDraftClient['accountingApi']> = {}): XeroLiveDraftClient {
  return {
    setTokenSet: vi.fn(),
    accountingApi: {
      createInvoices: vi.fn(async (_tenant: string, body: {invoices: unknown[]}) => ({
        body: {invoices: [{...(body.invoices[0] as object), invoiceID: INVOICE_ID}]},
      })),
      getInvoice: vi.fn(async () => ({
        body: {invoices: [{...DRAFT_INVOICE, invoiceID: INVOICE_ID}]},
      })),
      createManualJournals: vi.fn(async (_tenant: string, body: {manualJournals: unknown[]}) => ({
        body: {manualJournals: [{...(body.manualJournals[0] as object), manualJournalID: JOURNAL_ID}]},
      })),
      getManualJournal: vi.fn(async () => ({
        body: {manualJournals: [{narration: 'synthetic', status: 'DRAFT', manualJournalID: JOURNAL_ID}]},
      })),
      ...overrides,
    },
  }
}

function depsFor(client: XeroLiveDraftClient, overrides: Record<string, unknown> = {}) {
  return {
    fileExists: () => true,
    readClientId: () => 'synthetic-client-id',
    readTokenSet: vi.fn(() => ({
      accessToken: 'synthetic-access-token-value',
      expiresAt: NOW + 30 * 60_000,
      tenantId: TENANT,
    })),
    createClient: () => client,
    now: () => NOW,
    ...overrides,
  }
}

function dispatchRequest(identity = identityFor('invoices'), payload: unknown = DRAFT_INVOICE) {
  return {
    operation: 'create' as const,
    payload: payload as never,
    targetBinding: createTargetBinding(identity),
    planDigest: 'a'.repeat(64),
  }
}

describe('xero live DRAFT transport', () => {
  it('allowlists exactly the DRAFT-capable resources', () => {
    expect([...DRAFT_DISPATCH_RESOURCES]).toEqual(['invoices', 'manual-journals'])
  })

  it('throws on a binding it was not constructed for', async () => {
    const identity = identityFor('invoices')
    const other = identityFor('manual-journals')
    const transport = createXeroLiveDraftTransport(identity, depsFor(fakeDraftClient()))

    await expect(transport.dispatch(dispatchRequest(other))).rejects.toMatchObject({reasonCode: 'BINDING_MISMATCH'})
    await expect(
      transport.readBack({targetBinding: createTargetBinding(other), planDigest: 'a'.repeat(64)}),
    ).rejects.toMatchObject({reasonCode: 'BINDING_MISMATCH'})
  })

  it('refuses resources outside the DRAFT allowlist and operations other than create', async () => {
    const accounts = identityFor('accounts')
    const client = fakeDraftClient()
    const accountsTransport = createXeroLiveDraftTransport(accounts, depsFor(client))
    await expect(accountsTransport.dispatch(dispatchRequest(accounts))).rejects.toMatchObject({
      reasonCode: 'RESOURCE_NOT_ALLOWED',
    })

    const invoices = identityFor('invoices')
    const transport = createXeroLiveDraftTransport(invoices, depsFor(client))
    await expect(transport.dispatch({...dispatchRequest(invoices), operation: 'update'})).rejects.toMatchObject({
      reasonCode: 'OPERATION_NOT_ALLOWED',
    })
    expect(client.accountingApi.createInvoices).not.toHaveBeenCalled()
  })

  it('refuses every non-DRAFT payload shape before credentials are even read', async () => {
    const identity = identityFor('invoices')
    const client = fakeDraftClient()
    const deps = depsFor(client)
    const transport = createXeroLiveDraftTransport(identity, deps)

    const refusals: Array<[unknown, string]> = [
      [null, 'PAYLOAD_NOT_DRAFT'],
      [['DRAFT'], 'PAYLOAD_NOT_DRAFT'],
      [{type: 'ACCPAY'}, 'PAYLOAD_NOT_DRAFT'],
      [{...DRAFT_INVOICE, status: 'AUTHORISED'}, 'PAYLOAD_NOT_DRAFT'],
      [{...DRAFT_INVOICE, nested: {status: 'SUBMITTED'}}, 'PAYLOAD_NOT_DRAFT'],
      [{...DRAFT_INVOICE, note: {accessToken: 'x'}}, 'PAYLOAD_UNSAFE'],
      [{...DRAFT_INVOICE, tenantId: 'raw-tenant'}, 'PAYLOAD_UNSAFE'],
    ]
    for (const [payload, reasonCode] of refusals) {
      await expect(transport.dispatch(dispatchRequest(identity, payload))).rejects.toMatchObject({reasonCode})
    }
    // A payload deeper than the scan bound is refused (the hygiene scan
    // flags it unsafe before the DRAFT scan runs), never trusted.
    let deep: Record<string, unknown> = {status: 'DRAFT'}
    for (let i = 0; i < 200; i++) deep = {status: 'DRAFT', child: deep}
    await expect(transport.dispatch(dispatchRequest(identity, deep))).rejects.toMatchObject({
      reasonCode: 'PAYLOAD_UNSAFE',
    })

    expect(deps.readTokenSet).not.toHaveBeenCalled()
    expect(client.accountingApi.createInvoices).not.toHaveBeenCalled()
  })

  it('never dispatches the same plan digest twice, even after a failed remote call', async () => {
    const identity = identityFor('invoices')
    const failing = fakeDraftClient({
      createInvoices: vi.fn(async () => {
        throw new Error('socket hang up mid-request')
      }),
    })
    const transport = createXeroLiveDraftTransport(identity, depsFor(failing))

    await expect(transport.dispatch(dispatchRequest(identity))).rejects.toMatchObject({reasonCode: 'DISPATCH_FAILED'})
    // Server-side state is unknown; the digest is burned and never re-sent.
    await expect(transport.dispatch(dispatchRequest(identity))).rejects.toMatchObject({
      reasonCode: 'DUPLICATE_DISPATCH',
    })
    expect(failing.accountingApi.createInvoices).toHaveBeenCalledTimes(1)

    const succeeding = fakeDraftClient()
    const second = createXeroLiveDraftTransport(identity, depsFor(succeeding))
    await expect(second.dispatch(dispatchRequest(identity))).resolves.toEqual({accepted: true})
    await expect(second.dispatch(dispatchRequest(identity))).rejects.toMatchObject({reasonCode: 'DUPLICATE_DISPATCH'})
    expect(succeeding.accountingApi.createInvoices).toHaveBeenCalledTimes(1)
  })

  it('lets exactly one of two concurrent dispatches of the same digest reach the remote', async () => {
    const identity = identityFor('invoices')
    const client = fakeDraftClient()
    // Credential resolution suspends, so both dispatches would sit past the
    // duplicate check together if the digest were burned after the await.
    const deps = depsFor(client, {
      readTokenSet: vi.fn(async () => {
        await new Promise(resolve => setTimeout(resolve, 5))
        return {accessToken: 'synthetic-access-token-value', expiresAt: NOW + 30 * 60_000, tenantId: TENANT}
      }),
    })
    const transport = createXeroLiveDraftTransport(identity, deps)

    const outcomes = await Promise.allSettled([
      transport.dispatch(dispatchRequest(identity)),
      transport.dispatch(dispatchRequest(identity)),
    ])
    const accepted = outcomes.filter(o => o.status === 'fulfilled')
    const refused = outcomes.filter(
      o => o.status === 'rejected' && (o.reason as XeroLiveDraftFailure).reasonCode === 'DUPLICATE_DISPATCH',
    )
    expect(accepted).toHaveLength(1)
    expect(refused).toHaveLength(1)
    expect(client.accountingApi.createInvoices).toHaveBeenCalledTimes(1)
  })

  it('reads back only plans it dispatched, from the id the create response named', async () => {
    const identity = identityFor('invoices')
    const client = fakeDraftClient()
    const transport = createXeroLiveDraftTransport(identity, depsFor(client))
    const binding = createTargetBinding(identity)

    await expect(transport.readBack({targetBinding: binding, planDigest: 'b'.repeat(64)})).rejects.toMatchObject({
      reasonCode: 'UNKNOWN_PLAN',
    })
    expect(client.accountingApi.getInvoice).not.toHaveBeenCalled()

    await transport.dispatch(dispatchRequest(identity))
    // The plan digest rides as Xero's idempotency key: remote-side dedupe
    // holds even when a fresh process reconstructs the adapter and re-sends.
    expect(client.accountingApi.createInvoices).toHaveBeenCalledExactlyOnceWith(
      TENANT,
      {invoices: [DRAFT_INVOICE]},
      false,
      undefined,
      'a'.repeat(64),
    )
    const result = await transport.readBack({targetBinding: binding, planDigest: 'a'.repeat(64)})
    expect(client.accountingApi.getInvoice).toHaveBeenCalledExactlyOnceWith(TENANT, INVOICE_ID)
    expect(result).toEqual({
      status: 'found',
      records: [{...DRAFT_INVOICE, invoiceID: INVOICE_ID}],
    })
  })

  it('classifies a vanished draft as missing and an unreadable one as a typed failure', async () => {
    const identity = identityFor('invoices')
    // xero-node rejects HTTP failures as JSON.stringify of the generated
    // error object, so a real 404 arrives as this string, not an Error.
    const notFound = JSON.stringify({
      response: {statusCode: 404, body: {}, headers: {}, request: {}},
      body: {},
    })
    const client = fakeDraftClient({
      getInvoice: vi.fn(async () => {
        throw notFound
      }),
    })
    const transport = createXeroLiveDraftTransport(identity, depsFor(client))
    const binding = createTargetBinding(identity)
    await transport.dispatch(dispatchRequest(identity))
    await expect(transport.readBack({targetBinding: binding, planDigest: 'a'.repeat(64)})).resolves.toEqual({
      status: 'missing',
    })

    const broken = fakeDraftClient({
      getInvoice: vi.fn(async () => {
        throw new Error('gateway timeout')
      }),
    })
    const second = createXeroLiveDraftTransport(identity, depsFor(broken))
    await second.dispatch(dispatchRequest(identity))
    await expect(second.readBack({targetBinding: binding, planDigest: 'a'.repeat(64)})).rejects.toMatchObject({
      reasonCode: 'READBACK_FAILED',
    })
  })

  it('rejects malformed or ceiling-breaking create responses', async () => {
    const identity = identityFor('invoices')
    const cases: Array<[unknown, string]> = [
      [{body: {}}, 'RESPONSE_INVALID'],
      [{body: {invoices: []}}, 'RESPONSE_INVALID'],
      [{body: {invoices: [{}, {}]}}, 'RESPONSE_INVALID'],
      [{body: {invoices: [{status: 'DRAFT'}]}}, 'RESPONSE_INVALID'],
      [{body: {invoices: [{status: 'AUTHORISED', invoiceID: INVOICE_ID}]}}, 'RESPONSE_NOT_DRAFT'],
      [{body: {invoices: [{status: 'DRAFT', invoiceID: INVOICE_ID, tenantId: 'raw'}]}}, 'RESPONSE_UNSAFE'],
    ]
    for (const [response, reasonCode] of cases) {
      const client = fakeDraftClient({createInvoices: vi.fn(async () => response)})
      const transport = createXeroLiveDraftTransport(identity, depsFor(client))
      await expect(transport.dispatch(dispatchRequest(identity))).rejects.toMatchObject({reasonCode})
    }
  })

  it('maps credential failures to typed session codes', async () => {
    const identity = identityFor('invoices')
    const client = fakeDraftClient()

    const noConfig = createXeroLiveDraftTransport(identity, depsFor(client, {fileExists: () => false}))
    await expect(noConfig.dispatch(dispatchRequest(identity))).rejects.toMatchObject({reasonCode: 'CONFIG_MISSING'})

    const wrongTenant = createXeroLiveDraftTransport(
      identity,
      depsFor(client, {
        readTokenSet: () => ({accessToken: 'synthetic', expiresAt: NOW + 30 * 60_000, tenantId: 'other-tenant'}),
      }),
    )
    await expect(wrongTenant.dispatch(dispatchRequest(identity))).rejects.toMatchObject({reasonCode: 'TENANT_MISMATCH'})
    expect(client.accountingApi.createInvoices).not.toHaveBeenCalled()
  })

  it('completes a guarded DRAFT mutation end to end as VERIFIED, and never re-dispatches', async () => {
    const identity = identityFor('manual-journals')
    const readBackRecord = {narration: 'synthetic', status: 'DRAFT', manualJournalID: JOURNAL_ID}
    const client = fakeDraftClient()
    const transport = createXeroLiveDraftTransport(identity, depsFor(client))
    const payload = {narration: 'synthetic', status: 'DRAFT'}
    const plan = createMutationPlan({
      planId: 'draft-transport-plan',
      profileName: PROFILE,
      resource: 'manual-journals',
      operation: 'create',
      target: identity,
      payload,
      requiredCapabilities: ['draft.create'],
      requiredScopes: ['accounting.invoices'],
      readBack: {expected: readBackRecord},
      createdAt: NOW,
      expiresAt: NOW + 120_000,
    })
    const request = {
      profileName: PROFILE,
      resource: 'manual-journals',
      operation: 'create' as const,
      payload,
      objectCount: 1 as const,
      readBackExpectation: plan.readBackExpectation,
    }
    const sink = new InMemoryReceiptSink()

    const result = await executeMutation({
      request,
      plan,
      confirmation: confirmationTokenFor(plan),
      context: {profileName: PROFILE, identity, receiptSink: sink, now: NOW + 1},
      transport,
      now: NOW + 1,
    })

    expect(result.outcome).toBe('VERIFIED')
    expect(result.receipt.dispatchState).toBe('accepted')
    expect(result.receipt.readBackClassification).toBe('verified')
    expect(sink.intents).toHaveLength(1)
    expect(sink.receipts).toHaveLength(1)
    expect(client.accountingApi.createManualJournals).toHaveBeenCalledTimes(1)

    // A caller looping outside the kernel cannot make this plan land twice:
    // the adapter burns the digest, so the rerun terminates UNCERTAIN.
    const rerun = await executeMutation({
      request,
      plan,
      confirmation: confirmationTokenFor(plan),
      context: {profileName: PROFILE, identity, receiptSink: sink, now: NOW + 2},
      transport,
      now: NOW + 2,
    })
    expect(rerun.outcome).toBe('UNCERTAIN')
    expect(rerun.receipt.reasonCode).toBe('DISPATCH_UNCERTAIN')
    expect(client.accountingApi.createManualJournals).toHaveBeenCalledTimes(1)
  })

  it('terminates UNCERTAIN, not verified, when the read-back cannot confirm the draft', async () => {
    const identity = identityFor('invoices')
    const ambiguous = fakeDraftClient({
      getInvoice: vi.fn(async () => {
        throw new Error('gateway timeout')
      }),
    })
    const transport = createXeroLiveDraftTransport(identity, depsFor(ambiguous))
    const plan = createMutationPlan({
      planId: 'draft-transport-uncertain',
      profileName: PROFILE,
      resource: 'invoices',
      operation: 'create',
      target: identity,
      payload: DRAFT_INVOICE,
      requiredCapabilities: ['draft.create'],
      requiredScopes: ['accounting.invoices'],
      readBack: {expected: {...DRAFT_INVOICE, invoiceID: INVOICE_ID}},
      createdAt: NOW,
      expiresAt: NOW + 120_000,
    })
    const sink = new InMemoryReceiptSink()

    const result = await executeMutation({
      request: {
        profileName: PROFILE,
        resource: 'invoices',
        operation: 'create' as const,
        payload: DRAFT_INVOICE,
        objectCount: 1 as const,
        readBackExpectation: plan.readBackExpectation,
      },
      plan,
      confirmation: confirmationTokenFor(plan),
      context: {profileName: PROFILE, identity, receiptSink: sink, now: NOW + 1},
      transport,
      now: NOW + 1,
    })

    expect(result.outcome).toBe('UNCERTAIN')
    expect(result.receipt.reasonCode).toBe('READBACK_UNCERTAIN')
    expect(result.receipt.dispatchState).toBe('accepted')
  })

  it('is a XeroLiveDraftFailure with a reason-code message, never provider output', async () => {
    const identity = identityFor('invoices')
    const transport = createXeroLiveDraftTransport(
      identity,
      depsFor(
        fakeDraftClient({
          createInvoices: vi.fn(async () => {
            throw new Error('response body with token material')
          }),
        }),
      ),
    )

    let failure: unknown
    try {
      await transport.dispatch(dispatchRequest(identity))
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(XeroLiveDraftFailure)
    expect((failure as XeroLiveDraftFailure).message).toBe('DISPATCH_FAILED')
  })
})
