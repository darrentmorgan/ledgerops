import {cloneCanonical, digestJson} from '../canonical.js'
import {createBatchManifest} from '../batch-manifest.js'
import {containsSecretShapedData, containsTenantIdentifier} from '../data-hygiene.js'
import {createTargetBinding} from '../identity.js'
import {createMutationPlan} from '../plan.js'
import type {BatchHaltPolicy, BatchManifest, MutationPlan, TargetBinding, TargetIdentity} from '../types.js'
import {parseInvoiceBatch, type InvoiceBatchRow} from './invoice-batch-input.js'
import {isPlainRecord} from './structural-guards.js'

/**
 * ADR-0011 journey: turn a synthetic invoice-batch CSV (issue #59's parser)
 * into a confirmed-ready `ledgerops.batch-manifest.v1`. Each parsed row
 * becomes exactly one signed DRAFT invoice plan (`requiresDemoCompany: true`,
 * `objectCount: 1`); the manifest is a signed enumeration over those plans.
 *
 * Fail-closed, all-or-nothing: a CSV parse error, a per-row plan error, or a
 * manifest assembly error for ANY member means no manifest is produced. This
 * module never calls Xero: planning stays transport-free (ADR-0011).
 */

const INVOICE_TYPES = ['ACCREC', 'ACCPAY'] as const
type InvoiceBatchInvoiceType = (typeof INVOICE_TYPES)[number]

const MAX_IDENTIFIER_LENGTH = 128

export type InvoiceBatchPlanErrorCode =
  | 'INVALID_INPUT'
  | 'DATA_HYGIENE'
  | 'INVALID_SCHEMA_VERSION'
  | 'INVALID_PROFILE'
  | 'INVALID_INVOICE_TYPE'
  | 'INVALID_ACCOUNT_CODE'
  | 'INVALID_TAX_TYPE'
  | 'INVALID_TIMESTAMP'
  | 'INVALID_TTL'
  | 'INVALID_HALT_POLICY'
  | 'INVALID_PROVENANCE'
  | 'INVALID_BATCH_CSV'
  | 'TARGET_RESOURCE_MISMATCH'
  | 'TARGET_PROFILE_MISMATCH'
  | 'PLAN_ERROR'
  | 'MANIFEST_ERROR'

export interface InvoiceBatchPlanStop {
  readonly status: 'STOP'
  readonly code: InvoiceBatchPlanErrorCode
  readonly reason: string
}

export interface InvoiceBatchPlanRequest {
  readonly schemaVersion: 'ledgerops.invoice-batch-plan.request.v1'
  readonly profileName: string
  readonly batchId?: string
  readonly invoiceType: InvoiceBatchInvoiceType
  readonly accountCode: string
  readonly taxType?: string
  readonly lineAmountTypes?: string
  readonly createdAt: number
  readonly ttlMs?: number
  readonly haltPolicy?: BatchHaltPolicy
  readonly sourceReceiptId: string
  /** Non-empty, unique, sorted ascending: the manifest's sealed provenance. */
  readonly sourceManifestHashes: readonly string[]
}

export interface InvoiceBatchPlanEntry {
  readonly row: InvoiceBatchRow
  readonly planId: string
  readonly planDigest: string
  readonly plan: MutationPlan
}

export interface InvoiceBatchPlanResult {
  readonly status: 'PLANNED'
  readonly plans: readonly InvoiceBatchPlanEntry[]
  readonly manifest: BatchManifest
}

function stop(code: InvoiceBatchPlanErrorCode, reason: string): InvoiceBatchPlanStop {
  return {status: 'STOP', code, reason}
}

function safeIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  )
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

/** Non-empty, duplicate-free, sorted ascending: one deterministic source set. */
function isSourceManifestHashes(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length === 0) return false
  if (!value.every(hash => isDigest(hash))) return false
  for (let index = 1; index < value.length; index += 1) {
    if (value[index - 1] >= value[index]) return false
  }
  return true
}

function rowIdentityDigest(row: InvoiceBatchRow): string {
  return digestJson({
    contact: row.contact,
    reference: row.reference,
    date: row.date,
    description: row.description,
  })
}

/**
 * Build the invoice plans and the enclosing batch manifest from an already
 * verified target and a synthetic invoice-batch CSV document. Returns a
 * `STOP` for a parse error, a per-row plan error, a mismatched or malformed
 * request, or a manifest assembly error — never a partial manifest.
 */
export function planInvoiceBatch(
  target: TargetIdentity | TargetBinding,
  csv: string,
  input: unknown,
): InvoiceBatchPlanResult | InvoiceBatchPlanStop {
  try {
    if (!isPlainRecord(input)) return stop('INVALID_INPUT', 'Input must be a non-null JSON object')
    const snapshot = cloneCanonical(input)
    if (!isPlainRecord(snapshot)) return stop('INVALID_INPUT', 'Input must be a non-null JSON object')
    if (containsSecretShapedData(snapshot) || containsTenantIdentifier(snapshot)) {
      return stop(
        'DATA_HYGIENE',
        'Secret-shaped or tenant-identifying values are not accepted at the workflow boundary',
      )
    }

    const request = snapshot as unknown as InvoiceBatchPlanRequest
    if (request.schemaVersion !== 'ledgerops.invoice-batch-plan.request.v1') {
      return stop('INVALID_SCHEMA_VERSION', 'Unsupported request schema version')
    }
    if (!safeIdentifier(request.profileName)) {
      return stop('INVALID_PROFILE', 'profileName must be a bounded identifier')
    }
    if (request.batchId !== undefined && !safeIdentifier(request.batchId)) {
      return stop('INVALID_PROFILE', 'batchId must be a bounded identifier when supplied')
    }
    if (!(INVOICE_TYPES as readonly string[]).includes(request.invoiceType)) {
      return stop('INVALID_INVOICE_TYPE', 'invoiceType must be ACCREC (sales invoice) or ACCPAY (supplier bill)')
    }
    if (!safeIdentifier(request.accountCode)) {
      return stop('INVALID_ACCOUNT_CODE', 'accountCode must be a bounded identifier')
    }
    if (request.taxType !== undefined && !safeIdentifier(request.taxType)) {
      return stop('INVALID_TAX_TYPE', 'taxType must be a bounded identifier when supplied')
    }
    if (typeof request.createdAt !== 'number' || !Number.isFinite(request.createdAt)) {
      return stop('INVALID_TIMESTAMP', 'createdAt must be a finite millisecond timestamp')
    }
    if (
      request.ttlMs !== undefined &&
      (typeof request.ttlMs !== 'number' || !Number.isFinite(request.ttlMs) || request.ttlMs <= 0)
    ) {
      return stop('INVALID_TTL', 'ttlMs must be a positive finite duration when supplied')
    }
    if (
      request.haltPolicy !== undefined &&
      request.haltPolicy !== 'halt-on-stop' &&
      request.haltPolicy !== 'continue-on-stop'
    ) {
      return stop('INVALID_HALT_POLICY', 'haltPolicy must be halt-on-stop or continue-on-stop')
    }
    if (!isDigest(request.sourceReceiptId)) {
      return stop('INVALID_PROVENANCE', 'sourceReceiptId must be a SHA-256 digest')
    }
    if (!isSourceManifestHashes(request.sourceManifestHashes)) {
      return stop('INVALID_PROVENANCE', 'sourceManifestHashes must be a non-empty, duplicate-free, sorted digest array')
    }

    let targetBinding: TargetBinding
    try {
      targetBinding = createTargetBinding(target)
    } catch (error) {
      return stop('TARGET_RESOURCE_MISMATCH', error instanceof Error ? error.message : 'Invalid target')
    }
    if (targetBinding.resource !== 'invoices') {
      return stop('TARGET_RESOURCE_MISMATCH', 'The target must bind the invoices resource')
    }
    if (targetBinding.profileName !== request.profileName) {
      return stop('TARGET_PROFILE_MISMATCH', 'The target profile does not match the request profile')
    }

    const parsed = parseInvoiceBatch(csv)
    if (!parsed.ok) {
      return stop(
        'INVALID_BATCH_CSV',
        `Invoice batch CSV failed to parse: ${parsed.errors[0]?.message ?? 'unknown error'}`,
      )
    }

    let entries: InvoiceBatchPlanEntry[]
    try {
      entries = parsed.rows.map(row => buildRowPlan(request, targetBinding, row))
    } catch (error) {
      return stop('PLAN_ERROR', error instanceof Error ? error.message : 'Failed to build a per-row invoice plan')
    }

    return assembleManifest(request, entries)
  } catch {
    // A malformed boundary value must never escape as an implementation error.
    return stop('INVALID_INPUT', 'Input contains an unsupported or malformed value')
  }
}

function buildRowPlan(
  request: InvoiceBatchPlanRequest,
  targetBinding: TargetBinding,
  row: InvoiceBatchRow,
): InvoiceBatchPlanEntry {
  const payload: Record<string, unknown> = {
    type: request.invoiceType,
    status: 'DRAFT' as const,
    date: row.date,
    reference: row.reference,
    contact: {name: row.contact},
    lineAmountTypes: request.lineAmountTypes ?? 'NoTax',
    lineItems: [
      {
        description: row.description,
        quantity: Number(row.quantity),
        unitAmount: Number(row.unitAmount),
        accountCode: request.accountCode,
        ...(request.taxType === undefined ? {} : {taxType: request.taxType}),
      },
    ],
  }
  const planId = `invoice-batch-plan-${rowIdentityDigest(row)}-${request.sourceReceiptId}`
  const plan = createMutationPlan({
    planId,
    profileName: request.profileName,
    resource: 'invoices',
    operation: 'create',
    target: targetBinding,
    payload,
    requiredCapabilities: ['draft.create'],
    requiredScopes: ['accounting.invoices'],
    readBack: {expected: payload},
    createdAt: request.createdAt,
    ttlMs: request.ttlMs,
  })
  return {row, planId: plan.planId, planDigest: plan.planDigest, plan}
}

/**
 * Assemble the manifest from already-built plan entries. All members must
 * bind one profile and one tenant (ADR-0011); a mixed-profile or
 * cross-tenant assembly is refused before a manifest is minted. Builds
 * fresh entries/provenance for `createBatchManifest`: that call stores its
 * `entries` and `provenance` inputs by reference and deep-freezes them, so
 * this function never hands it an array or object a caller still needs.
 */
function assembleManifest(
  request: InvoiceBatchPlanRequest,
  entries: readonly InvoiceBatchPlanEntry[],
): InvoiceBatchPlanResult | InvoiceBatchPlanStop {
  if (entries.length === 0) return stop('MANIFEST_ERROR', 'At least one planned invoice is required')

  const firstProfile = entries[0].plan.profileName
  const firstTenant = entries[0].plan.targetBinding.tenantFingerprint
  const mixed = entries.some(
    entry => entry.plan.profileName !== firstProfile || entry.plan.targetBinding.tenantFingerprint !== firstTenant,
  )
  if (mixed) {
    return stop('MANIFEST_ERROR', 'Every member plan must share one profile and one tenant')
  }
  if (firstProfile !== request.profileName) {
    return stop('TARGET_PROFILE_MISMATCH', 'Member plans do not bind the request profile')
  }

  try {
    const manifest = createBatchManifest({
      batchId: request.batchId ?? 'invoice-batch',
      profileName: request.profileName,
      // Fresh array of fresh objects: never the caller-visible entries above.
      entries: entries.map(entry => ({planId: entry.planId, planDigest: entry.planDigest})),
      provenance: {
        sourceReceiptId: request.sourceReceiptId,
        sourceManifestHashes: [...request.sourceManifestHashes],
      },
      haltPolicy: request.haltPolicy ?? 'halt-on-stop',
      createdAt: request.createdAt,
      ttlMs: request.ttlMs,
    })
    return {status: 'PLANNED', plans: entries, manifest}
  } catch (error) {
    return stop('MANIFEST_ERROR', error instanceof Error ? error.message : 'Failed to assemble the batch manifest')
  }
}

/**
 * Assemble a manifest directly over already-built plans, bypassing CSV
 * parsing. Exposed for callers that already hold signed plans (and for this
 * module's own mixed-profile/cross-tenant assembly guard); the same
 * fail-closed uniformity checks as {@link planInvoiceBatch} apply.
 */
export function assembleInvoiceBatchManifest(
  request: InvoiceBatchPlanRequest,
  entries: readonly InvoiceBatchPlanEntry[],
): InvoiceBatchPlanResult | InvoiceBatchPlanStop {
  return assembleManifest(request, entries)
}
