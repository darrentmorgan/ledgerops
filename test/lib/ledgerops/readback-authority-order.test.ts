import {describe, expect, it, vi} from 'vitest'

/**
 * READ_BACK_AUTHORITY_KEYS today holds a single key ('status'), so its
 * declaration order happens to be trivially sorted. This test simulates a
 * future where a second authority key is declared out of lexicographic
 * order, to prove captureAuthorityRequirements sorts on capture rather than
 * relying on declaration order matching isAuthorityRequirements' lexicographic
 * requirement (readback.ts:52). Without the fix, `create` mints a record its
 * own `parse`/`verify` rejects — a self-inflicted round-trip failure.
 */
vi.mock('../../../src/lib/ledgerops/types.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/lib/ledgerops/types.js')>()
  return {
    ...actual,
    // Declared out of lexicographic order on purpose: 'zeta' before 'alpha'.
    READ_BACK_AUTHORITY_KEYS: ['zeta', 'alpha'] as const,
  }
})

describe('authority requirement key ordering on capture', () => {
  it('captures authority requirements sorted lexicographically, so the minted expectation round-trips through parse/verify', async () => {
    const {createReadBackExpectation, verifyReadBackExpectation, parseReadBackExpectation, createTargetIdentity} =
      await import('../../../src/lib/ledgerops/index.js')

    const target = createTargetIdentity({
      profileName: 'synthetic-demo-profile',
      tenantId: 'synthetic-tenant',
      resource: 'synthetic-resource',
      isDemoCompany: true,
      observedAt: 0,
      freshUntil: 60_000,
      capabilities: ['ledger.synthetic.write'],
      scopes: ['ledger.synthetic.scope'],
    })

    const expectation = createReadBackExpectation({
      resource: 'synthetic-resource',
      target,
      // Supplied in declaration order (zeta, then alpha) to mirror how
      // captureAuthorityRequirements walks READ_BACK_AUTHORITY_KEYS.
      expected: {zeta: 'Z', alpha: 'A', memo: 'note'},
      projection: ['memo'],
    })

    expect(expectation.authority?.map(item => item.key)).toEqual(['alpha', 'zeta'])
    expect(parseReadBackExpectation(expectation)).toBeDefined()
    expect(verifyReadBackExpectation(expectation)).toBe(true)
  })
})
