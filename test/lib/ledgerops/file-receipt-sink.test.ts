import {chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {createDryRunTransport} from '../../../src/lib/ledgerops/dry-run-transport.js'
import {
  confirmationTokenFor,
  createBatchLink,
  createBatchManifest,
  createBatchReceipt,
  createFileReceiptSink,
  createMutationPlan,
  createReplayClaim,
  createTargetIdentity,
  createWriteAheadIntent,
  defaultReceiptFilePath,
  executeMutation,
  FileReceiptSink,
  isAuditReceipt,
  isReplayClaim,
  isWriteAheadIntent,
  parseBatchLink,
  parseBatchManifest,
  parseBatchReceipt,
  RECEIPT_FILE_NAME,
} from '../../../src/lib/ledgerops/index.js'

const NOW = Date.parse('2026-08-07T00:00:00.000Z')
const PROFILE = 'synthetic-demo-profile'
const RESOURCE = 'synthetic-resource'
const CAPABILITY = 'ledger.synthetic.write'
const SCOPE = 'ledger.synthetic.scope'
const PAYLOAD = {amount: '10.01'}

const scratchDirs: string[] = []

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ledgerops-sink-'))
  scratchDirs.push(dir)
  return dir
}

afterEach(() => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop()
    if (dir) rmSync(dir, {force: true, recursive: true})
  }
})

function fixture() {
  const identity = createTargetIdentity({
    profileName: PROFILE,
    tenantId: 'synthetic-tenant',
    resource: RESOURCE,
    isDemoCompany: true,
    observedAt: NOW,
    freshUntil: NOW + 60_000,
    capabilities: [CAPABILITY],
    scopes: [SCOPE],
  })
  const plan = createMutationPlan({
    planId: 'file-sink-plan',
    profileName: PROFILE,
    resource: RESOURCE,
    operation: 'create',
    target: identity,
    payload: PAYLOAD,
    requiredCapabilities: [CAPABILITY],
    requiredScopes: [SCOPE],
    readBack: {expected: PAYLOAD},
    createdAt: NOW,
    expiresAt: NOW + 120_000,
  })
  return {
    identity,
    plan,
    request: {
      profileName: PROFILE,
      resource: RESOURCE,
      operation: 'create' as const,
      payload: PAYLOAD,
      objectCount: 1 as const,
      readBackExpectation: plan.readBackExpectation,
    },
  }
}

function readLines(path: string): string[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(line => line !== '')
}

function batchFixture() {
  const provenance = {
    sourceReceiptId: 'a'.repeat(64),
    sourceManifestHashes: ['b'.repeat(64)],
  }
  const manifest = createBatchManifest({
    batchId: 'file-sink-batch',
    profileName: PROFILE,
    entries: [{planId: 'member-1', planDigest: 'c'.repeat(64)}],
    provenance,
    createdAt: NOW,
    expiresAt: NOW + 60_000,
  })
  const link = createBatchLink({
    batchId: manifest.batchId,
    manifestDigest: manifest.manifestDigest,
    index: 0,
    planId: 'member-1',
    planDigest: 'c'.repeat(64),
    outcome: 'accepted',
    receiptId: 'd'.repeat(64),
  })
  const receipt = createBatchReceipt({
    batchId: manifest.batchId,
    manifestDigest: manifest.manifestDigest,
    provenance,
    items: [{planId: 'member-1', outcome: 'accepted', receiptId: 'd'.repeat(64)}],
    recordedAt: NOW + 1,
  })
  return {manifest, link, receipt}
}

describe('FileReceiptSink', () => {
  it('durably appends generic replay claims across sink instances without changing earlier records', () => {
    const path = join(scratchDir(), RECEIPT_FILE_NAME)
    const first = createReplayClaim({
      recordedAt: NOW,
      operationId: 'a'.repeat(64),
      planDigest: 'b'.repeat(64),
    })
    const second = createReplayClaim({
      recordedAt: NOW + 1,
      operationId: 'c'.repeat(64),
      planDigest: 'd'.repeat(64),
    })
    new FileReceiptSink({path}).writeReplayClaim(first)
    const original = readFileSync(path, 'utf8')
    new FileReceiptSink({path}).writeReplayClaim(second)
    const records = readLines(path).map(line => JSON.parse(line))
    expect(records).toEqual([first, second])
    expect(records.every(isReplayClaim)).toBe(true)
    expect(records[0].schemaVersion).toBe('ledgerops.replay-claim.v1')
    expect(readFileSync(path, 'utf8').startsWith(original)).toBe(true)
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('refuses forged or modified replay claims before appending any bytes', () => {
    const path = join(scratchDir(), RECEIPT_FILE_NAME)
    const sink = new FileReceiptSink({path})
    const claim = createReplayClaim({
      recordedAt: NOW,
      operationId: 'a'.repeat(64),
      planDigest: 'b'.repeat(64),
    })
    expect(() => sink.writeReplayClaim({forged: true} as never)).toThrow(TypeError)
    expect(() => readFileSync(path)).toThrow()
    sink.writeReplayClaim(claim)
    const original = readFileSync(path, 'utf8')
    expect(() => sink.writeReplayClaim({...claim, operationId: 'c'.repeat(64)})).toThrow(TypeError)
    expect(readFileSync(path, 'utf8')).toBe(original)
  })

  it('defaults to ~/.config/ledgerops and honours XDG_CONFIG_HOME', () => {
    expect(defaultReceiptFilePath({})).toMatch(/\.config[/\\]ledgerops[/\\]receipts\.jsonl$/)
    expect(defaultReceiptFilePath({XDG_CONFIG_HOME: '/synthetic/xdg'})).toBe(
      join('/synthetic/xdg', 'ledgerops', RECEIPT_FILE_NAME),
    )
    expect(defaultReceiptFilePath({XDG_CONFIG_HOME: '  '})).toMatch(/\.config[/\\]ledgerops[/\\]receipts\.jsonl$/)
    // A relative XDG path could land receipts inside a repository checkout.
    expect(defaultReceiptFilePath({XDG_CONFIG_HOME: 'relative/xdg'})).toMatch(
      /\.config[/\\]ledgerops[/\\]receipts\.jsonl$/,
    )
  })

  // POSIX mode bits have no equivalent in Windows chmod.
  it.skipIf(process.platform === 'win32')('re-tightens permissive modes on a pre-existing store', () => {
    const data = fixture()
    const dir = join(scratchDir(), 'ledgerops')
    const path = join(dir, RECEIPT_FILE_NAME)
    mkdirSync(dir, {mode: 0o755})
    writeFileSync(path, '', {mode: 0o644})
    chmodSync(dir, 0o755)
    chmodSync(path, 0o644)

    new FileReceiptSink({path}).writeAhead(
      createWriteAheadIntent({
        recordedAt: NOW + 1,
        profileName: PROFILE,
        resource: RESOURCE,
        operation: 'create',
        target: data.plan.targetBinding,
        planDigest: data.plan.planDigest,
        confirmationDigest: data.plan.planDigest,
      }),
    )

    expect(statSync(dir).mode & 0o777).toBe(0o700)
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readLines(path)).toHaveLength(1)
  })

  it.skipIf(process.platform === 'win32')("leaves a caller-supplied shared parent directory's modes alone", () => {
    const data = fixture()
    const dir = scratchDir()
    chmodSync(dir, 0o755)
    const path = join(dir, RECEIPT_FILE_NAME)

    new FileReceiptSink({path}).writeAhead(
      createWriteAheadIntent({
        recordedAt: NOW + 1,
        profileName: PROFILE,
        resource: RESOURCE,
        operation: 'create',
        target: data.plan.targetBinding,
        planDigest: data.plan.planDigest,
        confirmationDigest: data.plan.planDigest,
      }),
    )

    expect(statSync(dir).mode & 0o777).toBe(0o755)
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('appends intents and receipts as verifiable JSONL, across sink instances', async () => {
    const data = fixture()
    const path = join(scratchDir(), RECEIPT_FILE_NAME)
    const sink = createFileReceiptSink({path})

    const result = await executeMutation({
      ...data,
      confirmation: confirmationTokenFor(data.plan),
      context: {
        profileName: PROFILE,
        identity: data.identity,
        receiptSink: sink,
        now: NOW + 1,
      },
      transport: createDryRunTransport(data.identity),
      now: NOW + 1,
    })
    expect(result.outcome).toBe('VERIFIED')
    expect(result.receiptWriteFailed).toBe(false)

    let lines = readLines(path)
    expect(lines).toHaveLength(2)
    const intent = JSON.parse(lines[0])
    const receipt = JSON.parse(lines[1])
    expect(isWriteAheadIntent(intent)).toBe(true)
    expect(isAuditReceipt(receipt)).toBe(true)
    expect(receipt.planDigest).toBe(intent.planDigest)

    // A second sink instance appends — nothing truncates the store.
    const laterSink = new FileReceiptSink({path})
    laterSink.writeAhead(
      createWriteAheadIntent({
        recordedAt: NOW + 2,
        profileName: PROFILE,
        resource: RESOURCE,
        operation: 'create',
        target: data.plan.targetBinding,
        planDigest: data.plan.planDigest,
        confirmationDigest: data.plan.planDigest,
      }),
    )
    lines = readLines(path)
    expect(lines).toHaveLength(3)
    expect(JSON.parse(lines[0])).toEqual(intent)

    const fileMode = statSync(path).mode & 0o777
    if (process.platform !== 'win32') expect(fileMode).toBe(0o600)
  })

  it('refuses to persist values that are not signed LedgerOps records', () => {
    const path = join(scratchDir(), RECEIPT_FILE_NAME)
    const sink = new FileReceiptSink({path})
    expect(() => sink.writeAhead({forged: true} as never)).toThrow(TypeError)
    expect(() => sink.write({forged: true} as never)).toThrow(TypeError)
    expect(() => readFileSync(path)).toThrow()
  })

  it('surfaces storage failure as RECEIPT_SINK_UNAVAILABLE before dispatch', async () => {
    const data = fixture()
    const dir = scratchDir()
    // A regular file cannot be a parent directory on any supported platform.
    writeFileSync(join(dir, 'nested'), 'not a directory')
    const sink = new FileReceiptSink({
      path: join(dir, 'nested', RECEIPT_FILE_NAME),
    })
    const dispatch = vi.fn(async () => ({accepted: true}))

    const result = await executeMutation({
      ...data,
      confirmation: confirmationTokenFor(data.plan),
      context: {
        profileName: PROFILE,
        identity: data.identity,
        receiptSink: sink,
        now: NOW + 1,
      },
      transport: {
        binding: data.plan.targetBinding,
        dispatch,
        readBack: vi.fn(async () => ({
          status: 'found' as const,
          records: [PAYLOAD],
        })),
      },
      now: NOW + 1,
    })

    expect(result).toEqual(
      expect.objectContaining({
        outcome: 'STOP',
        dispatched: false,
        dispatchState: 'not-dispatched',
      }),
    )
    expect(dispatch).not.toHaveBeenCalled()
    expect(result.receipt.reasonCode).toBe('RECEIPT_SINK_UNAVAILABLE')
  })

  it('appends batch manifest, link, and receipt records as verifiable JSONL', () => {
    const {manifest, link, receipt} = batchFixture()
    const path = join(scratchDir(), RECEIPT_FILE_NAME)
    const sink = createFileReceiptSink({path})

    sink.writeBatchManifest(manifest)
    sink.writeBatchLink(link)
    sink.writeBatchReceipt(receipt)

    const lines = readLines(path)
    expect(lines).toHaveLength(3)
    expect(parseBatchManifest(JSON.parse(lines[0]))).toEqual(manifest)
    expect(parseBatchLink(JSON.parse(lines[1]))).toEqual(link)
    expect(parseBatchReceipt(JSON.parse(lines[2]))).toEqual(receipt)

    const fileMode = statSync(path).mode & 0o777
    if (process.platform !== 'win32') expect(fileMode).toBe(0o600)
  })

  it('orders batch records after a write-ahead intent in the same append-only store', () => {
    const data = fixture()
    const {link} = batchFixture()
    const path = join(scratchDir(), RECEIPT_FILE_NAME)
    const sink = createFileReceiptSink({path})

    sink.writeAhead(
      createWriteAheadIntent({
        recordedAt: NOW,
        profileName: PROFILE,
        resource: RESOURCE,
        operation: 'create',
        target: data.plan.targetBinding,
        planDigest: data.plan.planDigest,
        confirmationDigest: data.plan.planDigest,
      }),
    )
    sink.writeBatchLink(link)

    const lines = readLines(path)
    expect(lines).toHaveLength(2)
    expect(isWriteAheadIntent(JSON.parse(lines[0]))).toBe(true)
    expect(parseBatchLink(JSON.parse(lines[1]))).toEqual(link)
  })

  it('rejects unregistered record shapes for every batch method, persisting nothing', () => {
    const path = join(scratchDir(), RECEIPT_FILE_NAME)
    const sink = new FileReceiptSink({path})

    expect(() => sink.writeBatchManifest({forged: true} as never)).toThrow(TypeError)
    expect(() => sink.writeBatchLink({forged: true} as never)).toThrow(TypeError)
    expect(() => sink.writeBatchReceipt({forged: true} as never)).toThrow(TypeError)
    expect(() => readFileSync(path)).toThrow()
  })

  it('leaves every previously appended batch record intact and parseable after each append', () => {
    const {manifest, link, receipt} = batchFixture()
    const path = join(scratchDir(), RECEIPT_FILE_NAME)
    const sink = createFileReceiptSink({path})

    sink.writeBatchManifest(manifest)
    let lines = readLines(path)
    expect(lines).toHaveLength(1)
    expect(parseBatchManifest(JSON.parse(lines[0]))).toEqual(manifest)

    sink.writeBatchLink(link)
    lines = readLines(path)
    expect(lines).toHaveLength(2)
    // The first line was never rewritten by the second append.
    expect(parseBatchManifest(JSON.parse(lines[0]))).toEqual(manifest)
    expect(parseBatchLink(JSON.parse(lines[1]))).toEqual(link)

    // A fresh sink instance over the same store only ever appends.
    const laterSink = new FileReceiptSink({path})
    laterSink.writeBatchReceipt(receipt)
    lines = readLines(path)
    expect(lines).toHaveLength(3)
    expect(parseBatchManifest(JSON.parse(lines[0]))).toEqual(manifest)
    expect(parseBatchLink(JSON.parse(lines[1]))).toEqual(link)
    expect(parseBatchReceipt(JSON.parse(lines[2]))).toEqual(receipt)
  })
})
