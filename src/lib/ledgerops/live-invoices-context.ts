import {createTargetIdentity, isIdentityFresh, redactTargetIdentity} from './identity.js'
import {LIVE_DEMO_PROFILE, LIVE_DEMO_RESOURCE} from './live-identity.js'
import type {RedactedTargetIdentity, TargetIdentity} from './types.js'

/**
 * Demo Company bound live context for the invoices resource (ADR-0003 seam).
 *
 * A fresh, Demo-Company-verified organisation identity (`target verify
 * --live-demo`) is projected into a redacted binding scoped to resource
 * `invoices`. Freshness and Demo Company checks are not reimplemented here —
 * they reuse `isIdentityFresh` and `createTargetIdentity` from `identity.ts`,
 * the same primitives the organisation-identity live check relies on.
 * Adapters remain raw-record dumb: this module produces kernel-side bindings
 * only and never touches a transport.
 */
export const INVOICES_LIVE_CONTEXT_SCHEMA = 'ledgerops.invoices.live-context.v1' as const
export const INVOICES_LIVE_CONTEXT_RESOURCE = 'invoices' as const

export type InvoicesLiveContextStopReason =
  | 'SOURCE_IDENTITY_INVALID'
  | 'SOURCE_PROFILE_MISMATCH'
  | 'SOURCE_RESOURCE_MISMATCH'
  | 'DEMO_COMPANY_REQUIRED'
  | 'IDENTITY_STALE'
  | 'CLOCK_INVALID'

export interface InvoicesLiveContextInput {
  /** A fresh, verified organisation identity from the live Demo identity gate. */
  readonly identity: TargetIdentity
  readonly now?: number
}

export interface InvoicesLiveContext extends RedactedTargetIdentity {
  readonly schemaVersion: typeof INVOICES_LIVE_CONTEXT_SCHEMA
  readonly resource: typeof INVOICES_LIVE_CONTEXT_RESOURCE
  readonly isDemoCompany: true
}

export interface InvoicesLiveContextStop {
  readonly schemaVersion: typeof INVOICES_LIVE_CONTEXT_SCHEMA
  readonly status: 'STOP'
  readonly outcome: 'STOP'
  readonly terminal: 'STOP'
  readonly stop: true
  readonly code: 'INVOICES_LIVE_CONTEXT_STOP'
  readonly reasonCode: InvoicesLiveContextStopReason
}

export type InvoicesLiveContextResult = InvoicesLiveContext | InvoicesLiveContextStop

export function stopInvoicesLiveContext(reasonCode: InvoicesLiveContextStopReason): InvoicesLiveContextStop {
  return {
    schemaVersion: INVOICES_LIVE_CONTEXT_SCHEMA,
    status: 'STOP',
    outcome: 'STOP',
    terminal: 'STOP',
    stop: true,
    code: 'INVOICES_LIVE_CONTEXT_STOP',
    reasonCode,
  }
}

/** Fail-closed: any unexpected shape or state on the source identity refuses, never guesses. */
export function createInvoicesLiveContext(input: InvoicesLiveContextInput): InvoicesLiveContextResult {
  const now = input?.now ?? Date.now()
  if (!Number.isFinite(now)) return stopInvoicesLiveContext('CLOCK_INVALID')

  const identity = input?.identity
  if (!isTargetIdentityLike(identity)) return stopInvoicesLiveContext('SOURCE_IDENTITY_INVALID')
  if (identity.profileName !== LIVE_DEMO_PROFILE) return stopInvoicesLiveContext('SOURCE_PROFILE_MISMATCH')
  if (identity.resource !== LIVE_DEMO_RESOURCE) return stopInvoicesLiveContext('SOURCE_RESOURCE_MISMATCH')
  if (identity.isDemoCompany !== true) return stopInvoicesLiveContext('DEMO_COMPANY_REQUIRED')
  if (!isIdentityFresh(identity, now)) return stopInvoicesLiveContext('IDENTITY_STALE')

  let invoicesIdentity: TargetIdentity
  try {
    invoicesIdentity = createTargetIdentity({
      profileName: identity.profileName,
      tenantId: identity.tenantId,
      resource: INVOICES_LIVE_CONTEXT_RESOURCE,
      objectId: identity.objectId,
      isDemoCompany: identity.isDemoCompany,
      observedAt: identity.observedAt,
      freshUntil: identity.freshUntil,
      capabilities: identity.capabilities,
      scopes: identity.scopes,
    })
  } catch {
    return stopInvoicesLiveContext('SOURCE_IDENTITY_INVALID')
  }

  const redacted = redactTargetIdentity(invoicesIdentity)
  return {
    ...redacted,
    schemaVersion: INVOICES_LIVE_CONTEXT_SCHEMA,
    resource: INVOICES_LIVE_CONTEXT_RESOURCE,
    isDemoCompany: true,
  }
}

function isTargetIdentityLike(value: unknown): value is TargetIdentity {
  if (!value || typeof value !== 'object') return false
  const identity = value as Record<string, unknown>
  return (
    typeof identity.profileName === 'string' &&
    typeof identity.tenantId === 'string' &&
    typeof identity.resource === 'string' &&
    typeof identity.isDemoCompany === 'boolean' &&
    typeof identity.observedAt === 'number' &&
    typeof identity.freshUntil === 'number'
  )
}
