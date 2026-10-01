import {createTargetIdentity, isIdentityFresh, redactTargetIdentity} from './identity.js'
import type {RedactedTargetIdentity} from './types.js'

export const LIVE_IDENTITY_RECEIPT_SCHEMA = 'ledgerops.identity.receipt.v1' as const
export const LIVE_DEMO_PROFILE = 'demo-au' as const
export const LIVE_DEMO_RESOURCE = 'organisation-identity' as const

export const LIVE_IDENTITY_CAPABILITIES = ['accounting.settings.read'] as const
export const LIVE_IDENTITY_SCOPES = ['openid', 'profile', 'email', 'offline_access', 'accounting.settings'] as const

const LIVE_IDENTITY_FRESHNESS_MS = 5 * 60 * 1000

export type LiveIdentityStopReason =
  | 'LIVE_FLAG_REQUIRED'
  | 'PROFILE_REQUIRED'
  | 'PROFILE_MISMATCH'
  | 'RESOURCE_REQUIRED'
  | 'RESOURCE_MISMATCH'
  | 'DEMO_EXPECTATION_REQUIRED'
  | 'INPUT_CONFLICT'
  | 'TRANSPORT_INVALID'
  | 'CLOCK_INVALID'
  | 'IDENTITY_INVALID'
  | 'IDENTITY_STALE'
  | 'CONFIG_MISSING'
  | 'TOKEN_MISSING'
  | 'TOKEN_NEAR_EXPIRY'
  | 'TOKEN_DECRYPT_FAILED'
  | 'TOKEN_INVALID'
  | 'AUTH_FAILED'
  | 'CONNECTION_COUNT'
  | 'ORGANISATION_COUNT'
  | 'IDENTITY_MISMATCH'
  | 'DEMO_COMPANY_REQUIRED'
  | 'TRANSPORT_FAILED'

export interface LiveIdentityObservation {
  readonly tenantId: string
  readonly organisationId: string
  readonly isDemoCompany: boolean
  readonly capabilities?: readonly string[]
  readonly scopes?: readonly string[]
}

export interface LiveIdentityTransportRequest {
  readonly profileName: typeof LIVE_DEMO_PROFILE
  readonly resource: typeof LIVE_DEMO_RESOURCE
  readonly now: number
}

export interface LiveIdentityTransport {
  read(input: LiveIdentityTransportRequest): LiveIdentityObservation | Promise<LiveIdentityObservation>
}

export interface LiveIdentityClock {
  now(): number
}

export interface LiveIdentityVerificationInput {
  readonly profileName?: string
  readonly resource?: string
  readonly liveDemo?: boolean
  readonly expectDemoCompany?: boolean
  readonly inputProvided?: boolean
  readonly transport: LiveIdentityTransport
  readonly clock?: LiveIdentityClock
}

export interface LiveIdentityReceipt {
  readonly schemaVersion: typeof LIVE_IDENTITY_RECEIPT_SCHEMA
  readonly profileName: typeof LIVE_DEMO_PROFILE
  readonly resource: typeof LIVE_DEMO_RESOURCE
  readonly targetFingerprint: string
  readonly isDemoCompany: true
  readonly observedAt: number
  readonly freshUntil: number
  readonly capabilitiesFingerprint: string
  readonly scopesFingerprint: string
}

export interface LiveIdentityStopReceipt {
  readonly schemaVersion: typeof LIVE_IDENTITY_RECEIPT_SCHEMA
  readonly status: 'STOP'
  readonly outcome: 'STOP'
  readonly terminal: 'STOP'
  readonly stop: true
  readonly code: 'LIVE_IDENTITY_STOP'
  readonly reasonCode: LiveIdentityStopReason
}

export type LiveIdentityResult = LiveIdentityReceipt | LiveIdentityStopReceipt

/** Internal typed boundary for production adapters; its message is never emitted. */
export class LiveIdentityFailure extends Error {
  readonly reasonCode: LiveIdentityStopReason

  constructor(reasonCode: LiveIdentityStopReason) {
    super(reasonCode)
    this.name = 'LiveIdentityFailure'
    this.reasonCode = reasonCode
  }
}

export function stopLiveIdentity(reasonCode: LiveIdentityStopReason): LiveIdentityStopReceipt {
  return {
    schemaVersion: LIVE_IDENTITY_RECEIPT_SCHEMA,
    status: 'STOP',
    outcome: 'STOP',
    terminal: 'STOP',
    stop: true,
    code: 'LIVE_IDENTITY_STOP',
    reasonCode,
  }
}

export async function verifyLiveDemoIdentity(input: LiveIdentityVerificationInput): Promise<LiveIdentityResult> {
  const flagResult = validateLiveFlags(input)
  if (flagResult) return stopLiveIdentity(flagResult)

  if (!input.transport || typeof input.transport.read !== 'function') {
    return stopLiveIdentity('TRANSPORT_INVALID')
  }

  const clock = input.clock ?? {now: () => Date.now()}
  let observedAt: number
  try {
    observedAt = clock.now()
  } catch {
    return stopLiveIdentity('CLOCK_INVALID')
  }
  if (!Number.isFinite(observedAt)) return stopLiveIdentity('CLOCK_INVALID')

  let observation: LiveIdentityObservation
  try {
    observation = await input.transport.read({
      profileName: LIVE_DEMO_PROFILE,
      resource: LIVE_DEMO_RESOURCE,
      now: observedAt,
    })
  } catch (error) {
    return stopLiveIdentity(error instanceof LiveIdentityFailure ? error.reasonCode : 'TRANSPORT_FAILED')
  }

  if (!validObservation(observation)) return stopLiveIdentity('IDENTITY_INVALID')
  if (observation.isDemoCompany !== true) return stopLiveIdentity('DEMO_COMPANY_REQUIRED')
  if (observation.tenantId !== observation.organisationId) {
    return stopLiveIdentity('IDENTITY_MISMATCH')
  }

  let redacted: RedactedTargetIdentity
  try {
    const identity = createTargetIdentity({
      profileName: LIVE_DEMO_PROFILE,
      resource: LIVE_DEMO_RESOURCE,
      tenantId: observation.tenantId,
      objectId: observation.organisationId,
      isDemoCompany: true,
      observedAt,
      freshnessMs: LIVE_IDENTITY_FRESHNESS_MS,
      capabilities: observation.capabilities ?? LIVE_IDENTITY_CAPABILITIES,
      scopes: observation.scopes ?? LIVE_IDENTITY_SCOPES,
    })
    if (!isIdentityFresh(identity, observedAt)) return stopLiveIdentity('IDENTITY_STALE')
    redacted = redactTargetIdentity(identity)
  } catch {
    return stopLiveIdentity('IDENTITY_INVALID')
  }

  return {
    schemaVersion: LIVE_IDENTITY_RECEIPT_SCHEMA,
    profileName: LIVE_DEMO_PROFILE,
    resource: LIVE_DEMO_RESOURCE,
    targetFingerprint: redacted.targetFingerprint,
    isDemoCompany: true,
    observedAt: redacted.observedAt,
    freshUntil: redacted.freshUntil,
    capabilitiesFingerprint: redacted.capabilitiesFingerprint,
    scopesFingerprint: redacted.scopesFingerprint,
  }
}

function validateLiveFlags(input: LiveIdentityVerificationInput): LiveIdentityStopReason | undefined {
  if (input.liveDemo !== true) return 'LIVE_FLAG_REQUIRED'
  if (input.profileName === undefined) return 'PROFILE_REQUIRED'
  if (input.profileName !== LIVE_DEMO_PROFILE) return 'PROFILE_MISMATCH'
  if (input.resource === undefined) return 'RESOURCE_REQUIRED'
  if (input.resource !== LIVE_DEMO_RESOURCE) return 'RESOURCE_MISMATCH'
  if (input.expectDemoCompany !== true) return 'DEMO_EXPECTATION_REQUIRED'
  if (input.inputProvided === true) return 'INPUT_CONFLICT'
  return undefined
}

function validObservation(value: unknown): value is LiveIdentityObservation {
  if (!value || typeof value !== 'object') return false
  const observation = value as Record<string, unknown>
  return (
    typeof observation.tenantId === 'string' &&
    observation.tenantId.trim() !== '' &&
    typeof observation.organisationId === 'string' &&
    observation.organisationId.trim() !== '' &&
    typeof observation.isDemoCompany === 'boolean' &&
    (observation.capabilities === undefined || validStringArray(observation.capabilities)) &&
    (observation.scopes === undefined || validStringArray(observation.scopes))
  )
}

function validStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string' && item.trim() !== '')
}
