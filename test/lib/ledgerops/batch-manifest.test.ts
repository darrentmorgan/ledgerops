import {describe, expect, it} from 'vitest'
import {
  MAX_BATCH_MANIFEST_MEMBERS,
  createBatchManifest,
  digestJson,
  isBatchManifestUnexpired,
  parseBatchManifest,
  verifyBatchManifestIntegrity,
  type BatchManifest,
  type BatchManifestInput,
} from '../../../src/lib/ledgerops/index.js'

const CREATED_AT = Date.parse('2026-08-12T00:00:00.000Z')
const EXPIRES_AT = CREATED_AT + 300_000
const PROFILE = 'batch-profile'

function syntheticDigest(seed: string): string {
  return digestJson({seed})
}

function entries(count: number): readonly {planId: string; planDigest: string}[] {
  return Array.from({length: count}, (_unused, index) => ({
    planId: `batch-plan-${index + 1}`,
    planDigest: syntheticDigest(`plan-${index + 1}`),
  }))
}

const PROVENANCE = {
  sourceReceiptId: syntheticDigest('source-receipt'),
  sourceManifestHashes: [syntheticDigest('source-a'), syntheticDigest('source-b')].sort(),
}

function manifestInput(overrides: Partial<BatchManifestInput> = {}): BatchManifestInput {
  return {
    batchId: 'batch-1',
    profileName: PROFILE,
    entries: entries(3),
    provenance: PROVENANCE,
    createdAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
    ...overrides,
  }
}

function manifest(overrides: Partial<BatchManifestInput> = {}): BatchManifest {
  return createBatchManifest(manifestInput(overrides))
}

/** Mutate a signed manifest without re-signing it. */
function tampered(base: BatchManifest, patch: Record<string, unknown>): unknown {
  return {...(JSON.parse(JSON.stringify(base)) as Record<string, unknown>), ...patch}
}

describe('ledgerops.batch-manifest.v1 creation', () => {
  it('seals an ordered member list, provenance and halt policy into the manifest digest', () => {
    const record = manifest()

    expect(record.schemaVersion).toBe('ledgerops.batch-manifest.v1')
    expect(record.batchId).toBe('batch-1')
    expect(record.profileName).toBe(PROFILE)
    expect(record.haltPolicy).toBe('halt-on-stop')
    expect(record.memberCount).toBe(3)
    expect(record.entries.map(entry => entry.planId)).toEqual(['batch-plan-1', 'batch-plan-2', 'batch-plan-3'])
    expect(record.provenance).toEqual(PROVENANCE)
    expect(record.manifestDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(Object.isFrozen(record)).toBe(true)
    expect(Object.isFrozen(record.entries)).toBe(true)
  })

  it('accepts the opt-in continue-on-stop policy and seals it', () => {
    const halting = manifest()
    const continuing = manifest({haltPolicy: 'continue-on-stop'})

    expect(continuing.haltPolicy).toBe('continue-on-stop')
    expect(continuing.manifestDigest).not.toBe(halting.manifestDigest)
  })

  it('accepts the maximum member count and refuses one member more', () => {
    expect(manifest({entries: entries(MAX_BATCH_MANIFEST_MEMBERS)}).memberCount).toBe(MAX_BATCH_MANIFEST_MEMBERS)
    expect(() => manifest({entries: entries(MAX_BATCH_MANIFEST_MEMBERS + 1)})).toThrow()
  })

  it('refuses an empty manifest', () => {
    expect(() => manifest({entries: []})).toThrow()
  })

  it('refuses duplicate plan ids and duplicate plan digests', () => {
    const shared = entries(2)
    expect(() =>
      manifest({
        entries: [shared[0], {planId: shared[0].planId, planDigest: shared[1].planDigest}],
      }),
    ).toThrow()
    expect(() =>
      manifest({
        entries: [shared[0], {planId: shared[1].planId, planDigest: shared[0].planDigest}],
      }),
    ).toThrow()
  })

  it('refuses malformed entries, including a nested manifest', () => {
    expect(() => manifest({entries: [{planId: 'a', planDigest: 'not-a-digest'}]})).toThrow()
    expect(() => manifest({entries: [{planId: '', planDigest: syntheticDigest('x')}]})).toThrow()
    expect(() =>
      manifest({
        entries: [{...entries(1)[0], extra: 'field'}] as unknown as BatchManifestInput['entries'],
      }),
    ).toThrow()
    expect(() =>
      manifest({
        entries: [manifest() as unknown as BatchManifestInput['entries'][number]],
      }),
    ).toThrow()
  })

  it('refuses malformed provenance', () => {
    expect(() => manifest({provenance: {sourceReceiptId: 'nope', sourceManifestHashes: []}})).toThrow()
    expect(() =>
      manifest({
        provenance: {sourceReceiptId: PROVENANCE.sourceReceiptId, sourceManifestHashes: []},
      }),
    ).toThrow()
    const duplicated = syntheticDigest('source-a')
    expect(() =>
      manifest({
        provenance: {sourceReceiptId: PROVENANCE.sourceReceiptId, sourceManifestHashes: [duplicated, duplicated]},
      }),
    ).toThrow()
  })

  it('refuses an unordered ttl and an unknown halt policy', () => {
    expect(() => manifest({expiresAt: CREATED_AT})).toThrow()
    expect(() => manifest({haltPolicy: 'halt-sometimes' as BatchManifestInput['haltPolicy']})).toThrow()
  })

  it('keeps member order significant', () => {
    const forward = manifest()
    const reversed = manifest({entries: [...entries(3)].reverse()})

    expect(reversed.manifestDigest).not.toBe(forward.manifestDigest)
  })
})

describe('ledgerops.batch-manifest.v1 parsing', () => {
  it('round-trips a signed manifest through canonical JSON', () => {
    const record = manifest()
    const parsed = parseBatchManifest(JSON.parse(JSON.stringify(record)))

    expect(parsed).toEqual(record)
    expect(verifyBatchManifestIntegrity(record)).toBe(true)
  })

  it('refuses values that are not signed manifest objects', () => {
    for (const value of [undefined, null, 'manifest', 42, [], () => undefined, new Date()]) {
      expect(parseBatchManifest(value)).toBeUndefined()
      expect(verifyBatchManifestIntegrity(value)).toBe(false)
    }
  })

  it('refuses an extra key outside the sealed key set', () => {
    expect(parseBatchManifest(tampered(manifest(), {note: 'extra'}))).toBeUndefined()
  })

  it('refuses a missing key inside the sealed key set', () => {
    const record = JSON.parse(JSON.stringify(manifest())) as Record<string, unknown>
    delete record.haltPolicy
    expect(parseBatchManifest(record)).toBeUndefined()
  })

  it('refuses a tampered member list', () => {
    const record = manifest()
    expect(parseBatchManifest(tampered(record, {entries: [...record.entries].reverse()}))).toBeUndefined()
    expect(parseBatchManifest(tampered(record, {entries: record.entries.slice(0, 2)}))).toBeUndefined()
    expect(
      parseBatchManifest(
        tampered(record, {
          entries: [{planId: 'swapped', planDigest: record.entries[0].planDigest}, ...record.entries.slice(1)],
        }),
      ),
    ).toBeUndefined()
  })

  it('refuses a member count that disagrees with the member list', () => {
    expect(parseBatchManifest(tampered(manifest(), {memberCount: 2}))).toBeUndefined()
  })

  it('refuses tampered scalars, provenance and digest', () => {
    const record = manifest()
    expect(parseBatchManifest(tampered(record, {batchId: 'batch-2'}))).toBeUndefined()
    expect(parseBatchManifest(tampered(record, {profileName: 'other-profile'}))).toBeUndefined()
    expect(parseBatchManifest(tampered(record, {haltPolicy: 'continue-on-stop'}))).toBeUndefined()
    expect(parseBatchManifest(tampered(record, {expiresAt: record.expiresAt + 1}))).toBeUndefined()
    expect(
      parseBatchManifest(
        tampered(record, {
          provenance: {...record.provenance, sourceReceiptId: syntheticDigest('other-receipt')},
        }),
      ),
    ).toBeUndefined()
    expect(parseBatchManifest(tampered(record, {manifestDigest: syntheticDigest('forged')}))).toBeUndefined()
  })

  it('refuses a nested manifest smuggled into an entry', () => {
    const record = manifest()
    expect(
      parseBatchManifest(
        tampered(record, {
          entries: [{...record.entries[0], nested: record}, ...record.entries.slice(1)],
        }),
      ),
    ).toBeUndefined()
  })
})

describe('ledgerops.batch-manifest.v1 expiry', () => {
  it('reports expiry against the sealed window', () => {
    const record = manifest()
    expect(isBatchManifestUnexpired(record, CREATED_AT)).toBe(true)
    expect(isBatchManifestUnexpired(record, EXPIRES_AT - 1)).toBe(true)
    expect(isBatchManifestUnexpired(record, EXPIRES_AT)).toBe(false)
    expect(isBatchManifestUnexpired(record, Number.NaN)).toBe(false)
  })
})
