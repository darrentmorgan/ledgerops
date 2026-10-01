import {defineSignedRecord, digest, finiteNumber, literal} from './signed-record.js'

export const REPLAY_CLAIM_SCHEMA = 'ledgerops.replay-claim.v1' as const

/** Durable ownership of an operation, independent of individual plan timestamps. */
export interface ReplayClaim {
  readonly schemaVersion: typeof REPLAY_CLAIM_SCHEMA
  readonly recordedAt: number
  readonly operationId: string
  readonly planDigest: string
  readonly claimId: string
}

export interface ReplayClaimInput {
  readonly recordedAt: number
  readonly operationId: string
  readonly planDigest: string
}

const record = defineSignedRecord<ReplayClaim, 'claimId'>({
  label: REPLAY_CLAIM_SCHEMA,
  digestField: 'claimId',
  digestPreamble: {kind: REPLAY_CLAIM_SCHEMA},
  fields: {
    schemaVersion: {check: literal(REPLAY_CLAIM_SCHEMA)},
    recordedAt: {check: finiteNumber()},
    operationId: {check: digest()},
    planDigest: {check: digest()},
  },
})

export const REPLAY_CLAIM_ALLOWED_KEYS = record.keys
export const isReplayClaim = record.verify

/** The caller derives operationId from its own stable operation identity. */
export function createReplayClaim(input: ReplayClaimInput): ReplayClaim {
  return record.create({
    schemaVersion: REPLAY_CLAIM_SCHEMA,
    recordedAt: input.recordedAt,
    operationId: input.operationId,
    planDigest: input.planDigest,
  })
}
