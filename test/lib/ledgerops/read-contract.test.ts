import {readdirSync, readFileSync} from 'node:fs'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {describe, expect, it, vi} from 'vitest'
import {
  createReadReceipt,
  createTargetBinding,
  createTargetIdentity,
  executeRead,
  InMemoryReadReceiptSink,
  isReadReceipt,
  READ_MAX_CALLS_CEILING,
  READ_RECEIPT_ALLOWED_KEYS,
  READ_RESOURCE_NAMES,
  READ_RESOURCES,
  type ReadTransport,
  type TargetBinding,
} from '../../../src/lib/ledgerops/index.js'

const NOW = Date.parse('2026-08-07T00:00:00.000Z')
const PROFILE = 'synthetic-read-profile'
const RESOURCE = 'accounts'
const SPEC = READ_RESOURCES[RESOURCE]

function identityFor(overrides: {resource?: string; capabilities?: string[]; scopes?: string[]} = {}) {
  return createTargetIdentity({
    profileName: PROFILE,
    tenantId: 'synthetic-tenant',
    resource: overrides.resource ?? RESOURCE,
    isDemoCompany: false,
    observedAt: NOW,
    freshUntil: NOW + 60_000,
    capabilities: overrides.capabilities ?? [SPEC.capability],
    scopes: overrides.scopes ?? SPEC.scopes.map(group => group[0]),
  })
}

function transportFor(
  binding: TargetBinding,
  pages: Array<{records: unknown[]; done: boolean}>,
): ReadTransport & {read: ReturnType<typeof vi.fn>} {
  let index = 0
  return {
    binding,
    read: vi.fn(async () => {
      const page = pages[Math.min(index, pages.length - 1)]
      index += 1
      return page
    }),
  }
}

function context(identity = identityFor()) {
  return {identity, receiptSink: new InMemoryReadReceiptSink(), now: NOW}
}

describe('bounded READ contract', () => {
  it('releases redacted records and persists a signed OK receipt first', async () => {
    const ctx = context()
    const binding = createTargetBinding(ctx.identity)
    const transport = transportFor(binding, [{records: [{code: '200', name: 'Sales'}], done: true}])

    const result = await executeRead({profileName: PROFILE, resource: RESOURCE}, ctx, transport)

    expect(result.status).toBe('ok')
    expect(result.stop).toBe(false)
    expect(result.records).toEqual([{code: '200', name: 'Sales'}])
    expect(result.callCount).toBe(1)
    expect(result.recordCount).toBe(1)
    expect(result.receiptWriteFailed).toBe(false)
    expect(result.receipt && isReadReceipt(result.receipt)).toBe(true)
    expect(ctx.receiptSink.receipts).toHaveLength(1)
    expect(ctx.receiptSink.receipts[0]).toEqual(result.receipt)
    expect(result.receipt?.outcome).toBe('OK')
    expect(result.receipt?.terminal).toBe('CONTINUE')
    expect(result.receipt?.target).toEqual(binding)
  })

  it('every allowlisted resource declares a capability and non-empty scope groups', () => {
    expect(READ_RESOURCE_NAMES.length).toBeGreaterThan(0)
    for (const resource of READ_RESOURCE_NAMES) {
      const spec = READ_RESOURCES[resource]
      expect(spec.capability).toMatch(/^read\./)
      expect(spec.scopes.length).toBeGreaterThan(0)
      for (const group of spec.scopes) {
        expect(group.length).toBeGreaterThan(0)
        expect(group[0]).toMatch(/\.read$/)
      }
    }
  })

  it('stops on a resource outside the allowlist without touching the transport', async () => {
    const ctx = context(identityFor({resource: 'organisation-secrets'}))
    const transport = transportFor(createTargetBinding(ctx.identity), [{records: [], done: true}])

    const result = await executeRead({profileName: PROFILE, resource: 'organisation-secrets'}, ctx, transport)

    expect(result).toMatchObject({status: 'stop', stop: true, reasonCode: 'RESOURCE_NOT_ALLOWED'})
    expect(result.receipt).toBeUndefined()
    expect(transport.read).not.toHaveBeenCalled()
  })

  it('requires a fresh identity bound to the requested profile and resource', async () => {
    const identity = identityFor()
    const transport = transportFor(createTargetBinding(identity), [{records: [], done: true}])

    const missing = await executeRead(
      {profileName: PROFILE, resource: RESOURCE},
      {receiptSink: new InMemoryReadReceiptSink(), now: NOW},
      transport,
    )
    expect(missing.reasonCode).toBe('IDENTITY_REQUIRED')

    const stale = await executeRead(
      {profileName: PROFILE, resource: RESOURCE},
      {identity, receiptSink: new InMemoryReadReceiptSink(), now: NOW + 120_000},
      transport,
    )
    expect(stale.reasonCode).toBe('IDENTITY_STALE')

    const wrongProfile = await executeRead(
      {profileName: 'other-profile', resource: RESOURCE},
      {identity, receiptSink: new InMemoryReadReceiptSink(), now: NOW},
      transport,
    )
    expect(wrongProfile.reasonCode).toBe('PROFILE_MISMATCH')

    const contactsIdentity = identityFor({resource: 'contacts'})
    const wrongResource = await executeRead(
      {profileName: PROFILE, resource: RESOURCE},
      {identity: contactsIdentity, receiptSink: new InMemoryReadReceiptSink(), now: NOW},
      transport,
    )
    expect(wrongResource.reasonCode).toBe('RESOURCE_MISMATCH')
    expect(transport.read).not.toHaveBeenCalled()
  })

  it('stops when the identity lacks the resource capability or scope', async () => {
    const noCapability = identityFor({capabilities: ['read.contacts']})
    const capabilityStop = await executeRead(
      {profileName: PROFILE, resource: RESOURCE},
      context(noCapability),
      transportFor(createTargetBinding(noCapability), [{records: [], done: true}]),
    )
    expect(capabilityStop.reasonCode).toBe('CAPABILITY_REQUIRED')

    const noScope = identityFor({scopes: ['accounting.contacts']})
    const scopeStop = await executeRead(
      {profileName: PROFILE, resource: RESOURCE},
      context(noScope),
      transportFor(createTargetBinding(noScope), [{records: [], done: true}]),
    )
    expect(scopeStop.reasonCode).toBe('SCOPE_REQUIRED')

    const writeScope = identityFor({scopes: ['accounting.settings']})
    const satisfied = await executeRead(
      {profileName: PROFILE, resource: RESOURCE},
      context(writeScope),
      transportFor(createTargetBinding(writeScope), [{records: [], done: true}]),
    )
    expect(satisfied.status).toBe('ok')
  })

  it('stops on a structurally invalid identity as IDENTITY_INVALID, not staleness', async () => {
    const identity = identityFor()
    const tampered = {...identity, capabilitiesFingerprint: 'f'.repeat(64)} as typeof identity
    const transport = transportFor(createTargetBinding(identity), [{records: [], done: true}])

    const result = await executeRead(
      {profileName: PROFILE, resource: RESOURCE},
      {identity: tampered, receiptSink: new InMemoryReadReceiptSink(), now: NOW},
      transport,
    )
    expect(result.reasonCode).toBe('IDENTITY_INVALID')
    expect(transport.read).not.toHaveBeenCalled()
  })

  it('bounds transport calls: bad bounds stop early, exhaustion withholds records', async () => {
    const ctx = context()
    const binding = createTargetBinding(ctx.identity)

    const invalid = await executeRead(
      {profileName: PROFILE, resource: RESOURCE, maxCalls: READ_MAX_CALLS_CEILING + 1},
      ctx,
      transportFor(binding, [{records: [], done: true}]),
    )
    expect(invalid.reasonCode).toBe('CALL_BOUND_INVALID')

    const neverDone = transportFor(binding, [{records: [{code: '200'}], done: false}])
    const exhausted = await executeRead({profileName: PROFILE, resource: RESOURCE, maxCalls: 3}, context(), neverDone)
    expect(exhausted).toMatchObject({status: 'stop', reasonCode: 'CALL_BOUND_EXCEEDED', callCount: 3})
    expect(exhausted.records).toEqual([])
    expect(neverDone.read).toHaveBeenCalledTimes(3)
  })

  it('collects across calls up to the bound when the transport finishes', async () => {
    const ctx = context()
    const binding = createTargetBinding(ctx.identity)
    const transport: ReadTransport = {
      binding,
      read: vi.fn(async ({call}) =>
        call === 1 ? {records: [{code: 'a'}], done: false} : {records: [{code: 'b'}], done: true},
      ),
    }

    const result = await executeRead({profileName: PROFILE, resource: RESOURCE, maxCalls: 2}, ctx, transport)

    expect(result.status).toBe('ok')
    expect(result.records).toEqual([{code: 'a'}, {code: 'b'}])
    expect(result.receipt?.callCount).toBe(2)
    expect(result.receipt?.recordCount).toBe(2)
  })

  it('refuses a transport bound to a different target', async () => {
    const ctx = context()
    const other = identityFor({resource: 'contacts'})
    const transport = transportFor(createTargetBinding(other), [{records: [], done: true}])

    const result = await executeRead({profileName: PROFILE, resource: RESOURCE}, ctx, transport)

    expect(result.reasonCode).toBe('TRANSPORT_BINDING_MISMATCH')
    expect(transport.read).not.toHaveBeenCalled()
  })

  it('withholds every record when any one is secret-shaped, with a STOP receipt', async () => {
    const ctx = context()
    const binding = createTargetBinding(ctx.identity)
    const transport = transportFor(binding, [
      {records: [{code: '200'}, {code: '400', accessToken: 'oops'}], done: true},
    ])

    const result = await executeRead({profileName: PROFILE, resource: RESOURCE}, ctx, transport)

    expect(result).toMatchObject({status: 'stop', reasonCode: 'OUTPUT_UNSAFE'})
    expect(result.records).toEqual([])
    expect(ctx.receiptSink.receipts).toHaveLength(1)
    expect(ctx.receiptSink.receipts[0].outcome).toBe('STOP')
    expect(ctx.receiptSink.receipts[0].reasonCode).toBe('OUTPUT_UNSAFE')
  })

  it('rejects secret-shaped or non-canonical queries before any call', async () => {
    const ctx = context()
    const transport = transportFor(createTargetBinding(ctx.identity), [{records: [], done: true}])

    const secret = await executeRead(
      {profileName: PROFILE, resource: RESOURCE, query: {where: 'x', apiKey: 'y'}},
      ctx,
      transport,
    )
    expect(secret.reasonCode).toBe('QUERY_UNSAFE')

    const circular: Record<string, unknown> = {}
    circular.self = circular
    const invalid = await executeRead({profileName: PROFILE, resource: RESOURCE, query: circular}, ctx, transport)
    expect(invalid.reasonCode).toBe('QUERY_UNSAFE')
    expect(transport.read).not.toHaveBeenCalled()
  })

  it('requires a receipt sink and releases nothing when the receipt write fails', async () => {
    const identity = identityFor()
    const binding = createTargetBinding(identity)

    const missingSink = await executeRead(
      {profileName: PROFILE, resource: RESOURCE},
      {identity, now: NOW},
      transportFor(binding, [{records: [], done: true}]),
    )
    expect(missingSink.reasonCode).toBe('RECEIPT_SINK_REQUIRED')

    const failingSink = {
      writeRead: vi.fn(() => {
        throw new Error('disk full')
      }),
    }
    const result = await executeRead(
      {profileName: PROFILE, resource: RESOURCE},
      {identity, receiptSink: failingSink, now: NOW},
      transportFor(binding, [{records: [{code: '200'}], done: true}]),
    )
    expect(result).toMatchObject({status: 'stop', reasonCode: 'RECEIPT_WRITE_FAILED', receiptWriteFailed: true})
    expect(result.records).toEqual([])
    // An unpersisted OK receipt must not circulate as a signed success claim.
    expect(result.receipt).toBeUndefined()
  })

  it('stops with a receipt when the transport throws or answers garbage', async () => {
    const ctx = context()
    const binding = createTargetBinding(ctx.identity)

    const throwing: ReadTransport = {
      binding,
      read: vi.fn(async () => {
        throw new Error('network')
      }),
    }
    const failed = await executeRead({profileName: PROFILE, resource: RESOURCE}, ctx, throwing)
    expect(failed.reasonCode).toBe('TRANSPORT_FAILED')
    expect(ctx.receiptSink.receipts.at(-1)?.reasonCode).toBe('TRANSPORT_FAILED')

    const garbage: ReadTransport = {
      binding,
      read: vi.fn(async () => ({records: 'nope', done: 'maybe'}) as never),
    }
    const invalid = await executeRead({profileName: PROFILE, resource: RESOURCE}, context(), garbage)
    expect(invalid.reasonCode).toBe('TRANSPORT_INVALID')
  })

  it('keeps the Xero SDK behind the live adapters inside the kernel', () => {
    const kernelDir = fileURLToPath(new URL('../../../src/lib/ledgerops', import.meta.url))
    const allowed = new Set(['xero-live-identity.ts', 'xero-live-read.ts', 'xero-live-draft.ts'])
    const offenders: string[] = []
    const walk = (dir: string, prefix: string): void => {
      for (const entry of readdirSync(dir, {withFileTypes: true})) {
        const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
        if (entry.isDirectory()) {
          walk(join(dir, entry.name), relative)
        } else if (
          entry.name.endsWith('.ts') &&
          !allowed.has(relative) &&
          readFileSync(join(dir, entry.name), 'utf8').includes('xero-node')
        ) {
          offenders.push(relative)
        }
      }
    }
    walk(kernelDir, '')
    expect(offenders).toEqual([])
  })

  it('signs receipts against forgery and the sink rejects forged values', () => {
    const identity = identityFor()
    const receipt = createReadReceipt({
      recordedAt: NOW,
      profileName: PROFILE,
      resource: RESOURCE,
      target: createTargetBinding(identity),
      queryDigest: 'a'.repeat(64),
      maxCalls: 1,
      callCount: 1,
      recordCount: 2,
      outcome: 'OK',
      terminal: 'CONTINUE',
    })
    expect(isReadReceipt(receipt)).toBe(true)
    expect(READ_RECEIPT_ALLOWED_KEYS).toContain('receiptId')

    const forged = {...receipt, recordCount: 99}
    expect(isReadReceipt(forged)).toBe(false)
    const sink = new InMemoryReadReceiptSink()
    expect(() => sink.writeRead(forged as never)).toThrow(/read receipts/)
  })

  it('refuses to sign a receipt for a resource outside the allowlist', () => {
    const identity = createTargetIdentity({
      profileName: PROFILE,
      tenantId: 'synthetic-tenant',
      resource: 'payroll',
      isDemoCompany: false,
      observedAt: NOW,
      freshUntil: NOW + 60_000,
    })
    expect(() =>
      createReadReceipt({
        recordedAt: NOW,
        profileName: PROFILE,
        resource: 'payroll',
        target: createTargetBinding(identity),
        queryDigest: 'a'.repeat(64),
        maxCalls: 1,
        callCount: 1,
        recordCount: 0,
        outcome: 'OK',
        terminal: 'CONTINUE',
      }),
    ).toThrow(/resourceIsAllowlisted/)
  })
})
