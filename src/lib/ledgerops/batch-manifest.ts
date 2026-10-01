import {defineSignedRecord, digest, finiteNumber, label, oneOf, shape} from './signed-record.js'
import type {BatchHaltPolicy, BatchManifest, BatchManifestEntry, BatchProvenance} from './types.js'
import {BATCH_HALT_POLICIES} from './types.js'

/**
 * ADR-0011: a batch is a signed manifest over unchanged single plans. No kernel
 * type gains multiplicity — this record is the only place a member list exists,
 * and everything a batch confirmation approves (the ordered member identities,
 * the member count, the halt policy, the provenance block and the window) is
 * sealed into `manifestDigest`.
 */

/** ADR-0011 caps a manifest at 50 members; an empty manifest is invalid. */
export const MAX_BATCH_MANIFEST_MEMBERS = 50

const DEFAULT_BATCH_MANIFEST_TTL_MS = 5 * 60 * 1000

const IS_LABEL = label()
const IS_DIGEST = digest()

const isBatchManifestEntry = shape<BatchManifestEntry>()({
  fields: {
    planId: {check: IS_LABEL},
    planDigest: {check: IS_DIGEST},
  },
})

/** Non-empty, duplicate-free, sorted: one deterministic form per source set. */
function isSourceManifestHashes(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length === 0) return false
  if (!value.every(hash => IS_DIGEST(hash))) return false
  for (let index = 1; index < value.length; index += 1) {
    if (value[index - 1] >= value[index]) return false
  }
  return true
}

/** Exported so `ledgerops.batch-receipt.v1` can seal the same provenance shape. */
export const isBatchProvenance = shape<BatchProvenance>()({
  fields: {
    sourceReceiptId: {check: IS_DIGEST},
    sourceManifestHashes: {check: isSourceManifestHashes},
  },
})

/**
 * The manifest names exact plan identities in a significant order. Both the
 * ids and the digests are unique across the manifest, so no member can be
 * enumerated twice under either name, and an entry's exact two-key shape is
 * what forbids a nested manifest.
 */
function isBatchManifestEntries(value: unknown): value is readonly BatchManifestEntry[] {
  if (!Array.isArray(value)) return false
  if (value.length === 0 || value.length > MAX_BATCH_MANIFEST_MEMBERS) return false
  if (!value.every(entry => isBatchManifestEntry(entry))) return false
  const entries = value as readonly BatchManifestEntry[]
  const planIds = new Set(entries.map(entry => entry.planId))
  const planDigests = new Set(entries.map(entry => entry.planDigest))
  return planIds.size === entries.length && planDigests.size === entries.length
}

function isMemberCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_BATCH_MANIFEST_MEMBERS
}

function ttlOrdering(record: BatchManifest): boolean {
  return record.expiresAt > record.createdAt
}

function memberCountMatchesEntries(record: BatchManifest): boolean {
  return record.memberCount === record.entries.length
}

function versionMatchesProvenance(record: BatchManifest): boolean {
  return record.schemaVersion === 'ledgerops.batch-manifest.v2'
    ? record.tenantFingerprint !== undefined
    : record.tenantFingerprint === undefined
}

const batchManifestRecord = defineSignedRecord<BatchManifest, 'manifestDigest', 'memberCount'>({
  label: 'ledgerops.batch-manifest.v1',
  digestField: 'manifestDigest',
  fields: {
    schemaVersion: {check: oneOf('ledgerops.batch-manifest.v1', 'ledgerops.batch-manifest.v2')},
    tenantFingerprint: {check: IS_DIGEST, optional: true},
    batchId: {check: IS_LABEL},
    profileName: {check: IS_LABEL},
    provenance: {check: isBatchProvenance},
    entries: {check: isBatchManifestEntries},
    memberCount: {check: isMemberCount, derive: supplied => supplied.entries.length},
    haltPolicy: {check: oneOf<BatchHaltPolicy>(...BATCH_HALT_POLICIES)},
    createdAt: {check: finiteNumber()},
    expiresAt: {check: finiteNumber()},
  },
  invariants: [ttlOrdering, memberCountMatchesEntries, versionMatchesProvenance],
})

export interface BatchManifestInput {
  batchId?: string
  profileName: string
  /** Ordered, 1 to 50 members; order is sealed and execution follows it. */
  entries: readonly BatchManifestEntry[]
  provenance: BatchProvenance
  /** Sealed at planning time; `continue-on-stop` is never chosen mid-flight. */
  haltPolicy?: BatchHaltPolicy
  createdAt?: number
  expiresAt?: number
  ttlMs?: number
}

export function createBatchManifest(input: BatchManifestInput): BatchManifest {
  const profileName = requireLabel(input.profileName, 'profile')
  const batchId = requireLabel(input.batchId ?? 'ledgerops-batch', 'batch id')
  const createdAt = input.createdAt ?? Date.now()
  requireTimestamp(createdAt, 'createdAt')
  const expiresAt = input.expiresAt ?? createdAt + (input.ttlMs ?? DEFAULT_BATCH_MANIFEST_TTL_MS)
  requireTimestamp(expiresAt, 'expiresAt')
  if (expiresAt <= createdAt) throw new RangeError('expiresAt must be after createdAt')

  const haltPolicy = input.haltPolicy ?? 'halt-on-stop'

  return batchManifestRecord.create({
    schemaVersion: 'ledgerops.batch-manifest.v1',
    batchId,
    profileName,
    provenance: input.provenance,
    entries: input.entries,
    haltPolicy,
    createdAt,
    expiresAt,
  })
}

export const verifyBatchManifestIntegrity = batchManifestRecord.verify

/** Parse-don't-validate: batch paths act only on the snapshot this returns. */
export const parseBatchManifest = batchManifestRecord.parse

/** Seal the immutable tenant before confirmation; historical v1 bytes stay unchanged. */
export function bindBatchManifestTenant(manifest: BatchManifest, tenantFingerprint: string): BatchManifest {
  const parsed = parseBatchManifest(manifest)
  if (!parsed) throw new TypeError('BATCH_MANIFEST_INVALID')
  const {manifestDigest: _digest, memberCount: _count, ...fields} = parsed
  return batchManifestRecord.create({...fields, schemaVersion: 'ledgerops.batch-manifest.v2', tenantFingerprint})
}

export function isBatchManifestUnexpired(manifest: BatchManifest, now = Date.now()): boolean {
  return Number.isFinite(now) && now < manifest.expiresAt
}

function requireLabel(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`)
  return value.trim()
}

function requireTimestamp(value: number, field: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${field} must be finite`)
}
