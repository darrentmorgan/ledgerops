import type {OutputFormat} from '../formatters.js'
import type {AuditReasonCode, BatchItemOutcome, BatchReceiptCounts} from './types.js'
import type {BatchExecutionSuccess} from './batch-executor.js'

/**
 * ADR-0011/issue #62: one honest account of a batch run, projected from
 * `executeBatch`'s own result. This module is pure — no I/O, no sink, no
 * transport — and additive: it reads the executor's typed output and reports
 * it back exactly, never rewriting a reason code and never hiding a member
 * behind another member's success.
 *
 * CRITICAL: `BatchExecutionSuccess.ok` is `true` even when `runState` is
 * `'UNCERTAIN'` (a durable-sink failure after otherwise-successful dispatch
 * work). This projection therefore branches on `runState` and per-member
 * `outcome`, never on `ok` alone — an `ok: true` run with `runState:
 * 'UNCERTAIN'` is reported as uncertain, not as success.
 *
 * Scope: this projects `executeBatch`'s `BatchExecutionSuccess` only, not
 * `reconstructBatchCoverage`'s `BatchCoverageSuccess`. A coverage member
 * carries no reason code — it has no `MutationExecutionResult` to read one
 * from, only a `receiptId` reference — so accepting both shapes would mean
 * the same schema silently omits `reasonCode` half the time depending on
 * which caller built it. The executor's result is the richer, honest
 * surface; a coverage-shaped projection is additive later work if a caller
 * needs one.
 */

export const BATCH_RESULT_SCHEMA_VERSION = 'ledgerops.batch-result.v1'

/** One member as this run left it, with its reason code passed through exactly. */
export interface BatchResultItem {
  readonly index: number
  readonly planId: string
  readonly planDigest: string
  readonly outcome: BatchItemOutcome
  /** Present only when a per-item receipt was durably written. */
  readonly receiptId?: string
  /** The kernel's own SCREAMING_SNAKE reason code, passed through unrewritten. */
  readonly reasonCode?: AuditReasonCode
}

export interface BatchResult {
  readonly schemaVersion: typeof BATCH_RESULT_SCHEMA_VERSION
  readonly batchId: string
  readonly manifestDigest: string
  /** `CLOSED` only when the closing batch receipt is durable. */
  readonly runState: 'CLOSED' | 'UNCERTAIN'
  readonly halted: boolean
  readonly haltedAtIndex?: number
  readonly counts: BatchReceiptCounts
  /** One entry per sealed member, in manifest order. Nothing is omitted. */
  readonly items: readonly BatchResultItem[]
}

/**
 * Projects `executeBatch`'s success result into the stable, versioned
 * `ledgerops.batch-result.v1` shape. Every member is reported — accepted,
 * stopped, dispatched-unverified, uncertain, and not-attempted alike — so a
 * caller reading only this record can never mistake a partial run for a
 * clean one, and never lose a successful item to a later failure.
 */
export function projectBatchResult(execution: BatchExecutionSuccess): BatchResult {
  const items: BatchResultItem[] = execution.members.map(member => {
    const reasonCode = member.result?.receipt.reasonCode
    return {
      index: member.index,
      planId: member.planId,
      planDigest: member.planDigest,
      outcome: member.outcome,
      ...(member.receiptId === undefined ? {} : {receiptId: member.receiptId}),
      ...(reasonCode === undefined ? {} : {reasonCode}),
    }
  })

  return Object.freeze({
    schemaVersion: BATCH_RESULT_SCHEMA_VERSION,
    batchId: execution.manifest.batchId,
    manifestDigest: execution.manifest.manifestDigest,
    runState: execution.runState,
    halted: execution.halted,
    ...(execution.haltedAtIndex === undefined ? {} : {haltedAtIndex: execution.haltedAtIndex}),
    counts: execution.counts,
    items: Object.freeze(items),
  })
}

/**
 * Plain-language labels for each outcome. Roadmap v3's interface rule: human
 * rendering reads without kernel knowledge — a reader should never need to
 * know what a "pre-dispatch STOP" or a "dispatch state" is.
 *
 * `accepted` is worded to the exact strength of the claim behind it (issue
 * #71). It comes from a VERIFIED read-back, and VERIFIED means the read-back
 * matched *what the plan declared it would check* — the whole record when the
 * expectation carries no projection, only the projected fields when it does.
 * The bare word "accepted" invited the reader to hear "everything matched", so
 * it now says what was actually compared. Human table only; the machine JSON
 * (`ledgerops.batch-result.v1`) keeps emitting the bare `accepted` token
 * byte-identically (ADR-0002) and never reads this map.
 */
const OUTCOME_LABELS: Record<BatchItemOutcome, string> = {
  accepted: 'accepted — read back and matched what the plan checked',
  stopped: 'stopped before it reached Xero',
  'dispatched-unverified': 'sent to Xero, but not confirmed',
  uncertain: 'outcome unknown',
  'not-attempted': 'never attempted',
}

/**
 * Plain-language labels for each `AuditReasonCode` that can reach a batch
 * member (issue #86). This is a total map, checked at compile time by
 * `Record<AuditReasonCode, string>` — a code added to the union without a
 * label here fails the build. Human table rendering only; the machine JSON
 * (`ledgerops.batch-result.v1`) keeps passing codes through byte-identically
 * (ADR-0002) and never reads this map.
 */
const REASON_CODE_LABELS: Record<AuditReasonCode, string> = {
  PROFILE_REQUIRED: 'no profile was given for the mutation',
  PROFILE_MISMATCH: 'the profile did not match the plan',
  IDENTITY_REQUIRED: 'no verified identity was present',
  IDENTITY_STALE: 'the organisation identity could not be trusted (stale, malformed, or tampered)',
  TARGET_MISMATCH: 'the live target did not match the plan',
  DEMO_COMPANY_REQUIRED: 'the target was not the demo company',
  CAPABILITY_REQUIRED: 'the required capability was missing',
  SCOPE_REQUIRED: 'the required scope was missing',
  PLAN_TAMPERED: 'the plan did not match its sealed digest',
  PLAN_EXPIRED: 'the plan expired before it was sent',
  PLAN_COUNT_BOUND: 'the plan covered more than one object',
  RESOURCE_MISMATCH: 'the resource did not match the plan',
  OPERATION_MISMATCH: 'the operation did not match the plan',
  PAYLOAD_MISMATCH: 'the payload did not match the plan',
  READBACK_EXPECTATION_REQUIRED: 'no read-back expectation was set',
  READBACK_EXPECTATION_MISMATCH: 'the read-back expectation did not match the plan',
  CONFIRMATION_MISMATCH: 'the confirmation did not match the plan',
  RECEIPT_SINK_REQUIRED: 'no receipt sink was configured',
  INVALID_REQUEST: 'the request was not valid',
  TRANSPORT_BINDING_MISMATCH: 'the transport target did not match the plan',
  DISPATCH_UNCERTAIN: 'it is not known if the mutation reached Xero',
  DISPATCH_REJECTED: 'Xero rejected the mutation',
  READBACK_UNCERTAIN: 'the read-back check could not confirm the result',
  RECEIPT_WRITE_FAILED: 'the receipt could not be written',
  RECEIPT_SINK_UNAVAILABLE: 'the receipt sink was not available',
}

/**
 * Plain-language rendering of one `AuditReasonCode`, for the human table
 * only. Every code in `REASON_CODE_LABELS` reads as a calm sentence with the
 * raw code kept visible in parentheses, so a reader never needs kernel
 * knowledge but a reviewer can always find the exact code (auditability). A
 * code that somehow isn't in the map (a future addition to the runtime union
 * that outran this file, or a value carried past the type at runtime) still
 * renders safely and keeps the raw code visible — it never crashes and never
 * hides the code.
 */
export function humanizeReasonCode(code: AuditReasonCode): string {
  const label = REASON_CODE_LABELS[code]
  return label === undefined ? `an unrecognized reason was returned (${code})` : `${label} (${code})`
}

/** Human table lines, in plain words — no schema names, digests-as-jargon, or kernel states. */
export function renderBatchResultText(result: BatchResult): readonly string[] {
  const lines: string[] = []

  lines.push(
    result.runState === 'CLOSED'
      ? `Batch ${result.batchId}: run closed.`
      : `Batch ${result.batchId}: run outcome is UNCERTAIN — verify manually before treating this as done.`,
  )

  lines.push(
    `  accepted ${result.counts.accepted}` +
      ` · stopped ${result.counts.stopped}` +
      ` · sent but unconfirmed ${result.counts.dispatchedUnverified}` +
      ` · uncertain ${result.counts.uncertain}` +
      ` · not attempted ${result.counts.notAttempted}`,
  )

  for (const item of result.items) {
    const label = OUTCOME_LABELS[item.outcome]
    const receipt = item.receiptId === undefined ? '' : `, receipt ${item.receiptId}`
    const reason = item.reasonCode === undefined ? '' : `, reason: ${humanizeReasonCode(item.reasonCode)}`
    lines.push(`  [${item.index}] ${item.planId}: ${label}${receipt}${reason}`)
  }

  return lines
}

/**
 * Renders the batch result for a caller. `table` (the interactive default)
 * stays plain-language human text; every other format is the stable, versioned
 * JSON alone — nothing else on the line, so machine mode never has to be
 * parsed out of a human sentence.
 */
export function renderBatchResult(result: BatchResult, format: OutputFormat = 'table'): string {
  if (format === 'table') return renderBatchResultText(result).join('\n')
  return JSON.stringify(result, null, 2)
}
