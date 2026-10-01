import {parseAuditReceipt, parseWriteAheadIntent} from './audit.js'
import {parseBatchLink} from './batch-link.js'
import {createBatchManifest, parseBatchManifest} from './batch-manifest.js'
import {parseBatchReceipt} from './batch-receipt.js'
import type {Digest} from './canonical.js'
import type {
  AuditReceipt,
  BatchHaltPolicy,
  BatchItemOutcome,
  BatchLink,
  BatchManifest,
  BatchProvenance,
  BatchReceipt,
  BatchReceiptCounts,
} from './types.js'

/**
 * ADR-0011: when the closing `ledgerops.batch-receipt.v1` never lands, the
 * batch's outcome is UNCERTAIN and the run is reconstructed from what is
 * durable — write-ahead intents, per-item receipts, and batch-link records —
 * before any resume manifest is built.
 *
 * This module is the pure kernel of that reconstruction. It opens no file and
 * touches no network: it accepts already-read journal records and the manifest
 * being reconstructed, and returns a decision. Durability stays entirely in the
 * sink layer (ADR-0009). Every comparison against the sealed manifest is
 * exact-byte; anything structurally invalid, unregistered, or self-contradictory
 * fails closed with a typed code, and an unknown state never coerces to success.
 *
 * PRECONDITION — journal completeness: a member's `not-attempted` state (and
 * therefore the resume remainder derived from it) is proven by the ABSENCE of
 * any intent, receipt, or link for that member, not by any positive signal.
 * This kernel cannot distinguish "genuinely untouched" from "the caller read
 * only part of the journal" — both look identical from here. Callers MUST
 * supply the complete journal slice for this manifest (every record scoped to
 * its `manifestDigest`/member `planDigest`s); a truncated read silently
 * misreports already-attempted members as `not-attempted`, and this kernel has
 * no durable signal to catch that.
 */

export const BATCH_COVERAGE_FAILURE_CODES = [
  /** The supplied manifest does not parse as a `ledgerops.batch-manifest.v1` record. */
  'MANIFEST_INVALID',
  /** The journal input is not an array of records. */
  'JOURNAL_INPUT_INVALID',
  /** A record names a registered schema but fails to parse (tampered or malformed). */
  'JOURNAL_RECORD_INVALID',
  /** A record names no schema this reconstruction is registered to read. */
  'JOURNAL_RECORD_UNRECOGNIZED',
  /** A link binds this manifest digest under a different batch id. */
  'LINK_BATCH_ID_MISMATCH',
  /** A link's `{planId, planDigest}` does not exactly match the sealed member at its index. */
  'LINK_MEMBER_MISMATCH',
  /** Two durable statements disagree about one member's outcome. */
  'LINK_OUTCOME_CONFLICT',
  /** A link names a receipt other than the durable receipt for that member. */
  'LINK_RECEIPT_CONFLICT',
  /** Two distinct receipts exist for one member plan digest. */
  'RECEIPT_DUPLICATE_CONFLICT',
  /** The closing batch receipt disagrees with the reconstructed coverage. */
  'BATCH_RECEIPT_CONFLICT',
] as const

export type BatchCoverageFailureCode = (typeof BATCH_COVERAGE_FAILURE_CODES)[number]

/** One reconstructed member: what the durable trace proves about it, and nothing more. */
export interface BatchCoverageMember {
  /** Zero-based index into the sealed `manifest.entries`. */
  readonly index: number
  readonly planId: string
  readonly planDigest: Digest
  readonly state: BatchItemOutcome
  readonly receiptId?: Digest
  /** True when a `ledgerops.batch-link.v1` record stated this member's outcome. */
  readonly linked: boolean
  /** True when a write-ahead intent for this member is durable. */
  readonly intentRecorded: boolean
}

export interface BatchCoverageSuccess {
  readonly ok: true
  /** The parsed manifest snapshot; callers act on this, never on their own object. */
  readonly manifest: BatchManifest
  /** One entry per sealed member, in manifest order. */
  readonly members: readonly BatchCoverageMember[]
  readonly counts: BatchReceiptCounts
  /**
   * `CLOSED` only when a durable closing batch receipt for this manifest agrees
   * with the reconstructed coverage. Otherwise the run stays `UNCERTAIN`.
   */
  readonly runState: 'CLOSED' | 'UNCERTAIN'
  readonly closingReceipt?: BatchReceipt
  /** The resume remainder: `not-attempted` members only, in sealed order. */
  readonly remainder: readonly BatchCoverageMember[]
  /** Members a mutation may exist for; resume is refused until a human resolves them. */
  readonly unresolved: readonly BatchCoverageMember[]
}

export interface BatchCoverageFailure {
  readonly ok: false
  readonly code: BatchCoverageFailureCode
  /** Zero-based member index for a member-level failure. */
  readonly index?: number
  /** Zero-based index into the supplied journal records for a record-level failure. */
  readonly recordIndex?: number
}

export type BatchCoverageDecision = BatchCoverageSuccess | BatchCoverageFailure

export interface BatchCoverageInput {
  /** The manifest whose coverage is being reconstructed; parsed defensively here. */
  readonly manifest: unknown
  /**
   * Journal records as read by the sink layer. Records belonging to another
   * batch, or naming a plan digest this manifest does not seal, are ignored;
   * a record this kernel is not registered to read fails the reconstruction.
   * Must be the COMPLETE journal slice for this manifest — see the
   * journal-completeness precondition in the module doc comment above.
   */
  readonly records: readonly unknown[]
}

const WRITE_AHEAD_SCHEMA = 'ledgerops.write-ahead.v1'
const AUDIT_SCHEMA = 'ledgerops.audit.v1'
const BATCH_LINK_SCHEMA = 'ledgerops.batch-link.v1'
const BATCH_RECEIPT_SCHEMA = 'ledgerops.batch-receipt.v1'

interface ParsedJournal {
  readonly intents: ReadonlySet<Digest>
  readonly receipts: ReadonlyMap<Digest, AuditReceipt>
  readonly links: ReadonlyMap<number, BatchLink>
  readonly closingReceipt?: BatchReceipt
}

export function reconstructBatchCoverage(input: BatchCoverageInput): BatchCoverageDecision {
  if (!isObjectRecord(input) || !Array.isArray(input.records)) return failure('JOURNAL_INPUT_INVALID')

  const manifest = parseBatchManifest(input.manifest)
  if (!manifest) return failure('MANIFEST_INVALID')

  const journal = readJournal(manifest, input.records)
  if (!('intents' in journal)) return journal

  const members = buildMembers(manifest, journal)
  if (!Array.isArray(members)) return members

  const closing = checkClosingReceipt(manifest, journal.closingReceipt, members)
  if (closing) return closing

  const remainder = members.filter(member => member.state === 'not-attempted')
  const unresolved = members.filter(member => member.state === 'dispatched-unverified' || member.state === 'uncertain')

  return {
    ok: true,
    manifest,
    members: Object.freeze(members.map(member => Object.freeze(member))),
    counts: countsOf(members),
    runState: journal.closingReceipt === undefined ? 'UNCERTAIN' : 'CLOSED',
    closingReceipt: journal.closingReceipt,
    remainder: Object.freeze(remainder),
    unresolved: Object.freeze(unresolved),
  }
}

/**
 * Classify and parse every supplied record, scoping it to this manifest by
 * exact-byte `manifestDigest` (links and the closing receipt) or by sealed
 * member `planDigest` (intents and per-item receipts).
 */
function readJournal(manifest: BatchManifest, records: readonly unknown[]): ParsedJournal | BatchCoverageFailure {
  const memberDigests = new Set(manifest.entries.map(entry => entry.planDigest))
  const intents = new Set<Digest>()
  const receipts = new Map<Digest, AuditReceipt>()
  const links = new Map<number, BatchLink>()
  let closingReceipt: BatchReceipt | undefined

  for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
    const raw = records[recordIndex]
    const schemaVersion = isObjectRecord(raw) ? raw.schemaVersion : undefined

    switch (schemaVersion) {
      case WRITE_AHEAD_SCHEMA: {
        const intent = parseWriteAheadIntent(raw)
        if (!intent) return failure('JOURNAL_RECORD_INVALID', {recordIndex})
        if (memberDigests.has(intent.planDigest)) intents.add(intent.planDigest)
        break
      }
      case AUDIT_SCHEMA: {
        const receipt = parseAuditReceipt(raw)
        if (!receipt) return failure('JOURNAL_RECORD_INVALID', {recordIndex})
        if (!memberDigests.has(receipt.planDigest)) break
        const seen = receipts.get(receipt.planDigest)
        if (seen && seen.receiptId !== receipt.receiptId) {
          return failure('RECEIPT_DUPLICATE_CONFLICT', {
            index: memberIndexOfDigest(manifest, receipt.planDigest),
            recordIndex,
          })
        }
        receipts.set(receipt.planDigest, receipt)
        break
      }
      case BATCH_LINK_SCHEMA: {
        const link = parseBatchLink(raw)
        if (!link) return failure('JOURNAL_RECORD_INVALID', {recordIndex})
        if (link.manifestDigest !== manifest.manifestDigest) break
        if (link.batchId !== manifest.batchId) return failure('LINK_BATCH_ID_MISMATCH', {recordIndex})
        // A link's own signed-record check (`isIndex` in batch-link.ts) only
        // bounds `index` by the global cap of MAX_BATCH_MANIFEST_MEMBERS, not
        // by this manifest's own `entries.length`. A link scoped to this exact
        // manifestDigest/batchId but naming an index outside the sealed member
        // range is self-contradictory (manifestDigest seals memberCount) and
        // must never be silently dropped by buildMembers' 0..entries.length
        // loop — refuse it the same way an identity mismatch is refused below.
        if (link.index >= manifest.entries.length) {
          return failure('LINK_MEMBER_MISMATCH', {index: link.index, recordIndex})
        }
        const seen = links.get(link.index)
        // Duplicate links are idempotent only when they say exactly the same
        // thing; any disagreement is a conflict, never a last-writer-wins merge.
        if (seen && seen.linkDigest !== link.linkDigest) {
          return failure('LINK_OUTCOME_CONFLICT', {index: link.index, recordIndex})
        }
        links.set(link.index, link)
        break
      }
      case BATCH_RECEIPT_SCHEMA: {
        const receipt = parseBatchReceipt(raw)
        if (!receipt) return failure('JOURNAL_RECORD_INVALID', {recordIndex})
        if (receipt.manifestDigest !== manifest.manifestDigest) break
        if (closingReceipt && closingReceipt.batchReceiptDigest !== receipt.batchReceiptDigest) {
          return failure('BATCH_RECEIPT_CONFLICT', {recordIndex})
        }
        closingReceipt = receipt
        break
      }
      default:
        return failure('JOURNAL_RECORD_UNRECOGNIZED', {recordIndex})
    }
  }

  return {intents, receipts, links, closingReceipt}
}

function buildMembers(manifest: BatchManifest, journal: ParsedJournal): BatchCoverageMember[] | BatchCoverageFailure {
  const members: BatchCoverageMember[] = []

  for (let index = 0; index < manifest.entries.length; index += 1) {
    const entry = manifest.entries[index]
    const link = journal.links.get(index)
    const receipt = journal.receipts.get(entry.planDigest)
    const intentRecorded = journal.intents.has(entry.planDigest)

    if (link) {
      // Exact-byte against the sealed member: the manifest order is authority.
      if (link.planId !== entry.planId || link.planDigest !== entry.planDigest) {
        return failure('LINK_MEMBER_MISMATCH', {index})
      }
      if (receipt) {
        if (link.receiptId !== undefined && link.receiptId !== receipt.receiptId) {
          return failure('LINK_RECEIPT_CONFLICT', {index})
        }
        if (link.outcome !== stateFromReceipt(receipt)) {
          return failure('LINK_OUTCOME_CONFLICT', {index})
        }
      }
    }

    members.push({
      index,
      planId: entry.planId,
      planDigest: entry.planDigest,
      state: memberState(link, receipt, intentRecorded),
      // A link may carry the receipt reference even when the receipt line
      // itself is not in the supplied slice.
      receiptId: link?.receiptId ?? receipt?.receiptId,
      linked: link !== undefined,
      intentRecorded,
    })
  }

  return members
}

/**
 * A link is the batch executor's own statement; a receipt is the kernel's. With
 * neither, a durable intent proves a dispatch was attempted and nothing more —
 * that is `uncertain`, never a success. With no link, receipt, or intent at
 * all, the member falls to `not-attempted` — proven only by the absence of
 * every record for it, so this depends on the journal-completeness
 * precondition documented at the top of this module.
 */
function memberState(
  link: BatchLink | undefined,
  receipt: AuditReceipt | undefined,
  intentRecorded: boolean,
): BatchItemOutcome {
  if (link) return link.outcome
  if (receipt) return stateFromReceipt(receipt)
  return intentRecorded ? 'uncertain' : 'not-attempted'
}

/** ADR-0011's outcome mapping, read backwards off a durable `ledgerops.audit.v1` receipt. */
function stateFromReceipt(receipt: AuditReceipt): BatchItemOutcome {
  switch (receipt.outcome) {
    case 'VERIFIED':
      return 'accepted'
    case 'STOP':
      // A pre-dispatch STOP dispatched nothing; anything else already touched
      // the transport and cannot be vouched for.
      return receipt.dispatchState === 'not-dispatched' ? 'stopped' : 'dispatched-unverified'
    case 'MISMATCH':
    case 'MISSING':
    case 'AMBIGUOUS':
      return 'dispatched-unverified'
    case 'UNCERTAIN':
      return 'uncertain'
    default:
      return 'uncertain'
  }
}

/**
 * The closing receipt attests coverage; it never overrides it. If it disagrees
 * with what the journal proves — member set, per-member outcome, or the receipt
 * each member names — the reconstruction fails closed.
 */
function checkClosingReceipt(
  manifest: BatchManifest,
  closingReceipt: BatchReceipt | undefined,
  members: readonly BatchCoverageMember[],
): BatchCoverageFailure | undefined {
  if (!closingReceipt) return undefined
  if (closingReceipt.batchId !== manifest.batchId) return failure('BATCH_RECEIPT_CONFLICT')
  if (!sameProvenance(closingReceipt.provenance, manifest.provenance)) return failure('BATCH_RECEIPT_CONFLICT')
  if (closingReceipt.items.length !== members.length) return failure('BATCH_RECEIPT_CONFLICT')

  const claimed = new Map(closingReceipt.items.map(item => [item.planId, item]))
  for (const member of members) {
    const item = claimed.get(member.planId)
    if (!item) return failure('BATCH_RECEIPT_CONFLICT', {index: member.index})
    if (item.outcome !== member.state) return failure('BATCH_RECEIPT_CONFLICT', {index: member.index})
    if (item.receiptId !== member.receiptId) return failure('BATCH_RECEIPT_CONFLICT', {index: member.index})
  }

  return undefined
}

/**
 * Exact-byte comparison of the sealed source both records must share:
 * `ledgerops.batch-receipt.v1` seals the same provenance shape as the
 * manifest it closes (batch-manifest.ts), so a closing receipt naming a
 * different source is a contradiction, not merely a coverage disagreement.
 */
function sameProvenance(a: BatchProvenance, b: BatchProvenance): boolean {
  if (a.sourceReceiptId !== b.sourceReceiptId) return false
  if (a.sourceManifestHashes.length !== b.sourceManifestHashes.length) return false
  return a.sourceManifestHashes.every((hash, index) => hash === b.sourceManifestHashes[index])
}

function countsOf(members: readonly BatchCoverageMember[]): BatchReceiptCounts {
  const counts = {accepted: 0, stopped: 0, dispatchedUnverified: 0, uncertain: 0, notAttempted: 0}
  for (const member of members) {
    switch (member.state) {
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
  return counts
}

export const RESUME_MANIFEST_FAILURE_CODES = [
  /** Nothing is left to resume: every member is accounted for. */
  'RESUME_REMAINDER_EMPTY',
  /** A resume manifest may not reuse the batch id it is resuming. */
  'RESUME_BATCH_ID_REUSED',
  /** A member may already have a mutation behind it; uncertainty is never looped over. */
  'RESUME_UNRESOLVED_MEMBERS',
] as const

export type ResumeManifestFailureCode = (typeof RESUME_MANIFEST_FAILURE_CODES)[number]

export interface ResumeManifestInput {
  readonly coverage: BatchCoverageSuccess
  /** A new batch id; reusing the closed one is refused. */
  readonly batchId: string
  readonly createdAt?: number
  readonly expiresAt?: number
  readonly ttlMs?: number
  /** Defaults to the policy sealed in the manifest being resumed. */
  readonly haltPolicy?: BatchHaltPolicy
}

export interface ResumeManifestSuccess {
  readonly ok: true
  /** A NEW signed manifest over the remainder; it requires a fresh confirmation. */
  readonly manifest: BatchManifest
  readonly remainder: readonly BatchCoverageMember[]
}

export interface ResumeManifestFailure {
  readonly ok: false
  readonly code: ResumeManifestFailureCode
  /** Member indexes that block the resume. */
  readonly indexes?: readonly number[]
}

export type ResumeManifestDecision = ResumeManifestSuccess | ResumeManifestFailure

/**
 * ADR-0011: "Resume is a new manifest over the not-attempted remainder,
 * requiring a fresh confirmation. Accepted members are never re-enumerated."
 * Members that already reached the transport — `dispatched-unverified` or
 * `uncertain` — block the resume rather than being retried, and a `stopped`
 * member is replanned by the operator, never silently resumed.
 */
export function buildResumeManifest(input: ResumeManifestInput): ResumeManifestDecision {
  const {coverage} = input
  const source = coverage.manifest

  // `coverage.remainder`/`coverage.unresolved` are convenience caches; a
  // caller could hand back a `BatchCoverageSuccess`-typed object whose cached
  // fields no longer match its `members` (TypeScript's `readonly` is not
  // runtime-enforced). Re-derive both from `coverage.members` — the module's
  // one source of truth — the same way this module re-parses `manifest`
  // defensively rather than trusting a caller's claim about it.
  const remainder = coverage.members.filter(member => member.state === 'not-attempted')
  const unresolved = coverage.members.filter(
    member => member.state === 'dispatched-unverified' || member.state === 'uncertain',
  )

  if (unresolved.length > 0) {
    return {
      ok: false,
      code: 'RESUME_UNRESOLVED_MEMBERS',
      indexes: Object.freeze(unresolved.map(member => member.index)),
    }
  }
  if (remainder.length === 0) return {ok: false, code: 'RESUME_REMAINDER_EMPTY'}
  if (input.batchId === source.batchId) return {ok: false, code: 'RESUME_BATCH_ID_REUSED'}

  // `createBatchManifest` stores entries and provenance by reference and then
  // deep-freezes them: hand it fresh objects, never the sealed manifest's own.
  const entries = remainder.map(member => ({
    planId: source.entries[member.index].planId,
    planDigest: source.entries[member.index].planDigest,
  }))
  const provenance = {
    sourceReceiptId: source.provenance.sourceReceiptId,
    sourceManifestHashes: [...source.provenance.sourceManifestHashes],
  }

  const manifest = createBatchManifest({
    batchId: input.batchId,
    profileName: source.profileName,
    entries,
    provenance,
    haltPolicy: input.haltPolicy ?? source.haltPolicy,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
    ttlMs: input.ttlMs,
  })

  return {ok: true, manifest, remainder}
}

function memberIndexOfDigest(manifest: BatchManifest, planDigest: Digest): number | undefined {
  const index = manifest.entries.findIndex(entry => entry.planDigest === planDigest)
  return index === -1 ? undefined : index
}

function failure(
  code: BatchCoverageFailureCode,
  detail: {index?: number; recordIndex?: number} = {},
): BatchCoverageFailure {
  const result: {ok: false; code: BatchCoverageFailureCode; index?: number; recordIndex?: number} = {ok: false, code}
  if (detail.index !== undefined) result.index = detail.index
  if (detail.recordIndex !== undefined) result.recordIndex = detail.recordIndex
  return result
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
