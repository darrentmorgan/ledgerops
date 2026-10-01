import {executeRead, type ReadExecutionResult} from '../read.js'
import type {FoundationReadInput} from './foundation-reads.js'

/**
 * Tier 0 matching reads: the five transactional resources the M2 matching and
 * audit workflows compare — bank transactions, payments, invoices, credit
 * notes, and manual journals. Like the foundation and reporting lanes, the
 * workflow only narrows the kernel's read allowlist to these resources;
 * identity, scopes, call bounds, hygiene, and the signed read receipt are all
 * `executeRead`'s (ADR-0010). The three lanes are deliberately disjoint: a
 * resource from another lane through this one is a STOP.
 *
 * Bulk matching stays ADR-0008 shaped: every fetcher answers one page per
 * receipted execution, so a sweep over many pages is a loop of bounded single
 * reads (advancing `page` in the signed query), never a widened kernel call.
 */
export const MATCHING_READ_RESOURCES = [
  'bank-transactions',
  'payments',
  'invoices',
  'credit-notes',
  'manual-journals',
] as const

export type MatchingReadResource = (typeof MATCHING_READ_RESOURCES)[number]

export function isMatchingReadResource(value: string): value is MatchingReadResource {
  return (MATCHING_READ_RESOURCES as readonly string[]).includes(value)
}

export type MatchingReadInput = FoundationReadInput

export async function runMatchingRead(input: MatchingReadInput): Promise<ReadExecutionResult> {
  // Malformed request shapes go straight to the kernel so they keep their
  // INVALID_REQUEST STOP; the workflow narrows only well-formed resources.
  const resource = input.request && typeof input.request === 'object' ? input.request.resource : undefined
  if (typeof resource === 'string' && resource.trim() !== '' && !isMatchingReadResource(resource)) {
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
