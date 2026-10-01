import type {Digest, JsonPrimitive, JsonValue} from './canonical.js'

export type MutationOperation = 'create' | 'update' | 'delete' | 'archive' | 'restore' | (string & {})

export interface TargetIdentityInput {
  profileName: string
  tenantId: string
  resource: string
  objectId?: string
  isDemoCompany: boolean
  observedAt: number
  freshUntil?: number
  freshnessMs?: number
  capabilities?: readonly string[]
  scopes?: readonly string[]
}

export interface TargetIdentity {
  readonly profileName: string
  readonly tenantId: string
  readonly resource: string
  readonly objectId?: string
  readonly isDemoCompany: boolean
  readonly observedAt: number
  readonly freshUntil: number
  readonly capabilities: readonly string[]
  readonly scopes: readonly string[]
  readonly capabilitiesFingerprint: Digest
  readonly scopesFingerprint: Digest
}

/** A target contract safe to put in an audit record or a plan. */
export interface TargetBinding {
  readonly profileName: string
  readonly resource: string
  readonly tenantFingerprint: Digest
  readonly objectFingerprint?: Digest
  readonly targetFingerprint: Digest
}

export interface RedactedTargetIdentity extends TargetBinding {
  readonly isDemoCompany: boolean
  readonly observedAt: number
  readonly freshUntil: number
  readonly capabilitiesFingerprint: Digest
  readonly scopesFingerprint: Digest
}

/**
 * Read-back fields whose value carries authority (e.g. the DRAFT tier lives in
 * `status`). A declared projection may not hide a change to any of these: they
 * are checked against the expectation outside the projected digest, and an
 * authority field appearing or vanishing on the read-back record fails closed.
 */
export const READ_BACK_AUTHORITY_KEYS = ['status'] as const

export type ReadBackAuthorityKey = (typeof READ_BACK_AUTHORITY_KEYS)[number]

/** One signed expected value for an authority-relevant field. */
export interface ReadBackAuthorityRequirement {
  readonly key: ReadBackAuthorityKey
  readonly value: JsonPrimitive
}

export interface ReadBackExpectation {
  readonly schemaVersion: 'ledgerops.readback.v1'
  readonly resource: string
  readonly targetBinding: TargetBinding
  readonly expectedDigest: Digest
  readonly maxMatches: 1
  /**
   * Explicit projection narrowing the equality digest to the named top-level
   * fields. Absent means the whole record participates (the v1 behavior);
   * present it is sorted, unique, and covered by the expectation digest.
   *
   * No minimum size is imposed (issue #71): a one-field projection is valid,
   * and the VERIFIED it can produce is scoped to exactly these fields plus the
   * authority keys. Anyone reading a `verified` classification off a plan
   * should read this list too — it is the full extent of what was compared.
   */
  readonly projection?: readonly string[]
  /** Signed expected values for the authority keys present in the expected record. */
  readonly authority?: readonly ReadBackAuthorityRequirement[]
  readonly expectationDigest: Digest
}

export interface MutationPlan {
  readonly schemaVersion: 'ledgerops.plan.v1'
  readonly planId: string
  readonly profileName: string
  readonly resource: string
  readonly operation: MutationOperation
  readonly targetBinding: TargetBinding
  readonly payload: JsonValue
  readonly payloadDigest: Digest
  readonly requiredCapability: string
  readonly requiredCapabilities: readonly string[]
  readonly requiredScope: string
  readonly requiredScopes: readonly string[]
  readonly capabilitiesFingerprint: Digest
  readonly scopesFingerprint: Digest
  readonly readBackExpectation: ReadBackExpectation
  readonly objectCount: 1
  readonly maxObjects: 1
  readonly requiresDemoCompany: true
  readonly createdAt: number
  readonly expiresAt: number
  readonly planDigest: Digest
}

/**
 * ADR-0011 batch manifests. `halt-on-stop` is the default; `continue-on-stop`
 * is opted into at planning time, sealed into the manifest digest, and applies
 * only to pre-dispatch STOPs.
 */
export const BATCH_HALT_POLICIES = ['halt-on-stop', 'continue-on-stop'] as const

export type BatchHaltPolicy = (typeof BATCH_HALT_POLICIES)[number]

/** One exact member identity. Two keys only: a manifest may not nest a manifest. */
export interface BatchManifestEntry {
  readonly planId: string
  readonly planDigest: Digest
}

/** The sealed source every member plan shares, so a batch traces to one origin. */
export interface BatchProvenance {
  readonly sourceReceiptId: Digest
  /** Non-empty, unique, sorted. */
  readonly sourceManifestHashes: readonly Digest[]
}

export interface BatchManifest {
  readonly schemaVersion: 'ledgerops.batch-manifest.v1' | 'ledgerops.batch-manifest.v2'
  readonly tenantFingerprint?: Digest
  readonly batchId: string
  readonly profileName: string
  readonly provenance: BatchProvenance
  /** Ordered 1 to 50 members; the order is part of what the digest seals. */
  readonly entries: readonly BatchManifestEntry[]
  readonly memberCount: number
  readonly haltPolicy: BatchHaltPolicy
  readonly createdAt: number
  readonly expiresAt: number
  readonly manifestDigest: Digest
}

/**
 * ADR-0011: before the first write-ahead record, the batch executor preflights
 * the complete member set over defensive parsed snapshots. Every failure mode
 * is fail-closed and dispatches nothing; a member-level failure carries the
 * zero-based `index` into `manifest.entries` (and the caller's aligned `plans`
 * array) that failed. `manifest.entries[].planId` is sealed verbatim (never
 * trimmed) — comparisons against a supplied plan's `planId` are exact-byte.
 */
export const BATCH_PREFLIGHT_FAILURE_CODES = [
  'MANIFEST_INVALID',
  'MANIFEST_EXPIRED',
  'MEMBER_COUNT_MISMATCH',
  'PLAN_INVALID',
  'PLAN_ID_MISMATCH',
  'PLAN_DIGEST_MISMATCH',
  'PROFILE_MISMATCH',
  'TENANT_MISMATCH',
  'PLAN_EXPIRED',
] as const

export type BatchPreflightFailureCode = (typeof BATCH_PREFLIGHT_FAILURE_CODES)[number]

export interface BatchPreflightSuccess {
  readonly ok: true
  /** The parsed manifest snapshot; the batch executor acts on this, never the caller's object. */
  readonly manifest: BatchManifest
  /** Parsed plan snapshots, in manifest order — one per `manifest.entries` member. */
  readonly plans: readonly MutationPlan[]
}

export interface BatchPreflightFailure {
  readonly ok: false
  readonly code: BatchPreflightFailureCode
  /** Zero-based member index for a per-member failure; absent for a manifest-level failure. */
  readonly index?: number
}

export type BatchPreflightDecision = BatchPreflightSuccess | BatchPreflightFailure

/**
 * ADR-0011: every `MutationExecutionResult` outcome the batch executor can
 * return maps to exactly one of these member states. `not-attempted` covers a
 * member skipped after a halt and never reaches the kernel, so it is the only
 * state that never carries a `receiptId`.
 */
export const BATCH_ITEM_OUTCOMES = [
  'accepted',
  'stopped',
  'dispatched-unverified',
  'uncertain',
  'not-attempted',
] as const

export type BatchItemOutcome = (typeof BATCH_ITEM_OUTCOMES)[number]

/**
 * One append-only ledger entry per batch member, written through the same
 * write-ahead sink as the receipts it links. `ledgerops.audit.v1` stays
 * untouched (ADR-0011 receipt rule) — batch context lives here instead.
 */
export interface BatchLink {
  readonly schemaVersion: 'ledgerops.batch-link.v1'
  readonly batchId: string
  readonly manifestDigest: Digest
  readonly index: number
  readonly planId: string
  readonly planDigest: Digest
  readonly outcome: BatchItemOutcome
  readonly receiptId?: Digest
  readonly linkDigest: Digest
}

/** One member's outcome as summarized in the closing batch receipt. */
export interface BatchReceiptItem {
  readonly planId: string
  readonly outcome: BatchItemOutcome
  readonly receiptId?: Digest
}

export interface BatchReceiptCounts {
  readonly accepted: number
  readonly stopped: number
  readonly dispatchedUnverified: number
  readonly uncertain: number
  readonly notAttempted: number
}

/**
 * The closing `ledgerops.batch-receipt.v1` record: counts plus per-item
 * outcome/receipt refs, plus the same provenance block as the manifest it
 * closes. It attests coverage — every member is accounted for — and never
 * replaces the per-item `ledgerops.audit.v1` receipts.
 */
export interface BatchReceipt {
  readonly schemaVersion: 'ledgerops.batch-receipt.v1'
  readonly batchId: string
  readonly manifestDigest: Digest
  readonly provenance: BatchProvenance
  readonly items: readonly BatchReceiptItem[]
  readonly counts: BatchReceiptCounts
  readonly recordedAt: number
  readonly batchReceiptDigest: Digest
}

export interface MutationRequest {
  readonly profileName: string
  readonly resource: string
  readonly operation: MutationOperation
  readonly payload: unknown
  readonly objectCount?: number
  readonly target?: TargetIdentity
  readonly readBackExpectation?: ReadBackExpectation
}

export interface WriteAheadIntent {
  readonly schemaVersion: 'ledgerops.write-ahead.v1'
  readonly entryId: Digest
  readonly recordedAt: number
  readonly profileName: string
  readonly resource: string
  readonly operation: MutationOperation
  readonly target: TargetBinding
  readonly planDigest: Digest
  readonly confirmationDigest: Digest
}

export interface ReceiptSink {
  /**
   * Persist a write-ahead intent before dispatch. A throw here is the sink
   * proving it cannot persist; the executor must then STOP without dispatching.
   */
  writeAhead(intent: WriteAheadIntent): void | Promise<void>
  write(receipt: AuditReceipt): void | Promise<void>
}

/**
 * ADR-0011 batch records, appended through the same durable store as
 * write-ahead intents and audit receipts (ADR-0009). One typed method per
 * record label — no generic `write(any)` escape hatch — so an unregistered
 * shape is rejected at the call site, not accepted and silently stored.
 */
export interface BatchRecordSink {
  writeBatchManifest(manifest: BatchManifest): void | Promise<void>
  writeBatchLink(link: BatchLink): void | Promise<void>
  writeBatchReceipt(receipt: BatchReceipt): void | Promise<void>
}

export interface MutationGuardContext {
  readonly profileName?: string
  readonly identity?: TargetIdentity
  readonly capabilities?: readonly string[]
  readonly scopes?: readonly string[]
  readonly receiptSink?: ReceiptSink
  readonly now?: number
}

export const GUARD_FAILURE_CODES = [
  'PROFILE_REQUIRED',
  'PROFILE_MISMATCH',
  'IDENTITY_REQUIRED',
  'IDENTITY_STALE',
  'TARGET_MISMATCH',
  'DEMO_COMPANY_REQUIRED',
  'CAPABILITY_REQUIRED',
  'SCOPE_REQUIRED',
  'PLAN_TAMPERED',
  'PLAN_EXPIRED',
  'PLAN_COUNT_BOUND',
  'RESOURCE_MISMATCH',
  'OPERATION_MISMATCH',
  'PAYLOAD_MISMATCH',
  'READBACK_EXPECTATION_REQUIRED',
  'READBACK_EXPECTATION_MISMATCH',
  'CONFIRMATION_MISMATCH',
  'RECEIPT_SINK_REQUIRED',
  'INVALID_REQUEST',
] as const

export type GuardFailureCode = (typeof GUARD_FAILURE_CODES)[number]

export interface MutationGuardSuccess {
  readonly allowed: true
  readonly code: 'ALLOWED'
  readonly binding: TargetBinding
  /** The parsed plan snapshot; dispatch and receipts act on this, never the caller's plan object. */
  readonly plan: MutationPlan
}

export interface MutationGuardFailure {
  readonly allowed: false
  readonly code: GuardFailureCode
}

export type MutationGuardDecision = MutationGuardSuccess | MutationGuardFailure

export type ReadBackTransportResult =
  | {readonly status: 'found'; readonly records: readonly unknown[]}
  | {readonly status: 'missing'}
  | {readonly status: 'ambiguous'; readonly records?: readonly unknown[]}

/**
 * What `classifyReadBack` concluded. `verified` is the narrow claim (issue
 * #71): **the declared projection matched, and no authority key moved.** It is
 * not a statement that the live record equals the planned payload. When the
 * expectation carries no projection the two coincide — the whole record is
 * compared — but under a projection, `verified` says nothing about any field
 * outside it. There is deliberately no minimum-projection floor; the caller
 * that declares the projection owns how much the resulting `verified` is
 * worth. See `createReadBackExpectation` and ADR-0011's issue-#71 amendment.
 */
export const READ_BACK_CLASSIFICATIONS = ['verified', 'mismatch', 'missing', 'ambiguous', 'not-run'] as const

export type ReadBackClassification = (typeof READ_BACK_CLASSIFICATIONS)[number]

export interface TransportDispatchRequest {
  readonly operation: MutationOperation
  readonly payload: JsonValue
  readonly targetBinding: TargetBinding
  readonly planDigest: Digest
}

export interface TransportDispatchResult {
  readonly accepted: boolean
}

export interface TransportReadBackRequest {
  readonly targetBinding: TargetBinding
  readonly planDigest: Digest
}

/**
 * The one seam between the kernel and a remote system. Only fingerprints cross
 * it: raw identity stays kernel-side, and an adapter is told what to write, not
 * who to write it as.
 *
 * - An adapter is constructed bound to exactly one target, and `binding` is that
 *   target's redacted binding. The kernel re-checks it before every dispatch.
 * - On any internal binding or credential mismatch an adapter must THROW.
 *   Returning `{accepted: false}` would falsely claim the remote answered.
 * - The kernel owns sequencing: one dispatch, one read-back, no retry. An
 *   adapter never loops, never reorders, and never dispatches on its own.
 * - Read-back returns raw records; classifying them against the plan's
 *   expectation is the kernel's job, not the adapter's.
 */
export interface MutationTransport {
  readonly binding: TargetBinding
  dispatch(input: TransportDispatchRequest): TransportDispatchResult | Promise<TransportDispatchResult>
  readBack(input: TransportReadBackRequest): ReadBackTransportResult | Promise<ReadBackTransportResult>
}

export const MUTATION_OUTCOMES = ['VERIFIED', 'MISMATCH', 'MISSING', 'AMBIGUOUS', 'STOP', 'UNCERTAIN'] as const

export type MutationOutcome = (typeof MUTATION_OUTCOMES)[number]
export type MutationStatus = 'verified' | 'mismatch' | 'missing' | 'ambiguous' | 'stop' | 'uncertain'

export const DISPATCH_STATES = ['not-dispatched', 'attempted', 'accepted'] as const

export type DispatchState = (typeof DISPATCH_STATES)[number]

export const TERMINAL_STATES = ['CONTINUE', 'STOP'] as const

export type TerminalState = (typeof TERMINAL_STATES)[number]

export const AUDIT_REASON_CODES = [
  ...GUARD_FAILURE_CODES,
  'TRANSPORT_BINDING_MISMATCH',
  'DISPATCH_UNCERTAIN',
  'DISPATCH_REJECTED',
  'READBACK_UNCERTAIN',
  'RECEIPT_WRITE_FAILED',
  'RECEIPT_SINK_UNAVAILABLE',
] as const

export type AuditReasonCode = (typeof AUDIT_REASON_CODES)[number]

export interface AuditReceipt {
  readonly schemaVersion: 'ledgerops.audit.v1'
  readonly receiptId: Digest
  readonly recordedAt: number
  readonly profileName: string
  readonly resource: string
  readonly operation: MutationOperation
  readonly target: TargetBinding
  readonly planDigest: Digest
  readonly confirmationDigest: Digest
  readonly requiredCapabilityFingerprint: Digest
  readonly requiredScopeFingerprint: Digest
  readonly objectCount: 1
  readonly maxObjects: 1
  readonly dispatchState: DispatchState
  readonly readBackClassification: ReadBackClassification
  readonly outcome: MutationOutcome
  readonly terminal: TerminalState
  readonly reasonCode?: AuditReasonCode
}

export interface MutationExecutionInput {
  readonly request: MutationRequest
  readonly plan: MutationPlan
  readonly confirmation: string
  readonly context: MutationGuardContext
  readonly transport: MutationTransport
  readonly now?: number
}

export interface MutationExecutionResult {
  readonly status: MutationStatus
  readonly outcome: MutationOutcome
  readonly terminal: TerminalState
  readonly stop: boolean
  readonly dispatched: boolean
  readonly dispatchState: DispatchState
  readonly readBackClassification: ReadBackClassification
  readonly guard: MutationGuardDecision
  readonly receipt: AuditReceipt
  readonly receiptWriteFailed: boolean
}
