import {XeroClient} from 'xero-node'
import {containsTenantIdentifier} from './data-hygiene.js'
import {createTargetBinding, sameBinding} from './identity.js'
import {READ_RESOURCES, type ReadTransport, type ReadTransportPage, type ReadTransportRequest} from './read.js'
import type {TargetBinding, TargetIdentity} from './types.js'
import {
  resolveLiveClient,
  XeroLiveSessionFailure,
  type XeroLiveSessionDependencies,
  type XeroLiveToken,
} from './xero-live-session.js'

export type XeroLiveReadFailureCode =
  | 'BINDING_MISMATCH'
  | 'RESOURCE_NOT_ALLOWED'
  | 'QUERY_INVALID'
  | 'CONFIG_MISSING'
  | 'TOKEN_MISSING'
  | 'TOKEN_DECRYPT_FAILED'
  | 'TOKEN_INVALID'
  | 'TOKEN_NEAR_EXPIRY'
  | 'TENANT_MISMATCH'
  | 'AUTH_FAILED'
  | 'RESPONSE_INVALID'
  | 'RESPONSE_UNSAFE'

/** Internal typed boundary; its message is a reason code, never provider output. */
export class XeroLiveReadFailure extends Error {
  readonly reasonCode: XeroLiveReadFailureCode

  constructor(reasonCode: XeroLiveReadFailureCode) {
    super(reasonCode)
    this.name = 'XeroLiveReadFailure'
    this.reasonCode = reasonCode
  }
}

export type XeroLiveReadToken = XeroLiveToken

/**
 * The slice of the Xero SDK the adapter touches. Method shapes follow
 * xero-node's AccountingApi; extra optional SDK parameters are compatible by
 * structural typing.
 */
export interface XeroLiveReadClient {
  setTokenSet(tokenSet: {access_token: string}): void
  readonly accountingApi: {
    getAccounts(tenantId: string, ifModifiedSince?: Date, where?: string, order?: string): Promise<unknown>
    getContacts(
      tenantId: string,
      ifModifiedSince?: Date,
      where?: string,
      order?: string,
      iDs?: string[],
      page?: number,
    ): Promise<unknown>
    getCurrencies(tenantId: string, where?: string, order?: string): Promise<unknown>
    getTaxRates(tenantId: string, where?: string, order?: string): Promise<unknown>
    getReportProfitAndLoss(tenantId: string, fromDate?: string, toDate?: string): Promise<unknown>
    getReportBalanceSheet(tenantId: string, date?: string): Promise<unknown>
    getReportTrialBalance(tenantId: string, date?: string): Promise<unknown>
    getReportAgedReceivablesByContact(
      tenantId: string,
      contactId: string,
      date?: string,
      fromDate?: string,
      toDate?: string,
    ): Promise<unknown>
    getReportAgedPayablesByContact(
      tenantId: string,
      contactId: string,
      date?: string,
      fromDate?: string,
      toDate?: string,
    ): Promise<unknown>
    getJournals(tenantId: string, ifModifiedSince?: Date, offset?: number, paymentsOnly?: boolean): Promise<unknown>
    getBankTransactions(
      tenantId: string,
      ifModifiedSince?: Date,
      where?: string,
      order?: string,
      page?: number,
    ): Promise<unknown>
    getPayments(
      tenantId: string,
      ifModifiedSince?: Date,
      where?: string,
      order?: string,
      page?: number,
    ): Promise<unknown>
    getInvoices(
      tenantId: string,
      ifModifiedSince?: Date,
      where?: string,
      order?: string,
      iDs?: string[],
      invoiceNumbers?: string[],
      contactIDs?: string[],
      statuses?: string[],
      page?: number,
    ): Promise<unknown>
    getCreditNotes(
      tenantId: string,
      ifModifiedSince?: Date,
      where?: string,
      order?: string,
      page?: number,
    ): Promise<unknown>
    getManualJournals(
      tenantId: string,
      ifModifiedSince?: Date,
      where?: string,
      order?: string,
      page?: number,
    ): Promise<unknown>
  }
}

export type XeroLiveReadDependencies = XeroLiveSessionDependencies<XeroLiveReadClient>

/**
 * Build the live, target-bound, redacted READ adapter (Tier 0) behind the
 * read contract's ADR-0003 seam. It is constructed bound to exactly one
 * verified target identity and throws on any other binding; credentials stay
 * inside, and only plain-JSON record arrays cross back — never the raw SDK
 * response, headers, or token material.
 *
 * Each execution fetches one page: every fetcher answers `done: true`, so
 * pagination (contacts `page`) advances via explicit query parameters across
 * separate receipted reads, never by an adapter loop.
 */
export function createXeroLiveReadTransport(
  identity: TargetIdentity,
  dependencies: XeroLiveReadDependencies = {},
): ReadTransport {
  const binding = createTargetBinding(identity)
  const tenantId = identity.tenantId
  const profileName = identity.profileName

  return {
    binding,
    async read(input: ReadTransportRequest): Promise<ReadTransportPage> {
      requireOwnBinding(binding, input.targetBinding)
      if (input.resource !== binding.resource) throw new XeroLiveReadFailure('BINDING_MISMATCH')
      const fetcher = RESOURCE_FETCHERS[input.resource]
      if (!fetcher) throw new XeroLiveReadFailure('RESOURCE_NOT_ALLOWED')

      let client: XeroLiveReadClient
      try {
        client = await resolveLiveClient({
          profileName,
          tenantId,
          dependencies,
          createDefaultClient: clientId =>
            new XeroClient({clientId, clientSecret: ''}) as unknown as XeroLiveReadClient,
        })
      } catch (error) {
        if (error instanceof XeroLiveSessionFailure) throw new XeroLiveReadFailure(error.reasonCode)
        throw new XeroLiveReadFailure('AUTH_FAILED')
      }

      const query = requireQueryRecord(input.resource, input.query)

      let response: unknown
      try {
        response = await fetcher(client, tenantId, query)
      } catch (error) {
        if (error instanceof XeroLiveReadFailure) throw error
        throw new XeroLiveReadFailure('AUTH_FAILED')
      }

      return {records: redactRecords(response), done: true}
    },
  }
}

type ResourceFetcher = (
  client: XeroLiveReadClient,
  tenantId: string,
  query: Record<string, unknown>,
) => Promise<{body: unknown; field: string}>

const RESOURCE_FETCHERS: Readonly<Record<string, ResourceFetcher>> = {
  accounts: async (client, tenantId, query) => ({
    body: await client.accountingApi.getAccounts(tenantId, undefined, str(query, 'where'), str(query, 'order')),
    field: 'accounts',
  }),
  contacts: async (client, tenantId, query) => ({
    body: await client.accountingApi.getContacts(
      tenantId,
      undefined,
      str(query, 'where'),
      str(query, 'order'),
      undefined,
      int(query, 'page'),
    ),
    field: 'contacts',
  }),
  currencies: async (client, tenantId, query) => ({
    body: await client.accountingApi.getCurrencies(tenantId, str(query, 'where'), str(query, 'order')),
    field: 'currencies',
  }),
  'tax-rates': async (client, tenantId, query) => ({
    body: await client.accountingApi.getTaxRates(tenantId, str(query, 'where'), str(query, 'order')),
    field: 'taxRates',
  }),
  'report-profit-and-loss': async (client, tenantId, query) => ({
    body: await client.accountingApi.getReportProfitAndLoss(tenantId, str(query, 'fromDate'), str(query, 'toDate')),
    field: 'reports',
  }),
  'report-balance-sheet': async (client, tenantId, query) => ({
    body: await client.accountingApi.getReportBalanceSheet(tenantId, str(query, 'date')),
    field: 'reports',
  }),
  'report-trial-balance': async (client, tenantId, query) => ({
    body: await client.accountingApi.getReportTrialBalance(tenantId, str(query, 'date')),
    field: 'reports',
  }),
  'report-aged-receivables': async (client, tenantId, query) => ({
    body: await client.accountingApi.getReportAgedReceivablesByContact(
      tenantId,
      requireStr(query, 'contactId'),
      str(query, 'date'),
      str(query, 'fromDate'),
      str(query, 'toDate'),
    ),
    field: 'reports',
  }),
  'report-aged-payables': async (client, tenantId, query) => ({
    body: await client.accountingApi.getReportAgedPayablesByContact(
      tenantId,
      requireStr(query, 'contactId'),
      str(query, 'date'),
      str(query, 'fromDate'),
      str(query, 'toDate'),
    ),
    field: 'reports',
  }),
  journals: async (client, tenantId, query) => ({
    body: await client.accountingApi.getJournals(
      tenantId,
      undefined,
      int(query, 'offset'),
      bool(query, 'paymentsOnly'),
    ),
    field: 'journals',
  }),
  'bank-transactions': async (client, tenantId, query) => ({
    body: await client.accountingApi.getBankTransactions(
      tenantId,
      undefined,
      str(query, 'where'),
      str(query, 'order'),
      int(query, 'page'),
    ),
    field: 'bankTransactions',
  }),
  payments: async (client, tenantId, query) => ({
    body: await client.accountingApi.getPayments(
      tenantId,
      undefined,
      str(query, 'where'),
      str(query, 'order'),
      int(query, 'page'),
    ),
    field: 'payments',
  }),
  invoices: async (client, tenantId, query) => ({
    body: await client.accountingApi.getInvoices(
      tenantId,
      undefined,
      str(query, 'where'),
      str(query, 'order'),
      undefined,
      undefined,
      undefined,
      undefined,
      int(query, 'page'),
    ),
    field: 'invoices',
  }),
  'credit-notes': async (client, tenantId, query) => ({
    body: await client.accountingApi.getCreditNotes(
      tenantId,
      undefined,
      str(query, 'where'),
      str(query, 'order'),
      int(query, 'page'),
    ),
    field: 'creditNotes',
  }),
  'manual-journals': async (client, tenantId, query) => ({
    body: await client.accountingApi.getManualJournals(
      tenantId,
      undefined,
      str(query, 'where'),
      str(query, 'order'),
      int(query, 'page'),
    ),
    field: 'manualJournals',
  }),
}

/**
 * The exact query keys each fetcher honors. The read receipt signs the query,
 * so a key a fetcher would silently ignore must be rejected instead — a signed
 * "filtered" query over an unfiltered request would be a false receipt.
 */
const QUERY_KEYS: Readonly<Record<string, readonly string[]>> = {
  accounts: ['where', 'order'],
  contacts: ['where', 'order', 'page'],
  currencies: ['where', 'order'],
  'tax-rates': ['where', 'order'],
  'report-profit-and-loss': ['fromDate', 'toDate'],
  'report-balance-sheet': ['date'],
  'report-trial-balance': ['date'],
  'report-aged-receivables': ['contactId', 'date', 'fromDate', 'toDate'],
  'report-aged-payables': ['contactId', 'date', 'fromDate', 'toDate'],
  journals: ['offset', 'paymentsOnly'],
  'bank-transactions': ['where', 'order', 'page'],
  payments: ['where', 'order', 'page'],
  invoices: ['where', 'order', 'page'],
  'credit-notes': ['where', 'order', 'page'],
  'manual-journals': ['where', 'order', 'page'],
}

// The adapter's allowlist and the contract's must not drift apart.
for (const resource of Object.keys(READ_RESOURCES)) {
  if (!Object.hasOwn(RESOURCE_FETCHERS, resource) || !Object.hasOwn(QUERY_KEYS, resource)) {
    throw new TypeError(`xero-live-read is missing a fetcher or query schema for read resource ${resource}`)
  }
}

function requireOwnBinding(own: TargetBinding, offered: TargetBinding): void {
  if (!offered || typeof offered !== 'object' || !sameBinding(own, offered)) {
    throw new XeroLiveReadFailure('BINDING_MISMATCH')
  }
}

/**
 * Reduce a fetcher result to plain-JSON records: take only the named array
 * from the response body and round-trip it through JSON so no SDK class
 * instance, header, or request context survives the seam.
 */
function redactRecords(result: unknown): readonly unknown[] {
  if (!result || typeof result !== 'object') throw new XeroLiveReadFailure('RESPONSE_INVALID')
  const {body, field} = result as {body: unknown; field: string}
  if (!body || typeof body !== 'object') throw new XeroLiveReadFailure('RESPONSE_INVALID')
  const inner = (body as Record<string, unknown>).body
  if (!inner || typeof inner !== 'object') throw new XeroLiveReadFailure('RESPONSE_INVALID')
  const records = (inner as Record<string, unknown>)[field]
  // An absent collection is a malformed response, never a successful empty
  // read: a genuinely empty resource still answers with an empty array.
  if (!Array.isArray(records)) throw new XeroLiveReadFailure('RESPONSE_INVALID')
  let plain: unknown
  try {
    plain = JSON.parse(JSON.stringify(records))
  } catch {
    throw new XeroLiveReadFailure('RESPONSE_INVALID')
  }
  if (!Array.isArray(plain)) throw new XeroLiveReadFailure('RESPONSE_INVALID')
  // The same tenant-identifier boundary the fixture transport enforces: a raw
  // tenant id in a released record would undo the fingerprints-only binding
  // redaction the receipt attests to.
  if (containsTenantIdentifier(plain)) throw new XeroLiveReadFailure('RESPONSE_UNSAFE')
  return plain
}

/** The signed query must be exactly what the fetcher honors: plain object, known keys only. */
function requireQueryRecord(resource: string, query: unknown): Record<string, unknown> {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    throw new XeroLiveReadFailure('QUERY_INVALID')
  }
  const allowed = QUERY_KEYS[resource] ?? []
  const record = query as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new XeroLiveReadFailure('QUERY_INVALID')
  }
  return record
}

function str(query: Record<string, unknown>, key: string): string | undefined {
  const value = query[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') throw new XeroLiveReadFailure('QUERY_INVALID')
  return value
}

function requireStr(query: Record<string, unknown>, key: string): string {
  const value = str(query, key)
  if (value === undefined) throw new XeroLiveReadFailure('QUERY_INVALID')
  return value
}

function int(query: Record<string, unknown>, key: string): number | undefined {
  const value = query[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new XeroLiveReadFailure('QUERY_INVALID')
  }
  return value
}

function bool(query: Record<string, unknown>, key: string): boolean | undefined {
  const value = query[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new XeroLiveReadFailure('QUERY_INVALID')
  return value
}
