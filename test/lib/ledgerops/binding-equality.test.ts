import {describe, expect, it} from 'vitest'
import {
  createMutationPlan,
  createReadBackExpectation,
  createTargetBinding,
  createTargetIdentity,
  sameBinding,
  type TargetBinding,
  type TargetIdentity,
} from '../../../src/lib/ledgerops/index.js'

const NOW = Date.parse('2026-08-07T00:00:00.000Z')
const PROFILE = 'synthetic-demo-profile'
const RESOURCE = 'synthetic-resource'

function identityFor(objectId?: string): TargetIdentity {
  return createTargetIdentity({
    profileName: PROFILE,
    tenantId: 'synthetic-tenant',
    resource: RESOURCE,
    ...(objectId === undefined ? {} : {objectId}),
    isDemoCompany: true,
    observedAt: NOW,
    freshUntil: NOW + 60_000,
    capabilities: ['ledger.synthetic.write'],
    scopes: ['ledger.synthetic.scope'],
  })
}

describe('sameBinding', () => {
  it('matches a binding against itself, with and without an object fingerprint', () => {
    const bare = createTargetBinding(identityFor())
    const scoped = createTargetBinding(identityFor('synthetic-object'))

    expect(sameBinding(bare, bare)).toBe(true)
    expect(sameBinding(scoped, scoped)).toBe(true)
    expect(sameBinding(bare, scoped)).toBe(false)
  })

  it('rejects a binding that differs in any single field, even with the same target fingerprint', () => {
    const binding = createTargetBinding(identityFor('synthetic-object'))
    const forgeries: Array<Partial<TargetBinding>> = [
      {profileName: 'other-profile'},
      {resource: 'other-resource'},
      {tenantFingerprint: binding.targetFingerprint},
      {objectFingerprint: binding.targetFingerprint},
      {targetFingerprint: binding.tenantFingerprint},
    ]

    for (const forgery of forgeries) {
      expect(sameBinding(binding, {...binding, ...forgery})).toBe(false)
    }
  })
})

describe('createMutationPlan binding equality', () => {
  it('rejects a read-back expectation whose binding shares only the target fingerprint', () => {
    const identity = identityFor()
    const forgedBinding = {...createTargetBinding(identity), profileName: 'other-profile'}
    const forgedExpectation = createReadBackExpectation({
      resource: RESOURCE,
      target: forgedBinding,
      expected: {amount: '10.01'},
    })

    expect(() =>
      createMutationPlan({
        profileName: PROFILE,
        resource: RESOURCE,
        operation: 'create',
        target: identity,
        payload: {amount: '10.01'},
        requiredCapabilities: ['ledger.synthetic.write'],
        requiredScopes: ['ledger.synthetic.scope'],
        readBackExpectation: forgedExpectation,
        createdAt: NOW,
        expiresAt: NOW + 120_000,
      }),
    ).toThrow('Read-back expectation does not match the plan target')
  })
})
