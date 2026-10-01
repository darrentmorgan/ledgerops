import {describe, expect, it} from 'vitest'
import {
  AUDIT_REASON_CODES,
  BATCH_RESULT_SCHEMA_VERSION,
  humanizeReasonCode,
  projectBatchResult,
  renderBatchResult,
  renderBatchResultText,
  type AuditReasonCode,
  type BatchExecutionMember,
  type BatchExecutionSuccess,
} from '../../../src/lib/ledgerops/index.js'

/**
 * Issue #62: `ledgerops.batch-result.v1` is a pure projection of
 * `executeBatch`'s own result (ADR-0011) — no I/O, no sink, no transport.
 *
 * Fixtures below are deliberately hand-built `BatchExecutionSuccess`-shaped
 * literals rather than a full `executeBatch` run through a fake transport:
 * this module reads only `manifest.batchId`, `manifest.manifestDigest`,
 * `runState`, `halted`, `haltedAtIndex`, `counts`, and `members[].{index,
 * planId, planDigest, outcome, receiptId, result.receipt.reasonCode}`, so the
 * fixtures carry exactly those fields and are cast through `as unknown as`
 * for the rest — offline, synthetic, and scoped to what the projection
 * actually consumes.
 */

const MANIFEST_DIGEST = 'd'.repeat(64)

function accepted(index: number, planId: string): BatchExecutionMember {
  return {
    index,
    planId,
    planDigest: `${planId}-digest`,
    outcome: 'accepted',
    receiptId: `${planId}-receipt`,
    result: {receipt: {reasonCode: undefined}} as unknown as BatchExecutionMember['result'],
  } as unknown as BatchExecutionMember
}

function stopped(index: number, planId: string): BatchExecutionMember {
  return {
    index,
    planId,
    planDigest: `${planId}-digest`,
    outcome: 'stopped',
    receiptId: `${planId}-receipt`,
    result: {receipt: {reasonCode: 'PLAN_EXPIRED'}} as unknown as BatchExecutionMember['result'],
  } as unknown as BatchExecutionMember
}

function uncertain(index: number, planId: string): BatchExecutionMember {
  return {
    index,
    planId,
    planDigest: `${planId}-digest`,
    outcome: 'uncertain',
    result: {receipt: {reasonCode: 'DISPATCH_UNCERTAIN'}} as unknown as BatchExecutionMember['result'],
  } as unknown as BatchExecutionMember
}

function notAttempted(index: number, planId: string): BatchExecutionMember {
  return {
    index,
    planId,
    planDigest: `${planId}-digest`,
    outcome: 'not-attempted',
  } as unknown as BatchExecutionMember
}

function executionOf(
  members: readonly BatchExecutionMember[],
  overrides: Partial<Pick<BatchExecutionSuccess, 'runState' | 'halted' | 'haltedAtIndex'>> = {},
): BatchExecutionSuccess {
  const counts = {accepted: 0, stopped: 0, dispatchedUnverified: 0, uncertain: 0, notAttempted: 0}
  for (const member of members) {
    switch (member.outcome) {
      case 'accepted':
        counts.accepted += 1
        break
      case 'stopped':
        counts.stopped += 1
        break
      case 'dispatched-unverified':
        counts.dispatchedUnverified += 1
        break
      case 'uncertain':
        counts.uncertain += 1
        break
      case 'not-attempted':
        counts.notAttempted += 1
        break
    }
  }
  return {
    ok: true,
    manifest: {batchId: 'batch-62', manifestDigest: MANIFEST_DIGEST},
    members,
    counts,
    runState: overrides.runState ?? 'CLOSED',
    halted: overrides.halted ?? false,
    ...(overrides.haltedAtIndex === undefined ? {} : {haltedAtIndex: overrides.haltedAtIndex}),
  } as unknown as BatchExecutionSuccess
}

describe('projectBatchResult', () => {
  it('produces the exact golden ledgerops.batch-result.v1 bytes for a clean run', () => {
    const execution = executionOf([accepted(0, 'plan-a'), accepted(1, 'plan-b')])
    const result = projectBatchResult(execution)

    expect(JSON.stringify(result)).toBe(
      '{"schemaVersion":"ledgerops.batch-result.v1","batchId":"batch-62","manifestDigest":' +
        `"${MANIFEST_DIGEST}",` +
        '"runState":"CLOSED","halted":false,"counts":{"accepted":2,"stopped":0,' +
        '"dispatchedUnverified":0,"uncertain":0,"notAttempted":0},"items":[' +
        '{"index":0,"planId":"plan-a","planDigest":"plan-a-digest","outcome":"accepted","receiptId":"plan-a-receipt"},' +
        '{"index":1,"planId":"plan-b","planDigest":"plan-b-digest","outcome":"accepted","receiptId":"plan-b-receipt"}' +
        ']}',
    )
    expect(result.schemaVersion).toBe(BATCH_RESULT_SCHEMA_VERSION)
  })

  it('asserts the schema version literally in the projected bytes', () => {
    const execution = executionOf([accepted(0, 'plan-a')])
    const result = projectBatchResult(execution)
    expect(JSON.stringify(result)).toContain('"schemaVersion":"ledgerops.batch-result.v1"')
  })

  it('reports every state for a mixed run and hides nothing behind a later halt', () => {
    const members = [
      accepted(0, 'plan-a'),
      stopped(1, 'plan-b'),
      uncertain(2, 'plan-c'),
      notAttempted(3, 'plan-d'),
      notAttempted(4, 'plan-e'),
    ]
    const execution = executionOf(members, {halted: true, haltedAtIndex: 1, runState: 'CLOSED'})
    const result = projectBatchResult(execution)

    expect(result.counts).toEqual({
      accepted: 1,
      stopped: 1,
      dispatchedUnverified: 0,
      uncertain: 1,
      notAttempted: 2,
    })
    expect(result.items).toHaveLength(5)

    // The accepted member is never dropped or hidden by the later halt.
    expect(result.items[0]).toEqual({
      index: 0,
      planId: 'plan-a',
      planDigest: 'plan-a-digest',
      outcome: 'accepted',
      receiptId: 'plan-a-receipt',
    })
    // The stopped member carries its exact SCREAMING_SNAKE reason, unrewritten.
    expect(result.items[1]).toMatchObject({outcome: 'stopped', reasonCode: 'PLAN_EXPIRED'})
    // The uncertain member surfaces as uncertain, with its own reason.
    expect(result.items[2]).toMatchObject({outcome: 'uncertain', reasonCode: 'DISPATCH_UNCERTAIN'})
    // Both not-attempted members are reported individually, not collapsed.
    expect(result.items[3]).toEqual({index: 3, planId: 'plan-d', planDigest: 'plan-d-digest', outcome: 'not-attempted'})
    expect(result.items[4]).toEqual({index: 4, planId: 'plan-e', planDigest: 'plan-e-digest', outcome: 'not-attempted'})
  })

  it('surfaces runState UNCERTAIN even though the executor result is ok: true', () => {
    // CRITICAL caveat from the batch-executor review: a closing-receipt write
    // failure leaves `ok: true` with `runState: 'UNCERTAIN'`. The projection
    // must never read `ok` as a proxy for success.
    const execution = executionOf([accepted(0, 'plan-a')], {runState: 'UNCERTAIN'})
    expect(execution.ok).toBe(true)

    const result = projectBatchResult(execution)
    expect(result.runState).toBe('UNCERTAIN')
    expect(JSON.stringify(result)).toContain('"runState":"UNCERTAIN"')
  })

  it('passes exact SCREAMING_SNAKE reason codes through unrewritten', () => {
    const execution = executionOf([stopped(0, 'plan-a')])
    const result = projectBatchResult(execution)
    expect(result.items[0].reasonCode).toBe('PLAN_EXPIRED')
  })
})

describe('renderBatchResultText', () => {
  it('renders every state in plain words, without kernel jargon', () => {
    const members = [accepted(0, 'plan-a'), stopped(1, 'plan-b'), uncertain(2, 'plan-c'), notAttempted(3, 'plan-d')]
    const execution = executionOf(members, {halted: true, haltedAtIndex: 1})
    const result = projectBatchResult(execution)
    const lines = renderBatchResultText(result).join('\n')

    // Plain words for a reader with no kernel knowledge — never the raw
    // hyphenated state name or dispatch/read-back jargon.
    // Pinned in full, not as the bare word (issue #71): the label must keep
    // saying what was actually compared, so a silent revert to plain
    // "accepted" — which reads as "everything matched" — fails here.
    expect(lines).toContain('accepted — read back and matched what the plan checked')
    expect(lines).toContain('stopped before it reached Xero')
    expect(lines).toContain('outcome unknown')
    expect(lines).toContain('never attempted')
    expect(lines).not.toContain('dispatched-unverified')
    expect(lines).not.toContain('readBackClassification')
    expect(lines).not.toContain('dispatchState')

    // Receipt references are present for a reviewer to follow up.
    expect(lines).toContain('receipt plan-a-receipt')

    // The reason code is humanized, in plain words, but the raw
    // SCREAMING_SNAKE code stays visible for auditability (issue #86).
    expect(lines).toContain('reason: the plan expired before it was sent (PLAN_EXPIRED)')
    expect(lines).not.toContain('reason PLAN_EXPIRED')
  })

  it('humanizes every reason code, in plain words, with the raw code kept visible', () => {
    // Issue #86: a reader should never need kernel knowledge to understand a
    // reason — but the raw code must never be hidden, for auditability.
    for (const code of AUDIT_REASON_CODES) {
      const label = humanizeReasonCode(code)
      expect(label).toContain(`(${code})`)
      expect(label.toUpperCase()).not.toBe(label) // not just the raw SCREAMING_SNAKE code
    }
  })

  it('falls back to a safe, readable label for an unrecognized reason code, keeping the code visible', () => {
    const label = humanizeReasonCode('SOME_FUTURE_CODE' as AuditReasonCode)
    expect(label).toContain('SOME_FUTURE_CODE')
    expect(label.toUpperCase()).not.toBe(label)
  })

  it('names the batch and flags an UNCERTAIN run plainly, in words a human reads without kernel knowledge', () => {
    const execution = executionOf([accepted(0, 'plan-a')], {runState: 'UNCERTAIN'})
    const result = projectBatchResult(execution)
    const text = renderBatchResultText(result).join('\n')

    expect(text).toContain('batch-62')
    expect(text).toMatch(/UNCERTAIN/)
    expect(text).toContain('verify manually')
  })
})

describe('renderBatchResult', () => {
  it('keeps machine JSON alone on the line — no human prose mixed in', () => {
    const execution = executionOf([accepted(0, 'plan-a')])
    const result = projectBatchResult(execution)
    const json = renderBatchResult(result, 'json')

    expect(() => JSON.parse(json)).not.toThrow()
    const parsed = JSON.parse(json)
    expect(parsed.schemaVersion).toBe('ledgerops.batch-result.v1')
    // The whole rendered string must itself be valid JSON: nothing prepended
    // or appended (a house rule AGENTS.md states for machine-mode output —
    // "machine JSON stays alone on stdout").
    expect(json.trim().startsWith('{')).toBe(true)
    expect(json.trim().endsWith('}')).toBe(true)
  })

  it('renders the human table by default', () => {
    const execution = executionOf([accepted(0, 'plan-a')])
    const result = projectBatchResult(execution)
    const table = renderBatchResult(result)
    expect(table).toContain('Batch batch-62')
    expect(() => JSON.parse(table)).toThrow()
  })
})
