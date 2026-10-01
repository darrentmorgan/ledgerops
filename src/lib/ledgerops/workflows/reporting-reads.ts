import {executeRead, type ReadExecutionResult} from '../read.js'
import type {FoundationReadInput} from './foundation-reads.js'

/**
 * Tier 0 reporting reads: the five financial reports plus the journals feed —
 * the M1 export surface for business decisions. Like the foundation lane, the
 * workflow only narrows the kernel's read allowlist to these resources;
 * identity, scopes, call bounds, hygiene, and the signed read receipt are all
 * `executeRead`'s (ADR-0010). The two lanes are deliberately disjoint: a
 * reference resource through this lane is a STOP, and vice versa.
 */
export const REPORTING_READ_RESOURCES = [
  'report-profit-and-loss',
  'report-balance-sheet',
  'report-trial-balance',
  'report-aged-receivables',
  'report-aged-payables',
  'journals',
] as const

export type ReportingReadResource = (typeof REPORTING_READ_RESOURCES)[number]

export function isReportingReadResource(value: string): value is ReportingReadResource {
  return (REPORTING_READ_RESOURCES as readonly string[]).includes(value)
}

export type ReportingReadInput = FoundationReadInput

export async function runReportingRead(input: ReportingReadInput): Promise<ReadExecutionResult> {
  // Malformed request shapes go straight to the kernel so they keep their
  // INVALID_REQUEST STOP; the workflow narrows only well-formed resources.
  const resource = input.request && typeof input.request === 'object' ? input.request.resource : undefined
  if (typeof resource === 'string' && resource.trim() !== '' && !isReportingReadResource(resource)) {
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
