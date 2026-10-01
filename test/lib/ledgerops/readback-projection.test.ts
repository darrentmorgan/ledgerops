import {describe, expect, it, vi} from 'vitest'
import {
  classifyReadBack,
  confirmationTokenFor,
  createMutationPlan,
  createReadBackExpectation,
  createTargetIdentity,
  evaluateMutationGuard,
  executeMutation,
  InMemoryReceiptSink,
  parseReadBackExpectation,
  verifyReadBackExpectation,
  type ReadBackExpectation,
  type ReadBackTransportResult,
} from '../../../src/lib/ledgerops/index.js'
import {createDryRunTransport} from '../../../src/lib/ledgerops/dry-run-transport.js'

const NOW = Date.parse('2026-08-07T00:00:00.000Z')
const PROFILE = 'synthetic-demo-profile'
const RESOURCE = 'synthetic-resource'
const CAPABILITY = 'ledger.synthetic.write'
const SCOPE = 'ledger.synthetic.scope'

/** What the workflow plans: a DRAFT invoice payload, status included. */
const PAYLOAD = {
  type: 'ACCREC',
  reference: 'INV-001',
  lineAmountTypes: 'EXCLUSIVE',
  status: 'DRAFT',
  lineItems: [{description: 'Consulting', quantity: 1}],
}

/** The same draft as Xero answers it: server-generated fields added. */
const LIVE_RECORD = {
  ...PAYLOAD,
  invoiceID: '00000000-0000-0000-0000-000000000001',
  updatedDateUTC: '2026-08-07T00:05:00.000Z',
  hasAttachments: false,
}

/** Narrow on purpose: status stays outside the projection so the authority
 * path is exercised alongside the digest projection. */
const PROJECTION = ['lineAmountTypes', 'reference']

function found(record: unknown): ReadBackTransportResult {
  return {status: 'found', records: [record]}
}

function projectedExpectation(expected: unknown = PAYLOAD): ReadBackExpectation {
  return createReadBackExpectation({
    resource: RESOURCE,
    target: identity(),
    expected,
    projection: PROJECTION,
  })
}

function identity() {
  return createTargetIdentity({
    profileName: PROFILE,
    tenantId: 'synthetic-tenant',
    resource: RESOURCE,
    isDemoCompany: true,
    observedAt: NOW,
    freshUntil: NOW + 60_000,
    capabilities: [CAPABILITY],
    scopes: [SCOPE],
  })
}

function fixture(projection?: readonly string[]) {
  const target = identity()
  const plan = createMutationPlan({
    planId: 'projection-plan',
    profileName: PROFILE,
    resource: RESOURCE,
    operation: 'create',
    target,
    payload: PAYLOAD,
    requiredCapabilities: [CAPABILITY],
    requiredScopes: [SCOPE],
    readBack: {
      target,
      expected: PAYLOAD,
      ...(projection === undefined ? {} : {projection}),
    },
    createdAt: NOW,
    expiresAt: NOW + 120_000,
  })
  return {
    identity: target,
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

describe('read-back projection contract', () => {
  it('classifies a live-created record VERIFIED when provider-added fields fall outside the projection', () => {
    const expectation = projectedExpectation()
    expect(classifyReadBack(found(LIVE_RECORD), expectation)).toBe('verified')
  })

  it('signs a sorted, unique projection plus captured authority into the expectation', () => {
    const expectation = createReadBackExpectation({
      resource: RESOURCE,
      target: identity(),
      expected: PAYLOAD,
      // Supplied unsorted; the stored form must be canonical.
      projection: ['reference', 'lineAmountTypes'],
    })
    expect(expectation.projection).toEqual(['lineAmountTypes', 'reference'])
    expect(expectation.authority).toEqual([{key: 'status', value: 'DRAFT'}])
    expect(verifyReadBackExpectation(expectation)).toBe(true)
  })

  /**
   * Issue #71, the executable form of the contract: there is deliberately no
   * minimum-projection floor. A caller that declares `['reference']` gets a
   * VERIFIED that means "reference matched, and no authority key moved" — and
   * nothing else. Amounts, contact, and line items were never compared, so
   * they may differ freely. This test exists so the scope of VERIFIED cannot
   * be widened by accident: if a floor is ever introduced, it must fail here
   * first, as a decision, not as a silent behavior change.
   */
  it('VERIFIED is scoped to the declared projection, never to the whole record', () => {
    const expectation = createReadBackExpectation({
      resource: RESOURCE,
      target: identity(),
      expected: {
        reference: 'INV-001',
        status: 'DRAFT',
        total: 100,
        contact: {name: 'Planned Co'},
        lineItems: [{description: 'Consulting', quantity: 1}],
      },
      projection: ['reference'],
    })
    expect(expectation.projection).toEqual(['reference'])
    // Authority still fails closed outside the projection: status is captured.
    expect(expectation.authority).toEqual([{key: 'status', value: 'DRAFT'}])

    const divergent = {
      reference: 'INV-001',
      status: 'DRAFT',
      total: 999_999,
      contact: {name: 'Someone Else Entirely'},
      lineItems: [{description: 'Not what was planned', quantity: 42}],
    }
    expect(classifyReadBack(found(divergent), expectation)).toBe('verified')

    // The same divergence is a MISMATCH the moment the caller projects it.
    const widened = createReadBackExpectation({
      resource: RESOURCE,
      target: identity(),
      expected: {
        reference: 'INV-001',
        status: 'DRAFT',
        total: 100,
        contact: {name: 'Planned Co'},
        lineItems: [{description: 'Consulting', quantity: 1}],
      },
      projection: ['contact', 'lineItems', 'reference', 'total'],
    })
    expect(classifyReadBack(found(divergent), widened)).toBe('mismatch')
  })

  it('classifies MISMATCH when a projected field differs', () => {
    const expectation = projectedExpectation()
    expect(classifyReadBack(found({...LIVE_RECORD, reference: 'INV-002'}), expectation)).toBe('mismatch')
  })

  it('classifies MISMATCH when a projected field is missing from the read-back record', () => {
    const expectation = projectedExpectation()
    const {reference: _omitted, ...withoutReference} = LIVE_RECORD
    expect(classifyReadBack(found(withoutReference), expectation)).toBe('mismatch')
  })

  it('fails closed when an authority-relevant field changes outside the projection', () => {
    const expectation = projectedExpectation()
    expect(classifyReadBack(found({...LIVE_RECORD, status: 'AUTHORISED'}), expectation)).toBe('mismatch')
  })

  it('fails closed when a planned authority-relevant field vanishes from the read-back', () => {
    const expectation = projectedExpectation()
    const {status: _omitted, ...withoutStatus} = LIVE_RECORD
    expect(classifyReadBack(found(withoutStatus), expectation)).toBe('mismatch')
  })

  it('fails closed when an unplanned authority-relevant field appears on the read-back', () => {
    const expectation = createReadBackExpectation({
      resource: RESOURCE,
      target: identity(),
      expected: {reference: 'INV-001', lineAmountTypes: 'EXCLUSIVE'},
      projection: ['lineAmountTypes', 'reference'],
    })
    expect(expectation.authority).toBeUndefined()
    expect(
      classifyReadBack(found({reference: 'INV-001', lineAmountTypes: 'EXCLUSIVE', status: 'DRAFT'}), expectation),
    ).toBe('mismatch')
  })

  it('rejects tampered projections and authority requirements through verification', () => {
    const expectation = projectedExpectation()

    const tamperedProjection = JSON.parse(JSON.stringify(expectation)) as Record<string, unknown>
    ;(tamperedProjection.projection as string[])[1] = 'memo'
    expect(parseReadBackExpectation(tamperedProjection)).toBeUndefined()
    expect(verifyReadBackExpectation(tamperedProjection)).toBe(false)

    const tamperedAuthority = JSON.parse(JSON.stringify(expectation)) as Record<string, unknown>
    ;(tamperedAuthority.authority as Array<{key: string; value: string}>)[0].value = 'AUTHORISED'
    expect(parseReadBackExpectation(tamperedAuthority)).toBeUndefined()
    expect(verifyReadBackExpectation(tamperedAuthority)).toBe(false)
  })

  it('validates projections deterministically at creation time', () => {
    const base = {resource: RESOURCE, target: identity(), expected: PAYLOAD}
    expect(() => createReadBackExpectation({...base, projection: []})).toThrow(TypeError)
    expect(() => createReadBackExpectation({...base, projection: ['reference', 'reference']})).toThrow(TypeError)
    expect(() => createReadBackExpectation({...base, projection: ['']})).toThrow(TypeError)
    expect(() => createReadBackExpectation({...base, projection: [42] as unknown as string[]})).toThrow(TypeError)
    expect(() => createReadBackExpectation({...base, projection: ['not-in-expected']})).toThrow(TypeError)
    expect(() => createReadBackExpectation({...base, expected: 'not-an-object', projection: ['reference']})).toThrow(
      TypeError,
    )
    expect(() =>
      createReadBackExpectation({
        ...base,
        expected: {...PAYLOAD, status: {tier: 'DRAFT'}},
        projection: ['status'],
      }),
    ).toThrow(TypeError)
  })

  it('keeps projection-absent expectations byte-compatible with the pre-projection contract', () => {
    const expectation = createReadBackExpectation({
      resource: RESOURCE,
      target: identity(),
      expected: PAYLOAD,
    })
    const serialized = JSON.parse(JSON.stringify(expectation)) as Record<string, unknown>
    expect('projection' in serialized).toBe(false)
    expect('authority' in serialized).toBe(false)

    expect(classifyReadBack(found(structuredClone(PAYLOAD)), expectation)).toBe('verified')
    expect(classifyReadBack(found({...PAYLOAD, hasAttachments: false}), expectation)).toBe('mismatch')
  })

  it('signs the projection into the plan digest and rejects a swapped expectation in the guard', () => {
    const projected = fixture(PROJECTION)
    const unprojected = fixture()
    expect(projected.plan.readBackExpectation.expectationDigest).not.toBe(
      unprojected.plan.readBackExpectation.expectationDigest,
    )
    expect(projected.plan.planDigest).not.toBe(unprojected.plan.planDigest)

    const sink = new InMemoryReceiptSink()
    const swappedRequest = {
      ...projected.request,
      readBackExpectation: unprojected.plan.readBackExpectation,
    }
    const decision = evaluateMutationGuard({
      request: swappedRequest,
      plan: projected.plan,
      confirmation: confirmationTokenFor(projected.plan),
      context: {
        profileName: PROFILE,
        identity: projected.identity,
        receiptSink: sink,
        now: NOW + 1,
      },
      now: NOW + 1,
    })
    expect(decision).toEqual({allowed: false, code: 'READBACK_EXPECTATION_MISMATCH'})
  })

  it('executeMutation reaches VERIFIED through a live-like synthetic transport', async () => {
    const data = fixture(PROJECTION)
    const transport = {
      binding: data.plan.targetBinding,
      dispatch: vi.fn(async () => ({accepted: true})),
      readBack: vi.fn(async () => found(LIVE_RECORD)),
    }
    const sink = new InMemoryReceiptSink()

    const result = await executeMutation({
      request: data.request,
      plan: data.plan,
      confirmation: confirmationTokenFor(data.plan),
      context: {profileName: PROFILE, identity: data.identity, receiptSink: sink, now: NOW + 1},
      transport,
      now: NOW + 1,
    })

    expect(result.outcome).toBe('VERIFIED')
    expect(result.status).toBe('verified')
    expect(result.terminal).toBe('CONTINUE')
    expect(result.stop).toBe(false)
    expect(result.readBackClassification).toBe('verified')
    expect(result.receipt.outcome).toBe('VERIFIED')
    expect(sink.receipts[0]?.outcome).toBe('VERIFIED')
  })

  it('offline dry-run apply stays VERIFIED with a declared projection', async () => {
    const data = fixture(PROJECTION)
    const result = await executeMutation({
      request: data.request,
      plan: data.plan,
      confirmation: confirmationTokenFor(data.plan),
      context: {profileName: PROFILE, identity: data.identity, receiptSink: new InMemoryReceiptSink(), now: NOW + 1},
      transport: createDryRunTransport(data.identity),
      now: NOW + 1,
    })
    expect(result.outcome).toBe('VERIFIED')
    expect(result.readBackClassification).toBe('verified')
  })
})
