import {canonicalJson, cloneCanonical, type JsonValue} from '../canonical.js'
import {containsSecretShapedData, containsTenantIdentifier} from '../data-hygiene.js'
import {createTargetBinding, sameBinding} from '../identity.js'
import {executeRead, type ReadContext, type ReadExecutionResult, type ReadRequest, type ReadTransport} from '../read.js'
import type {TargetBinding, TargetIdentity} from '../types.js'

/**
 * Tier 0 foundation reads: the four reference resources every draft lane
 * consumes. The workflow narrows the kernel's read allowlist to exactly these
 * — a reporting resource through this lane is a STOP, not a convenience — and
 * otherwise adds nothing: identity, scopes, call bounds, hygiene, and the
 * signed read receipt are all `executeRead`'s (ADR-0010).
 */
export const FOUNDATION_READ_RESOURCES = ['accounts', 'contacts', 'currencies', 'tax-rates'] as const

export type FoundationReadResource = (typeof FOUNDATION_READ_RESOURCES)[number]

export function isFoundationReadResource(value: string): value is FoundationReadResource {
  return (FOUNDATION_READ_RESOURCES as readonly string[]).includes(value)
}

export interface FoundationReadInput {
  readonly request: ReadRequest
  readonly context: ReadContext
  readonly transport: ReadTransport
}

export async function runFoundationRead(input: FoundationReadInput): Promise<ReadExecutionResult> {
  // Malformed request shapes go straight to the kernel so they keep their
  // INVALID_REQUEST STOP; the workflow narrows only well-formed resources.
  const resource = input.request && typeof input.request === 'object' ? input.request.resource : undefined
  if (typeof resource === 'string' && resource.trim() !== '' && !isFoundationReadResource(resource)) {
    return {
      status: 'stop',
      outcome: 'STOP',
      stop: true,
      records: [],
      callCount: 0,
      recordCount: 0,
      reasonCode: 'RESOURCE_NOT_ALLOWED',
      receiptWriteFailed: false,
    }
  }
  return executeRead(input.request, input.context, input.transport)
}

/**
 * The offline fixture adapter behind `target read --records`: one page of
 * pre-authored synthetic records, bound to one target and one query at
 * construction exactly like the live adapter is bound to one target, throwing
 * on any other. The query bind matters because the receipt signs the query
 * digest (ADR-0010): a fixture answering a query it was not authored for
 * would earn an honest-looking receipt for a dishonest read. Records are
 * hygiene-checked and canonically cloned at construction so a secret-shaped
 * or tenant-identifying fixture fails before any receipted execution.
 */
export function createFixtureReadTransport(
  target: TargetIdentity | TargetBinding,
  records: readonly unknown[],
  expectedQuery: Record<string, JsonValue> = {},
): ReadTransport {
  const binding = createTargetBinding(target)
  if (!Array.isArray(records) || containsSecretShapedData(records)) {
    throw new TypeError('fixture read records must be an array free of secret-shaped data')
  }
  if (containsTenantIdentifier(records)) {
    throw new TypeError('fixture read records must not carry tenant-identifier fields')
  }
  const page = records.map(record => cloneCanonical(record))
  const queryJson = canonicalJson(expectedQuery)

  return {
    binding,
    read(input) {
      if (
        !input.targetBinding ||
        typeof input.targetBinding !== 'object' ||
        !sameBinding(binding, input.targetBinding)
      ) {
        throw new Error('fixture read transport is bound to a different target')
      }
      if (input.resource !== binding.resource) {
        throw new Error('fixture read transport is bound to a different resource')
      }
      if (canonicalJson(input.query ?? {}) !== queryJson) {
        throw new Error('fixture read transport was not authored for this query')
      }
      return {records: page.map(record => cloneCanonical(record)), done: true}
    },
  }
}
