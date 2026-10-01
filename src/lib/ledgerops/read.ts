import {cloneCanonical, deepFreeze, digestJson, type Digest, type JsonValue} from './canonical.js'
import {hasRequiredCapabilities} from './capabilities.js'
import {containsSecretShapedData} from './data-hygiene.js'
import {
  createTargetBinding,
  isIdentityFresh,
  isSafeTargetBinding,
  sameBinding,
  verifyTargetIdentity,
} from './identity.js'
import {defineSignedRecord, digest, finiteNumber, label, literal, oneOf} from './signed-record.js'
import {TERMINAL_STATES, type TargetBinding, type TargetIdentity, type TerminalState} from './types.js'

/**
 * The bounded READ contract (Tier 0). Reads are not mutations: there is no
 * plan, confirmation, or executor chain. Instead a read is identity-bound
 * (fresh verified identity for exactly the requested profile and resource),
 * allowlisted (only resources in READ_RESOURCES, each with its own capability
 * and scope requirement), call-bounded (a hard per-execution transport-call
 * ceiling), and receipted (a signed read receipt is persisted before any
 * record is released; if the receipt cannot be persisted, no data is).
 *
 * Reads share the ADR-0003 seam discipline: a ReadTransport is constructed
 * bound to one target, publishes that binding, and only redacted plain-JSON
 * records may cross back — every record is hygiene-checked and canonically
 * cloned before release, and one unsafe record withholds the whole result.
 */

export const READ_RECEIPT_SCHEMA = 'ledgerops.read.v1' as const

/** Hard ceiling on transport calls in one execution; requests may only lower it. */
export const READ_MAX_CALLS_CEILING = 10

export interface ReadResourceSpec {
  readonly capability: string
  /**
   * Scope requirement groups: every group must be satisfied, and any one
   * member satisfies its group. Groups lead with the least-privilege `.read`
   * scope; the write-capable scope is accepted because at Xero it grants the
   * same read access, never less.
   */
  readonly scopes: readonly (readonly string[])[]
}

/**
 * The read allowlist: resource → kernel capability + Xero OAuth scopes
 * (granular scope names per the Xero scopes documentation; the aged reports
 * share `accounting.reports.aged.read`, journals require the granular
 * `accounting.journals.read` scope with no write-capable alternative, and
 * credit notes sit under the invoices scope — Xero publishes no separate
 * creditnotes scope).
 */
export const READ_RESOURCES: Readonly<Record<string, ReadResourceSpec>> = deepFreeze({
  accounts: {
    capability: 'read.accounts',
    scopes: [['accounting.settings.read', 'accounting.settings']],
  },
  contacts: {
    capability: 'read.contacts',
    scopes: [['accounting.contacts.read', 'accounting.contacts']],
  },
  currencies: {
    capability: 'read.currencies',
    scopes: [['accounting.settings.read', 'accounting.settings']],
  },
  'tax-rates': {
    capability: 'read.tax-rates',
    scopes: [['accounting.settings.read', 'accounting.settings']],
  },
  'report-profit-and-loss': {
    capability: 'read.report-profit-and-loss',
    scopes: [['accounting.reports.profitandloss.read']],
  },
  'report-balance-sheet': {
    capability: 'read.report-balance-sheet',
    scopes: [['accounting.reports.balancesheet.read']],
  },
  'report-trial-balance': {
    capability: 'read.report-trial-balance',
    scopes: [['accounting.reports.trialbalance.read']],
  },
  'report-aged-receivables': {
    capability: 'read.report-aged-receivables',
    scopes: [['accounting.reports.aged.read']],
  },
  'report-aged-payables': {
    capability: 'read.report-aged-payables',
    scopes: [['accounting.reports.aged.read']],
  },
  journals: {
    capability: 'read.journals',
    scopes: [['accounting.journals.read']],
  },
  'bank-transactions': {
    capability: 'read.bank-transactions',
    scopes: [['accounting.banktransactions.read', 'accounting.banktransactions']],
  },
  payments: {
    capability: 'read.payments',
    scopes: [['accounting.payments.read', 'accounting.payments']],
  },
  invoices: {
    capability: 'read.invoices',
    scopes: [['accounting.invoices.read', 'accounting.invoices']],
  },
  'credit-notes': {
    capability: 'read.credit-notes',
    scopes: [['accounting.invoices.read', 'accounting.invoices']],
  },
  'manual-journals': {
    capability: 'read.manual-journals',
    scopes: [['accounting.manualjournals.read', 'accounting.manualjournals']],
  },
})

export const READ_RESOURCE_NAMES: readonly string[] = Object.freeze(Object.keys(READ_RESOURCES).sort())

export const READ_STOP_REASON_CODES = [
  'INVALID_REQUEST',
  'RESOURCE_NOT_ALLOWED',
  'IDENTITY_REQUIRED',
  'IDENTITY_INVALID',
  'IDENTITY_STALE',
  'PROFILE_MISMATCH',
  'RESOURCE_MISMATCH',
  'CAPABILITY_REQUIRED',
  'SCOPE_REQUIRED',
  'CALL_BOUND_INVALID',
  'QUERY_UNSAFE',
  'RECEIPT_SINK_REQUIRED',
  'TRANSPORT_INVALID',
  'TRANSPORT_BINDING_MISMATCH',
  'TRANSPORT_FAILED',
  'CALL_BOUND_EXCEEDED',
  'OUTPUT_UNSAFE',
  'RECEIPT_WRITE_FAILED',
  'CLOCK_INVALID',
] as const

export type ReadStopReasonCode = (typeof READ_STOP_REASON_CODES)[number]

export const READ_OUTCOMES = ['OK', 'STOP'] as const

export type ReadOutcome = (typeof READ_OUTCOMES)[number]

export interface ReadReceipt {
  readonly schemaVersion: typeof READ_RECEIPT_SCHEMA
  readonly receiptId: Digest
  readonly recordedAt: number
  readonly profileName: string
  readonly resource: string
  readonly target: TargetBinding
  readonly queryDigest: Digest
  readonly maxCalls: number
  readonly callCount: number
  readonly recordCount: number
  readonly outcome: ReadOutcome
  readonly terminal: TerminalState
  readonly reasonCode?: ReadStopReasonCode
}

function targetMatchesProfile(receipt: ReadReceipt): boolean {
  return receipt.target.profileName === receipt.profileName
}

function targetMatchesResource(receipt: ReadReceipt): boolean {
  return receipt.target.resource === receipt.resource
}

function countsAreBounded(receipt: ReadReceipt): boolean {
  return (
    Number.isInteger(receipt.maxCalls) &&
    receipt.maxCalls >= 1 &&
    receipt.maxCalls <= READ_MAX_CALLS_CEILING &&
    Number.isInteger(receipt.callCount) &&
    receipt.callCount >= 0 &&
    receipt.callCount <= receipt.maxCalls &&
    Number.isInteger(receipt.recordCount) &&
    receipt.recordCount >= 0
  )
}

function resourceIsAllowlisted(receipt: ReadReceipt): boolean {
  return Object.hasOwn(READ_RESOURCES, receipt.resource)
}

function outcomeMatchesTerminal(receipt: ReadReceipt): boolean {
  return receipt.outcome === 'OK'
    ? receipt.terminal === 'CONTINUE' && receipt.reasonCode === undefined
    : receipt.terminal === 'STOP' && receipt.reasonCode !== undefined
}

const readReceiptRecord = defineSignedRecord<ReadReceipt, 'receiptId'>({
  label: 'ledgerops.read.v1',
  digestField: 'receiptId',
  digestPreamble: {kind: 'ledgerops.read.v1'},
  fields: {
    schemaVersion: {check: literal(READ_RECEIPT_SCHEMA)},
    recordedAt: {check: finiteNumber()},
    profileName: {check: label()},
    resource: {check: label()},
    target: {check: isSafeTargetBinding},
    queryDigest: {check: digest()},
    maxCalls: {check: finiteNumber()},
    callCount: {check: finiteNumber()},
    recordCount: {check: finiteNumber()},
    outcome: {check: oneOf(...READ_OUTCOMES)},
    terminal: {check: oneOf(...TERMINAL_STATES)},
    reasonCode: {check: oneOf(...READ_STOP_REASON_CODES), optional: true},
  },
  invariants: [
    targetMatchesProfile,
    targetMatchesResource,
    resourceIsAllowlisted,
    countsAreBounded,
    outcomeMatchesTerminal,
  ],
})

export const READ_RECEIPT_ALLOWED_KEYS = readReceiptRecord.keys

export interface ReadReceiptInput {
  recordedAt: number
  profileName: string
  resource: string
  target: TargetBinding
  queryDigest: Digest
  maxCalls: number
  callCount: number
  recordCount: number
  outcome: ReadOutcome
  terminal: TerminalState
  reasonCode?: ReadStopReasonCode
}

export function createReadReceipt(input: ReadReceiptInput): ReadReceipt {
  return readReceiptRecord.create({
    schemaVersion: READ_RECEIPT_SCHEMA,
    recordedAt: input.recordedAt,
    profileName: input.profileName,
    resource: input.resource,
    target: input.target,
    queryDigest: input.queryDigest,
    maxCalls: input.maxCalls,
    callCount: input.callCount,
    recordCount: input.recordCount,
    outcome: input.outcome,
    terminal: input.terminal,
    reasonCode: input.reasonCode,
  })
}

export const isReadReceipt = readReceiptRecord.verify

export interface ReadReceiptSink {
  /**
   * Persist a read receipt. A throw is the sink proving it cannot persist; the
   * read then STOPs and releases no records.
   */
  writeRead(receipt: ReadReceipt): void | Promise<void>
}

export class InMemoryReadReceiptSink implements ReadReceiptSink {
  private readonly values: ReadReceipt[] = []

  writeRead(receipt: ReadReceipt): void {
    if (!isReadReceipt(receipt)) throw new TypeError('Only LedgerOps read receipts may be written')
    this.values.push(receipt)
  }

  get receipts(): readonly ReadReceipt[] {
    return this.values.slice()
  }

  clear(): void {
    this.values.length = 0
  }
}

export interface ReadTransportRequest {
  readonly resource: string
  readonly targetBinding: TargetBinding
  readonly query: JsonValue
  /** 1-based index of this call within the execution's call bound. */
  readonly call: number
}

export interface ReadTransportPage {
  readonly records: readonly unknown[]
  readonly done: boolean
}

/**
 * The read half of the ADR-0003 seam. An adapter is constructed bound to
 * exactly one target and publishes that binding; the kernel re-checks it
 * before the first call. On any internal binding or credential mismatch an
 * adapter must THROW — returning an empty page would falsely claim the remote
 * answered. Records that cross back must already be redacted plain JSON; the
 * kernel still hygiene-checks every one and withholds everything on a hit.
 */
export interface ReadTransport {
  readonly binding: TargetBinding
  read(input: ReadTransportRequest): ReadTransportPage | Promise<ReadTransportPage>
}

export interface ReadRequest {
  readonly profileName: string
  readonly resource: string
  /** Canonical-JSON query parameters passed through to the adapter. Defaults to {}. */
  readonly query?: unknown
  /** Transport-call bound for this execution; 1..READ_MAX_CALLS_CEILING. Defaults to 1. */
  readonly maxCalls?: number
}

export interface ReadContext {
  readonly identity?: TargetIdentity
  readonly receiptSink?: ReadReceiptSink
  readonly now?: number
}

export interface ReadExecutionResult {
  readonly status: 'ok' | 'stop'
  readonly outcome: ReadOutcome
  readonly stop: boolean
  /** Released records; always empty on STOP. */
  readonly records: readonly JsonValue[]
  readonly callCount: number
  readonly recordCount: number
  readonly reasonCode?: ReadStopReasonCode
  /**
   * The signed receipt for this execution. Absent only for guard-phase STOPs,
   * where no verified target binding exists to attest to and no transport call
   * was made.
   */
  readonly receipt?: ReadReceipt
  readonly receiptWriteFailed: boolean
}

/** Run one bounded, receipted read through a target-bound transport. */
export async function executeRead(
  request: ReadRequest,
  context: ReadContext,
  transport: ReadTransport,
): Promise<ReadExecutionResult> {
  const guardStop = (reasonCode: ReadStopReasonCode): ReadExecutionResult => ({
    status: 'stop',
    outcome: 'STOP',
    stop: true,
    records: [],
    callCount: 0,
    recordCount: 0,
    reasonCode,
    receiptWriteFailed: false,
  })

  if (!request || typeof request !== 'object') return guardStop('INVALID_REQUEST')
  if (typeof request.profileName !== 'string' || request.profileName.trim() === '') {
    return guardStop('INVALID_REQUEST')
  }
  if (typeof request.resource !== 'string' || request.resource.trim() === '') {
    return guardStop('INVALID_REQUEST')
  }

  const spec = Object.hasOwn(READ_RESOURCES, request.resource) ? READ_RESOURCES[request.resource] : undefined
  if (!spec) return guardStop('RESOURCE_NOT_ALLOWED')

  const now = context?.now ?? Date.now()
  if (typeof now !== 'number' || !Number.isFinite(now)) return guardStop('CLOCK_INVALID')

  const identity = context?.identity
  if (!identity) return guardStop('IDENTITY_REQUIRED')
  if (!verifyTargetIdentity(identity)) return guardStop('IDENTITY_INVALID')
  if (!isIdentityFresh(identity, now)) return guardStop('IDENTITY_STALE')
  if (identity.profileName !== request.profileName) return guardStop('PROFILE_MISMATCH')
  if (identity.resource !== request.resource) return guardStop('RESOURCE_MISMATCH')

  if (!hasRequiredCapabilities(identity.capabilities, [spec.capability])) {
    return guardStop('CAPABILITY_REQUIRED')
  }
  const scopeSet = new Set(identity.scopes)
  for (const group of spec.scopes) {
    if (!group.some(scope => scopeSet.has(scope))) return guardStop('SCOPE_REQUIRED')
  }

  const maxCalls = request.maxCalls ?? 1
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > READ_MAX_CALLS_CEILING) {
    return guardStop('CALL_BOUND_INVALID')
  }

  const sink = context?.receiptSink
  if (!sink || typeof sink.writeRead !== 'function') return guardStop('RECEIPT_SINK_REQUIRED')

  let query: JsonValue
  try {
    const rawQuery = request.query ?? {}
    if (containsSecretShapedData(rawQuery)) return guardStop('QUERY_UNSAFE')
    query = cloneCanonical(rawQuery)
  } catch {
    return guardStop('QUERY_UNSAFE')
  }

  const binding = createTargetBinding(identity)
  if (
    !transport ||
    typeof transport.read !== 'function' ||
    !transport.binding ||
    typeof transport.binding !== 'object'
  ) {
    return guardStop('TRANSPORT_INVALID')
  }
  if (!sameBinding(binding, transport.binding)) return guardStop('TRANSPORT_BINDING_MISMATCH')

  const queryDigest = digestJson({kind: 'ledgerops.read-query.v1', resource: request.resource, query})

  const finish = async (
    outcome: ReadOutcome,
    callCount: number,
    records: readonly JsonValue[],
    reasonCode?: ReadStopReasonCode,
  ): Promise<ReadExecutionResult> => {
    let receipt: ReadReceipt | undefined
    let receiptWriteFailed = false
    try {
      receipt = createReadReceipt({
        recordedAt: now,
        profileName: request.profileName,
        resource: request.resource,
        target: binding,
        queryDigest,
        maxCalls,
        callCount,
        recordCount: records.length,
        outcome,
        terminal: outcome === 'OK' ? 'CONTINUE' : 'STOP',
        reasonCode,
      })
      await sink.writeRead(receipt)
    } catch {
      receiptWriteFailed = true
    }

    // Fail closed: a read whose receipt is not on record releases nothing.
    const stopped = outcome === 'STOP' || receiptWriteFailed
    return {
      status: stopped ? 'stop' : 'ok',
      outcome: stopped ? 'STOP' : 'OK',
      stop: stopped,
      records: stopped ? [] : records,
      callCount,
      recordCount: records.length,
      ...(stopped ? {reasonCode: reasonCode ?? 'RECEIPT_WRITE_FAILED'} : {}),
      // A receipt the sink never persisted must not circulate: an OK receipt
      // for withheld data would be a signed claim the store cannot back.
      ...(receipt === undefined || receiptWriteFailed ? {} : {receipt}),
      receiptWriteFailed,
    }
  }

  const collected: JsonValue[] = []
  let callCount = 0
  let done = false
  while (callCount < maxCalls) {
    callCount += 1
    let page: ReadTransportPage
    try {
      page = await transport.read({resource: request.resource, targetBinding: binding, query, call: callCount})
    } catch {
      return finish('STOP', callCount, collected, 'TRANSPORT_FAILED')
    }
    if (!page || typeof page !== 'object' || !Array.isArray(page.records) || typeof page.done !== 'boolean') {
      return finish('STOP', callCount, collected, 'TRANSPORT_INVALID')
    }
    for (const record of page.records) {
      // Hygiene-check the raw record first: exotic objects (getters, proxies,
      // class instances) fail here before cloneCanonical would read them twice.
      if (containsSecretShapedData(record)) return finish('STOP', callCount, collected, 'OUTPUT_UNSAFE')
      try {
        collected.push(cloneCanonical(record))
      } catch {
        return finish('STOP', callCount, collected, 'OUTPUT_UNSAFE')
      }
    }
    if (page.done) {
      done = true
      break
    }
  }
  if (!done) return finish('STOP', callCount, collected, 'CALL_BOUND_EXCEEDED')

  return finish('OK', callCount, deepFreeze(collected))
}
