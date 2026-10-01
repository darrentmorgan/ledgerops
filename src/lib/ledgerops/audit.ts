import {isSafeTargetBinding} from './identity.js'
import {defineSignedRecord, digest, finiteNumber, label, literal, oneOf} from './signed-record.js'
import {
  AUDIT_REASON_CODES,
  DISPATCH_STATES,
  MUTATION_OUTCOMES,
  READ_BACK_CLASSIFICATIONS,
  TERMINAL_STATES,
  type AuditReceipt,
  type AuditReasonCode,
  type DispatchState,
  type MutationOperation,
  type MutationOutcome,
  type ReadBackClassification,
  type ReceiptSink,
  type TargetBinding,
  type TerminalState,
  type WriteAheadIntent,
} from './types.js'

export const AUDIT_RECEIPT_SCHEMA = 'ledgerops.audit.v1' as const
export const WRITE_AHEAD_INTENT_SCHEMA = 'ledgerops.write-ahead.v1' as const

export interface AuditReceiptInput {
  recordedAt: number
  profileName: string
  resource: string
  operation: MutationOperation
  target: TargetBinding
  planDigest: string
  confirmationDigest: string
  requiredCapabilityFingerprint: string
  requiredScopeFingerprint: string
  dispatchState: DispatchState
  readBackClassification: ReadBackClassification
  outcome: MutationOutcome
  terminal: TerminalState
  reasonCode?: AuditReasonCode
}

function targetMatchesProfile(receipt: AuditReceipt): boolean {
  return receipt.target.profileName === receipt.profileName
}

function targetMatchesResource(receipt: AuditReceipt): boolean {
  return receipt.target.resource === receipt.resource
}

const auditReceiptRecord = defineSignedRecord<AuditReceipt, 'receiptId'>({
  label: 'ledgerops.audit.v1',
  digestField: 'receiptId',
  digestPreamble: {kind: 'ledgerops.receipt.v1'},
  fields: {
    schemaVersion: {check: literal(AUDIT_RECEIPT_SCHEMA)},
    recordedAt: {check: finiteNumber()},
    profileName: {check: label()},
    resource: {check: label()},
    operation: {check: label()},
    target: {check: isSafeTargetBinding},
    planDigest: {check: digest()},
    confirmationDigest: {check: digest()},
    requiredCapabilityFingerprint: {check: digest()},
    requiredScopeFingerprint: {check: digest()},
    objectCount: {check: literal(1)},
    maxObjects: {check: literal(1)},
    dispatchState: {check: oneOf(...DISPATCH_STATES)},
    readBackClassification: {check: oneOf(...READ_BACK_CLASSIFICATIONS)},
    outcome: {check: oneOf(...MUTATION_OUTCOMES)},
    terminal: {check: oneOf(...TERMINAL_STATES)},
    reasonCode: {check: oneOf(...AUDIT_REASON_CODES), optional: true},
  },
  invariants: [targetMatchesProfile, targetMatchesResource],
})

export const AUDIT_RECEIPT_ALLOWED_KEYS = auditReceiptRecord.keys

/** Construct a receipt from an allowlist; raw request data is intentionally unavailable here. */
export function createAuditReceipt(input: AuditReceiptInput): AuditReceipt {
  return auditReceiptRecord.create({
    schemaVersion: AUDIT_RECEIPT_SCHEMA,
    recordedAt: input.recordedAt,
    profileName: input.profileName,
    resource: input.resource,
    operation: input.operation,
    target: input.target,
    planDigest: input.planDigest,
    confirmationDigest: input.confirmationDigest,
    requiredCapabilityFingerprint: input.requiredCapabilityFingerprint,
    requiredScopeFingerprint: input.requiredScopeFingerprint,
    objectCount: 1,
    maxObjects: 1,
    dispatchState: input.dispatchState,
    readBackClassification: input.readBackClassification,
    outcome: input.outcome,
    terminal: input.terminal,
    reasonCode: input.reasonCode,
  })
}

export const isAuditReceipt = auditReceiptRecord.verify

/** Parse-don't-validate: journal readers act only on the snapshot this returns. */
export const parseAuditReceipt = auditReceiptRecord.parse

export interface WriteAheadIntentInput {
  recordedAt: number
  profileName: string
  resource: string
  operation: MutationOperation
  target: TargetBinding
  planDigest: string
  confirmationDigest: string
}

function intentTargetMatchesProfile(intent: WriteAheadIntent): boolean {
  return intent.target.profileName === intent.profileName
}

function intentTargetMatchesResource(intent: WriteAheadIntent): boolean {
  return intent.target.resource === intent.resource
}

const writeAheadIntentRecord = defineSignedRecord<WriteAheadIntent, 'entryId'>({
  label: 'ledgerops.write-ahead.v1',
  digestField: 'entryId',
  digestPreamble: {kind: 'ledgerops.write-ahead.v1'},
  fields: {
    schemaVersion: {check: literal(WRITE_AHEAD_INTENT_SCHEMA)},
    recordedAt: {check: finiteNumber()},
    profileName: {check: label()},
    resource: {check: label()},
    operation: {check: label()},
    target: {check: isSafeTargetBinding},
    planDigest: {check: digest()},
    confirmationDigest: {check: digest()},
  },
  invariants: [intentTargetMatchesProfile, intentTargetMatchesResource],
})

export const WRITE_AHEAD_INTENT_ALLOWED_KEYS = writeAheadIntentRecord.keys

/** The pre-dispatch journal entry the post-dispatch receipt finalizes (joined on planDigest). */
export function createWriteAheadIntent(input: WriteAheadIntentInput): WriteAheadIntent {
  return writeAheadIntentRecord.create({
    schemaVersion: WRITE_AHEAD_INTENT_SCHEMA,
    recordedAt: input.recordedAt,
    profileName: input.profileName,
    resource: input.resource,
    operation: input.operation,
    target: input.target,
    planDigest: input.planDigest,
    confirmationDigest: input.confirmationDigest,
  })
}

export const isWriteAheadIntent = writeAheadIntentRecord.verify

/** Parse-don't-validate: journal readers act only on the snapshot this returns. */
export const parseWriteAheadIntent = writeAheadIntentRecord.parse

export class InMemoryReceiptSink implements ReceiptSink {
  private readonly values: AuditReceipt[] = []
  private readonly intentValues: WriteAheadIntent[] = []

  writeAhead(intent: WriteAheadIntent): void {
    if (!isWriteAheadIntent(intent)) {
      throw new TypeError('Only LedgerOps write-ahead intents may be written')
    }
    this.intentValues.push(intent)
  }

  write(receipt: AuditReceipt): void {
    if (!isAuditReceipt(receipt)) throw new TypeError('Only LedgerOps audit receipts may be written')
    this.values.push(receipt)
  }

  get intents(): readonly WriteAheadIntent[] {
    return this.intentValues.slice()
  }

  get receipts(): readonly AuditReceipt[] {
    return this.values.slice()
  }

  clear(): void {
    this.values.length = 0
    this.intentValues.length = 0
  }
}
