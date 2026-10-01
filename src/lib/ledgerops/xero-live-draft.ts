import {XeroClient} from 'xero-node'
import {containsSecretShapedData, containsTenantIdentifier} from './data-hygiene.js'
import {createTargetBinding, sameBinding} from './identity.js'
import type {
  MutationTransport,
  TargetBinding,
  TargetIdentity,
  TransportDispatchRequest,
  TransportDispatchResult,
  TransportReadBackRequest,
  ReadBackTransportResult,
} from './types.js'
import {
  resolveLiveClient,
  XeroLiveSessionFailure,
  type XeroLiveSessionDependencies,
  type XeroLiveSessionFailureCode,
} from './xero-live-session.js'

const MAX_STATUS_SCAN_DEPTH = 64

export type XeroLiveDraftFailureCode =
  | XeroLiveSessionFailureCode
  | 'BINDING_MISMATCH'
  | 'RESOURCE_NOT_ALLOWED'
  | 'OPERATION_NOT_ALLOWED'
  | 'PAYLOAD_NOT_DRAFT'
  | 'PAYLOAD_UNSAFE'
  | 'DUPLICATE_DISPATCH'
  | 'DISPATCH_FAILED'
  | 'UNKNOWN_PLAN'
  | 'READBACK_FAILED'
  | 'RESPONSE_INVALID'
  | 'RESPONSE_NOT_DRAFT'
  | 'RESPONSE_UNSAFE'

/** Internal typed boundary; its message is a reason code, never provider output. */
export class XeroLiveDraftFailure extends Error {
  readonly reasonCode: XeroLiveDraftFailureCode

  constructor(reasonCode: XeroLiveDraftFailureCode) {
    super(reasonCode)
    this.name = 'XeroLiveDraftFailure'
    this.reasonCode = reasonCode
  }
}

/**
 * The slice of the Xero SDK the DRAFT adapter touches. Method shapes follow
 * xero-node's AccountingApi; extra optional SDK parameters are compatible by
 * structural typing.
 */
export interface XeroLiveDraftClient {
  setTokenSet(tokenSet: {access_token: string}): void
  readonly accountingApi: {
    createInvoices(
      tenantId: string,
      invoices: {invoices: unknown[]},
      summarizeErrors?: boolean,
      unitdp?: number,
      idempotencyKey?: string,
    ): Promise<unknown>
    getInvoice(tenantId: string, invoiceID: string): Promise<unknown>
    createManualJournals(
      tenantId: string,
      manualJournals: {manualJournals: unknown[]},
      summarizeErrors?: boolean,
      idempotencyKey?: string,
    ): Promise<unknown>
    getManualJournal(tenantId: string, manualJournalID: string): Promise<unknown>
  }
}

export type XeroLiveDraftDependencies = XeroLiveSessionDependencies<XeroLiveDraftClient> & {
  /** Internal batch seam: observation and dispatch share this fixed client. */
  readonly boundClient?: XeroLiveDraftClient
}

/** Internal factory keeps SDK construction inside the live adapter boundary. */
export function createLiveDraftClient(clientId: string): XeroLiveDraftClient {
  return new XeroClient({clientId, clientSecret: ''}) as unknown as XeroLiveDraftClient
}

interface DraftResourceSpec {
  readonly collection: string
  readonly idField: string
  create(client: XeroLiveDraftClient, tenantId: string, payload: unknown, idempotencyKey: string): Promise<unknown>
  fetch(client: XeroLiveDraftClient, tenantId: string, id: string): Promise<unknown>
}

/**
 * The DRAFT dispatch allowlist: the only resources the Tier 1 lane may write,
 * and for each the single-object create call and the by-id read-back fetch.
 * `summarizeErrors` stays false so a validation failure surfaces as a thrown
 * SDK error (dispatch UNCERTAIN), never as a silently-annotated element. The
 * plan digest rides as Xero's idempotency key, so even a re-send from a fresh
 * process cannot create the draft twice remote-side.
 */
const DRAFT_RESOURCES: Readonly<Record<string, DraftResourceSpec>> = {
  invoices: {
    collection: 'invoices',
    idField: 'invoiceID',
    create: async (client, tenantId, payload, idempotencyKey) =>
      client.accountingApi.createInvoices(tenantId, {invoices: [payload]}, false, undefined, idempotencyKey),
    fetch: async (client, tenantId, id) => client.accountingApi.getInvoice(tenantId, id),
  },
  'manual-journals': {
    collection: 'manualJournals',
    idField: 'manualJournalID',
    create: async (client, tenantId, payload, idempotencyKey) =>
      client.accountingApi.createManualJournals(tenantId, {manualJournals: [payload]}, false, idempotencyKey),
    fetch: async (client, tenantId, id) => client.accountingApi.getManualJournal(tenantId, id),
  },
}

export const DRAFT_DISPATCH_RESOURCES: readonly string[] = Object.freeze(Object.keys(DRAFT_RESOURCES).sort())

/**
 * Build the live DRAFT-only mutation adapter (Tier 1 ceiling, ADR-0006)
 * behind the ADR-0003 seam. It is constructed bound to exactly one verified
 * target identity and throws on any other binding; credentials stay inside,
 * and it refuses to dispatch anything that is not one explicit DRAFT-state
 * object:
 *
 * - only allowlisted resources (DRAFT invoices/bills, draft manual journals)
 *   and only the `create` operation;
 * - the payload must declare `status: 'DRAFT'` at the top level, and every
 *   nested `status` key must also read DRAFT — the ceiling cannot be smuggled
 *   past in a sub-object;
 * - one dispatch per plan digest, ever: the digest is burned before the
 *   remote call, so even a failed call can never be re-sent through this
 *   adapter (the kernel's no-retry rule, enforced on both sides of the seam);
 * - read-back answers only for plan digests this adapter dispatched, from the
 *   remote id the create response named — never by searching.
 */
export function createXeroLiveDraftTransport(
  identity: TargetIdentity,
  dependencies: XeroLiveDraftDependencies = {},
): MutationTransport {
  const binding = createTargetBinding(identity)
  const tenantId = identity.tenantId
  const profileName = identity.profileName
  const dispatchedDigests = new Set<string>()
  const locators = new Map<string, string>()

  const resolveClient = async (): Promise<XeroLiveDraftClient> => {
    if (dependencies.boundClient) return dependencies.boundClient
    try {
      return await resolveLiveClient({
        profileName,
        tenantId,
        dependencies,
        createDefaultClient: clientId => new XeroClient({clientId, clientSecret: ''}) as unknown as XeroLiveDraftClient,
      })
    } catch (error) {
      if (error instanceof XeroLiveSessionFailure) throw new XeroLiveDraftFailure(error.reasonCode)
      throw new XeroLiveDraftFailure('AUTH_FAILED')
    }
  }

  return {
    binding,
    async dispatch(input: TransportDispatchRequest): Promise<TransportDispatchResult> {
      requireOwnBinding(binding, input.targetBinding)
      const spec = DRAFT_RESOURCES[binding.resource]
      if (!spec) throw new XeroLiveDraftFailure('RESOURCE_NOT_ALLOWED')
      if (input.operation !== 'create') throw new XeroLiveDraftFailure('OPERATION_NOT_ALLOWED')
      // The Tier 1 ceiling is checked before credentials are even read: a
      // non-DRAFT payload is refused with no auth state and no remote call.
      requireDraftPayload(input.payload)
      if (typeof input.planDigest !== 'string' || input.planDigest.trim() === '') {
        throw new XeroLiveDraftFailure('DISPATCH_FAILED')
      }
      if (dispatchedDigests.has(input.planDigest)) {
        throw new XeroLiveDraftFailure('DUPLICATE_DISPATCH')
      }
      // Burn the digest synchronously, before the first await: two concurrent
      // dispatches of the same plan must not both pass the check while one is
      // suspended resolving credentials. From here on the answer to "may this
      // plan dispatch again through this adapter" is no, even when the remote
      // call fails with unknown server-side state. The plan digest also rides
      // as the remote idempotency key, so a fresh adapter in a fresh process
      // re-sending the same plan still cannot create a second draft.
      dispatchedDigests.add(input.planDigest)

      const client = await resolveClient()
      let response: unknown
      try {
        response = await spec.create(client, tenantId, input.payload, input.planDigest)
      } catch {
        throw new XeroLiveDraftFailure('DISPATCH_FAILED')
      }

      const record = extractSingleRecord(response, spec)
      const id = record[spec.idField]
      if (typeof id !== 'string' || id.trim() === '') {
        throw new XeroLiveDraftFailure('RESPONSE_INVALID')
      }
      // The remote answering with anything but a DRAFT object means the
      // ceiling did not hold; surface it as a terminal failure (the executor
      // marks the mutation UNCERTAIN for a human), never as success.
      if (record.status !== 'DRAFT') throw new XeroLiveDraftFailure('RESPONSE_NOT_DRAFT')

      locators.set(input.planDigest, id)
      return {accepted: true}
    },

    async readBack(input: TransportReadBackRequest): Promise<ReadBackTransportResult> {
      requireOwnBinding(binding, input.targetBinding)
      const spec = DRAFT_RESOURCES[binding.resource]
      if (!spec) throw new XeroLiveDraftFailure('RESOURCE_NOT_ALLOWED')
      const id = locators.get(input.planDigest)
      // A read-back for a plan this adapter never accepted cannot honestly
      // answer 'missing' — it never asked the remote anything about it.
      if (id === undefined) throw new XeroLiveDraftFailure('UNKNOWN_PLAN')

      const client = await resolveClient()
      let response: unknown
      try {
        response = await spec.fetch(client, tenantId, id)
      } catch (error) {
        if (isNotFound(error)) return {status: 'missing'}
        throw new XeroLiveDraftFailure('READBACK_FAILED')
      }
      return {status: 'found', records: [extractSingleRecord(response, spec)]}
    },
  }
}

function requireOwnBinding(own: TargetBinding, offered: TargetBinding): void {
  if (!offered || typeof offered !== 'object' || !sameBinding(own, offered)) {
    throw new XeroLiveDraftFailure('BINDING_MISMATCH')
  }
}

/**
 * The DRAFT ceiling, syntactically enforced: a plain-JSON payload whose
 * top-level `status` is exactly 'DRAFT' and in which no nested `status` key
 * says anything else. Depth beyond the scan bound is refused, not trusted.
 */
function requireDraftPayload(payload: unknown): void {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new XeroLiveDraftFailure('PAYLOAD_NOT_DRAFT')
  }
  if (containsSecretShapedData(payload) || containsTenantIdentifier(payload)) {
    throw new XeroLiveDraftFailure('PAYLOAD_UNSAFE')
  }
  const record = payload as Record<string, unknown>
  if (record.status !== 'DRAFT') throw new XeroLiveDraftFailure('PAYLOAD_NOT_DRAFT')
  if (!statusKeysAllDraft(payload, 0)) throw new XeroLiveDraftFailure('PAYLOAD_NOT_DRAFT')
}

function statusKeysAllDraft(value: unknown, depth: number): boolean {
  if (depth > MAX_STATUS_SCAN_DEPTH) return false
  if (Array.isArray(value)) return value.every(item => statusKeysAllDraft(item, depth + 1))
  if (!value || typeof value !== 'object') return true
  return Object.entries(value).every(
    ([key, nested]) => (!/^status$/i.test(key) || nested === 'DRAFT') && statusKeysAllDraft(nested, depth + 1),
  )
}

/**
 * Reduce a create or fetch response to the one plain-JSON record it must
 * contain: exactly one element (one plan, one object — ADR-0008), taken from
 * the named collection and round-tripped through JSON so no SDK class
 * instance, header, or request context survives the seam.
 */
function extractSingleRecord(result: unknown, spec: DraftResourceSpec): Record<string, unknown> {
  if (!result || typeof result !== 'object') throw new XeroLiveDraftFailure('RESPONSE_INVALID')
  const inner = (result as Record<string, unknown>).body
  if (!inner || typeof inner !== 'object') throw new XeroLiveDraftFailure('RESPONSE_INVALID')
  const records = (inner as Record<string, unknown>)[spec.collection]
  if (!Array.isArray(records) || records.length !== 1) {
    throw new XeroLiveDraftFailure('RESPONSE_INVALID')
  }
  let plain: unknown
  try {
    plain = JSON.parse(JSON.stringify(records[0]))
  } catch {
    throw new XeroLiveDraftFailure('RESPONSE_INVALID')
  }
  if (!plain || typeof plain !== 'object' || Array.isArray(plain)) {
    throw new XeroLiveDraftFailure('RESPONSE_INVALID')
  }
  if (containsTenantIdentifier(plain)) throw new XeroLiveDraftFailure('RESPONSE_UNSAFE')
  return plain as Record<string, unknown>
}

/**
 * xero-node rejects HTTP failures as `JSON.stringify(ApiError.generateError())`
 * — a string of `{response: {statusCode, ...}}` — so both the string and the
 * plain-object form must be recognized. Only the status code is read; the
 * provider body never leaves this function.
 */
function isNotFound(error: unknown): boolean {
  let candidate: unknown = error
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate)
    } catch {
      return false
    }
  }
  if (!candidate || typeof candidate !== 'object') return false
  const response = (candidate as Record<string, unknown>).response
  if (!response || typeof response !== 'object') return false
  return (response as Record<string, unknown>).statusCode === 404
}
