import {digestJson} from './canonical.js'
import {confirmationDigestFor} from './confirmation.js'
import {createAuditReceipt, createWriteAheadIntent, type AuditReceiptInput} from './audit.js'
import {evaluateMutationGuard} from './guard.js'
import {isSafeTargetBinding, sameBinding} from './identity.js'
import {classifyReadBack} from './readback.js'
import type {
  AuditReasonCode,
  DispatchState,
  MutationExecutionInput,
  MutationExecutionResult,
  MutationGuardDecision,
  MutationPlan,
  MutationRequest,
  MutationTransport,
  ReadBackClassification,
  TargetBinding,
} from './types.js'

/** Execute one guarded dispatch and one read-back; there is deliberately no retry loop. */
export async function executeMutation(input: MutationExecutionInput): Promise<MutationExecutionResult> {
  if (!isStrictExecutionInput(input)) {
    const safeInput = normalizeForStop(input)
    return finish(
      safeInput,
      {allowed: false, code: 'INVALID_REQUEST'},
      'STOP',
      'stop',
      'STOP',
      true,
      'not-dispatched',
      'not-run',
      'INVALID_REQUEST',
      safeInput.now ?? safeInput.context.now ?? Date.now(),
    )
  }

  const richInput = input
  let guard: MutationGuardDecision
  try {
    const decision = evaluateMutationGuard(richInput)
    guard = isStrictGuardDecision(decision) ? decision : {allowed: false, code: 'INVALID_REQUEST'}
  } catch {
    guard = {allowed: false, code: 'INVALID_REQUEST'}
  }
  const recordedAt = richInput.now ?? richInput.context.now ?? Date.now()
  if (!guard.allowed) {
    return finish(richInput, guard, 'STOP', 'stop', 'STOP', true, 'not-dispatched', 'not-run', guard.code, recordedAt)
  }

  if (!richInput.context.identity) {
    // The guard currently makes this unreachable, but retain a terminal branch
    // so a future guard change cannot dispatch without a verified identity.
    return finish(
      richInput,
      {allowed: false, code: 'IDENTITY_REQUIRED'},
      'STOP',
      'stop',
      'STOP',
      true,
      'not-dispatched',
      'not-run',
      'IDENTITY_REQUIRED',
      recordedAt,
    )
  }

  if (!transportBindingMatches(richInput.transport.binding, guard.binding)) {
    // The adapter is bound to some other target; nothing may be sent to it.
    return finish(
      richInput,
      guard,
      'STOP',
      'stop',
      'STOP',
      true,
      'not-dispatched',
      'not-run',
      'TRANSPORT_BINDING_MISMATCH',
      recordedAt,
    )
  }

  // Write-ahead readiness: the sink must persist a dispatch intent BEFORE the
  // transport is touched. A sink that cannot persist is discovered here, while
  // stopping is still safe — never after dispatch, where the mutation would
  // land UNCERTAIN with no durable receipt.
  let writeAheadRecorded = false
  const writeAheadSink = richInput.context.receiptSink
  if (writeAheadSink && typeof writeAheadSink.writeAhead === 'function') {
    try {
      await writeAheadSink.writeAhead(
        createWriteAheadIntent({
          recordedAt,
          profileName: guard.plan.profileName,
          resource: guard.plan.resource,
          operation: guard.plan.operation,
          target: guard.binding,
          planDigest: guard.plan.planDigest,
          confirmationDigest: safeConfirmationDigest(richInput),
        }),
      )
      writeAheadRecorded = true
    } catch {
      writeAheadRecorded = false
    }
  }
  if (!writeAheadRecorded) {
    return finish(
      richInput,
      guard,
      'STOP',
      'stop',
      'STOP',
      true,
      'not-dispatched',
      'not-run',
      'RECEIPT_SINK_UNAVAILABLE',
      recordedAt,
    )
  }

  let dispatchState: DispatchState = 'attempted'
  try {
    // Dispatch reads only the guard's parsed plan snapshot: the payload sent
    // is byte-for-byte the payload the digest covered.
    const dispatch = await richInput.transport.dispatch({
      operation: guard.plan.operation,
      payload: guard.plan.payload,
      targetBinding: guard.binding,
      planDigest: guard.plan.planDigest,
    })
    if (!dispatch.accepted) {
      return finish(
        richInput,
        guard,
        'UNCERTAIN',
        'uncertain',
        'STOP',
        true,
        dispatchState,
        'not-run',
        'DISPATCH_REJECTED',
        recordedAt,
      )
    }
    dispatchState = 'accepted'
  } catch {
    // A dispatch error has unknown server-side state. Never call dispatch again.
    return finish(
      richInput,
      guard,
      'UNCERTAIN',
      'uncertain',
      'STOP',
      true,
      dispatchState,
      'not-run',
      'DISPATCH_UNCERTAIN',
      recordedAt,
    )
  }

  let readBackClassification: ReadBackClassification
  try {
    const readBack = await richInput.transport.readBack({
      targetBinding: guard.binding,
      planDigest: guard.plan.planDigest,
    })
    readBackClassification = classifyReadBack(readBack, guard.plan.readBackExpectation)
  } catch {
    return finish(
      richInput,
      guard,
      'UNCERTAIN',
      'uncertain',
      'STOP',
      true,
      dispatchState,
      'not-run',
      'READBACK_UNCERTAIN',
      recordedAt,
    )
  }

  const outcomeByClassification: Record<
    Exclude<ReadBackClassification, 'not-run'>,
    {
      outcome: 'VERIFIED' | 'MISMATCH' | 'MISSING' | 'AMBIGUOUS'
      status: 'verified' | 'mismatch' | 'missing' | 'ambiguous'
    }
  > = {
    verified: {outcome: 'VERIFIED', status: 'verified'},
    mismatch: {outcome: 'MISMATCH', status: 'mismatch'},
    missing: {outcome: 'MISSING', status: 'missing'},
    ambiguous: {outcome: 'AMBIGUOUS', status: 'ambiguous'},
  }
  if (readBackClassification === 'not-run') {
    return finish(
      richInput,
      guard,
      'UNCERTAIN',
      'uncertain',
      'STOP',
      true,
      dispatchState,
      'not-run',
      'READBACK_UNCERTAIN',
      recordedAt,
    )
  }
  const mapped = outcomeByClassification[readBackClassification]

  return finish(
    richInput,
    guard,
    mapped.outcome,
    mapped.status,
    mapped.status === 'verified' ? 'CONTINUE' : 'STOP',
    mapped.status !== 'verified',
    dispatchState,
    readBackClassification,
    undefined,
    recordedAt,
  )
}

async function finish(
  input: MutationExecutionInput,
  guard: MutationGuardDecision,
  outcome: 'VERIFIED' | 'MISMATCH' | 'MISSING' | 'AMBIGUOUS' | 'STOP' | 'UNCERTAIN',
  status: 'verified' | 'mismatch' | 'missing' | 'ambiguous' | 'stop' | 'uncertain',
  terminal: 'CONTINUE' | 'STOP',
  stop: boolean,
  dispatchState: DispatchState,
  readBackClassification: ReadBackClassification,
  reasonCode: AuditReasonCode | undefined,
  recordedAt: number,
): Promise<MutationExecutionResult> {
  // Receipts on the allow path record the parsed plan snapshot, so what the
  // receipt attests is what was actually dispatched.
  const plan = guard.allowed ? guard.plan : input.plan
  const target = guard.allowed ? guard.binding : safeTarget(input.plan)
  const confirmationDigest = safeConfirmationDigest(input)
  const recordedTimestamp = Number.isFinite(recordedAt) ? recordedAt : 0
  const receiptInput: AuditReceiptInput = {
    recordedAt: recordedTimestamp,
    profileName: safeLabel(plan.profileName, 'unknown-profile'),
    resource: safeLabel(plan.resource, 'unknown-resource'),
    operation: safeLabel(plan.operation, 'unknown-operation') as MutationPlan['operation'],
    target,
    planDigest: safeDigest(plan.planDigest, 'invalid-plan'),
    confirmationDigest,
    requiredCapabilityFingerprint: safeDigest(plan.capabilitiesFingerprint, 'invalid-capabilities'),
    requiredScopeFingerprint: safeDigest(plan.scopesFingerprint, 'invalid-scopes'),
    dispatchState,
    readBackClassification,
    outcome,
    terminal,
    ...(reasonCode === undefined ? {} : {reasonCode}),
  }
  const receipt = createAuditReceipt(receiptInput)

  let receiptWriteFailed = false
  const sink = input.context.receiptSink
  if (sink) {
    try {
      await sink.write(receipt)
    } catch {
      receiptWriteFailed = true
    }
  } else {
    receiptWriteFailed = true
  }

  const receiptFailureAfterDispatch = receiptWriteFailed && dispatchState !== 'not-dispatched'
  const returnedReceipt = receiptFailureAfterDispatch
    ? createAuditReceipt({
        ...receiptInput,
        outcome: 'UNCERTAIN',
        terminal: 'STOP',
        reasonCode: 'RECEIPT_WRITE_FAILED',
      })
    : receipt

  return {
    status: receiptFailureAfterDispatch ? 'uncertain' : status,
    outcome: receiptFailureAfterDispatch ? 'UNCERTAIN' : outcome,
    terminal: receiptFailureAfterDispatch ? 'STOP' : terminal,
    stop: receiptFailureAfterDispatch ? true : stop,
    dispatched: dispatchState !== 'not-dispatched',
    dispatchState,
    readBackClassification,
    guard,
    receipt: returnedReceipt,
    receiptWriteFailed,
  }
}

/**
 * Failure-path receipts must be written even when the plan itself is the
 * broken input, so this re-validates the binding the guard never vouched for
 * and falls back to sentinel digests. The `ledgerops.invalid-*` strings are
 * receipt-visible frozen vocabulary pinned in the golden-digest gate — renaming
 * or reordering them changes issued receipt ids.
 */
function safeTarget(plan: MutationPlan): TargetBinding {
  const value = plan.targetBinding
  if (
    value &&
    typeof value === 'object' &&
    typeof value.profileName === 'string' &&
    value.profileName.trim() !== '' &&
    typeof value.resource === 'string' &&
    value.resource.trim() !== '' &&
    isDigest(value.tenantFingerprint) &&
    isDigest(value.targetFingerprint) &&
    (value.objectFingerprint === undefined || isDigest(value.objectFingerprint))
  ) {
    return {
      profileName: value.profileName,
      resource: value.resource,
      tenantFingerprint: value.tenantFingerprint,
      ...(value.objectFingerprint === undefined ? {} : {objectFingerprint: value.objectFingerprint}),
      targetFingerprint: value.targetFingerprint,
    }
  }
  const fallbackProfile = safeLabel(plan.profileName, 'unknown-profile')
  const fallbackResource = safeLabel(plan.resource, 'unknown-resource')
  const fallbackTenant = digestJson({kind: 'ledgerops.invalid-target.tenant.v1'})
  return {
    profileName: fallbackProfile,
    resource: fallbackResource,
    tenantFingerprint: fallbackTenant,
    targetFingerprint: digestJson({
      kind: 'ledgerops.invalid-target.v1',
      profileName: fallbackProfile,
      resource: fallbackResource,
    }),
  }
}

/** The adapter's own claim about which target it can reach, checked before anything is sent. */
function transportBindingMatches(offered: unknown, binding: TargetBinding): boolean {
  return isSafeTargetBinding(offered) && sameBinding(offered, binding)
}

function safeConfirmationDigest(input: MutationExecutionInput): string {
  try {
    const value = confirmationDigestFor(input.confirmation)
    return isDigest(value) ? value : digestJson({kind: 'ledgerops.invalid-confirmation.v1'})
  } catch {
    return digestJson({kind: 'ledgerops.invalid-confirmation.v1'})
  }
}

function safeDigest(value: unknown, marker: string): string {
  return isDigest(value) ? value : digestJson({kind: `ledgerops.${marker}.v1`})
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function safeLabel(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback
}

function isStrictExecutionInput(value: unknown): value is MutationExecutionInput {
  if (
    !isObjectRecord(value) ||
    !isObjectRecord(value.request) ||
    !isObjectRecord(value.plan) ||
    !isObjectRecord(value.context) ||
    !isObjectRecord(value.transport)
  )
    return false
  return (
    typeof value.transport.dispatch === 'function' &&
    typeof value.transport.readBack === 'function' &&
    isObjectRecord(value.transport.binding)
  )
}

function isStrictGuardDecision(value: unknown): value is MutationGuardDecision {
  if (!isObjectRecord(value) || typeof value.allowed !== 'boolean') return false
  if (!value.allowed) return typeof value.code === 'string'
  return value.code === 'ALLOWED' && isObjectRecord(value.binding) && isObjectRecord(value.plan)
}

function normalizeForStop(value: unknown): MutationExecutionInput {
  const record = isObjectRecord(value) ? value : {}
  return {
    request: (isObjectRecord(record.request) ? record.request : {}) as unknown as MutationRequest,
    plan: (isObjectRecord(record.plan) ? record.plan : {}) as unknown as MutationPlan,
    confirmation: record.confirmation as MutationExecutionInput['confirmation'],
    context: (isObjectRecord(record.context) ? record.context : {}) as MutationExecutionInput['context'],
    transport: (isObjectRecord(record.transport) ? record.transport : {}) as unknown as MutationTransport,
    ...(typeof record.now === 'number' ? {now: record.now} : {}),
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
