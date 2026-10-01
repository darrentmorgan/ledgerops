import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterAll, beforeAll, describe, expect, it} from 'vitest'
import {createMutationPlan, createTargetIdentity, type MutationPlan} from '../../../src/lib/ledgerops/index.js'
import {
  applyRequestFor,
  loadOfflineIdentity,
  loadOfflinePlan,
  loadPlanInput,
  OfflineTargetError,
} from '../../../src/lib/ledgerops/offline-target.js'

const PROFILE = 'synthetic-loader-profile'
const RESOURCE = 'synthetic-loader-resource'
const TENANT = 'synthetic-loader-tenant-must-not-echo'
const SECRET = 'synthetic-loader-access-token-must-not-echo'
const OBSERVED_AT = Date.parse('2026-08-08T00:00:00.000Z')
const CREATED_AT = OBSERVED_AT
const EXPIRES_AT = OBSERVED_AT + 86_400_000

const identityFile = {
  profileName: PROFILE,
  tenantId: TENANT,
  resource: RESOURCE,
  isDemoCompany: true,
  observedAt: OBSERVED_AT,
  freshUntil: OBSERVED_AT + 3_600_000,
  capabilities: ['ledger.synthetic.write'],
  scopes: ['ledger.synthetic.scope'],
}

let directory: string

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'ledgerops-offline-target-'))
})

afterAll(() => rmSync(directory, {recursive: true, force: true}))

let fileCounter = 0

function writeJson(value: unknown): string {
  fileCounter += 1
  const path = join(directory, `fixture-${fileCounter}.json`)
  writeFileSync(path, JSON.stringify(value))
  return path
}

function validPlan(): MutationPlan {
  return createMutationPlan({
    planId: 'synthetic-loader-plan',
    profileName: PROFILE,
    resource: RESOURCE,
    operation: 'create',
    target: createTargetIdentity(identityFile),
    payload: {amount: '10.01', label: 'synthetic'},
    requiredCapabilities: ['ledger.synthetic.write'],
    requiredScopes: ['ledger.synthetic.scope'],
    readBack: {expected: {amount: '10.01', label: 'synthetic'}},
    createdAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
  })
}

function codeOf(run: () => unknown): string {
  try {
    run()
  } catch (caught) {
    expect(caught).toBeInstanceOf(OfflineTargetError)
    return (caught as OfflineTargetError).code
  }
  throw new Error('expected the loader to throw')
}

describe('loadOfflineIdentity', () => {
  it('returns a kernel identity for a well-formed file', () => {
    const identity = loadOfflineIdentity(writeJson(identityFile), PROFILE, RESOURCE)

    expect(identity.profileName).toBe(PROFILE)
    expect(identity.resource).toBe(RESOURCE)
    expect(identity.isDemoCompany).toBe(true)
    expect(identity.capabilities).toEqual(['ledger.synthetic.write'])
  })

  it('reports FILE_UNREADABLE for a missing file', () => {
    expect(codeOf(() => loadOfflineIdentity(join(directory, 'absent.json'), PROFILE, RESOURCE))).toBe('FILE_UNREADABLE')
  })

  it('reports FILE_UNREADABLE for JSON that is not an object', () => {
    expect(codeOf(() => loadOfflineIdentity(writeJson([identityFile]), PROFILE, RESOURCE))).toBe('FILE_UNREADABLE')
  })

  it('reports FILE_UNREADABLE for a file that is not JSON at all', () => {
    fileCounter += 1
    const path = join(directory, `broken-${fileCounter}.json`)
    writeFileSync(path, '{not json')
    expect(codeOf(() => loadOfflineIdentity(path, PROFILE, RESOURCE))).toBe('FILE_UNREADABLE')
  })

  it.each([
    ['tenantId', {...identityFile, tenantId: ''}],
    ['isDemoCompany', {...identityFile, isDemoCompany: 'yes'}],
    ['observedAt', {...identityFile, observedAt: 'now'}],
    ['capabilities', {...identityFile, capabilities: [1, 2]}],
    ['scopes', {...identityFile, scopes: 'ledger.synthetic.scope'}],
  ])('reports IDENTITY_INVALID for a bad %s field', (_label, file) => {
    expect(codeOf(() => loadOfflineIdentity(writeJson(file), PROFILE, RESOURCE))).toBe('IDENTITY_INVALID')
  })

  it('reports IDENTITY_INVALID when the kernel rejects the assembled fields', () => {
    const path = writeJson({...identityFile, freshUntil: OBSERVED_AT - 1})
    expect(codeOf(() => loadOfflineIdentity(path, PROFILE, RESOURCE))).toBe('IDENTITY_INVALID')
  })

  it.each([
    ['profile', 'other-profile', RESOURCE],
    ['resource', PROFILE, 'other-resource'],
  ])('reports TARGET_MISMATCH when the %s flag disagrees', (_label, profile, resource) => {
    expect(codeOf(() => loadOfflineIdentity(writeJson(identityFile), profile, resource))).toBe('TARGET_MISMATCH')
  })

  it('never echoes the tenant identifier in an error message', () => {
    let message = ''
    try {
      loadOfflineIdentity(writeJson({...identityFile, capabilities: 'not-an-array'}), PROFILE, RESOURCE)
    } catch (caught) {
      message = (caught as Error).message
    }
    expect(message).not.toContain(TENANT)
  })
})

describe('loadOfflinePlan', () => {
  it('returns the verified plan for a well-formed file', () => {
    const plan = validPlan()

    expect(loadOfflinePlan(writeJson(plan), PROFILE, RESOURCE)).toEqual(plan)
  })

  it('reports FILE_UNREADABLE for a missing file', () => {
    expect(codeOf(() => loadOfflinePlan(join(directory, 'absent-plan.json'), PROFILE, RESOURCE))).toBe(
      'FILE_UNREADABLE',
    )
  })

  it('reports PLAN_INVALID when the payload was edited under the recorded digest', () => {
    const plan = validPlan()
    const tampered = {...plan, payload: {amount: '99.99', label: 'synthetic'}}

    expect(codeOf(() => loadOfflinePlan(writeJson(tampered), PROFILE, RESOURCE))).toBe('PLAN_INVALID')
  })

  it('reports PLAN_INVALID for a JSON object that is not a plan', () => {
    expect(codeOf(() => loadOfflinePlan(writeJson({planId: 'nope'}), PROFILE, RESOURCE))).toBe('PLAN_INVALID')
  })

  it.each([
    ['profile', 'other-profile', RESOURCE],
    ['resource', PROFILE, 'other-resource'],
  ])('reports TARGET_MISMATCH when the %s flag disagrees', (_label, profile, resource) => {
    expect(codeOf(() => loadOfflinePlan(writeJson(validPlan()), profile, resource))).toBe('TARGET_MISMATCH')
  })

  it('reports DATA_HYGIENE_REJECTED for a secret-shaped plan payload', () => {
    const plan = createMutationPlan({
      planId: 'synthetic-loader-secret-plan',
      profileName: PROFILE,
      resource: RESOURCE,
      operation: 'create',
      target: createTargetIdentity(identityFile),
      payload: {accessToken: SECRET},
      requiredCapabilities: ['ledger.synthetic.write'],
      requiredScopes: ['ledger.synthetic.scope'],
      readBack: {expected: {accessToken: SECRET}},
      createdAt: CREATED_AT,
      expiresAt: EXPIRES_AT,
    })

    let message = ''
    try {
      loadOfflinePlan(writeJson(plan), PROFILE, RESOURCE)
    } catch (caught) {
      expect((caught as OfflineTargetError).code).toBe('DATA_HYGIENE_REJECTED')
      message = (caught as Error).message
    }
    expect(message.startsWith('DATA_HYGIENE_REJECTED:')).toBe(true)
    expect(message).not.toContain(SECRET)
  })
})

describe('applyRequestFor', () => {
  it('derives the request from the verified plan', () => {
    const plan = validPlan()

    expect(applyRequestFor(plan)).toEqual({
      profileName: plan.profileName,
      resource: plan.resource,
      operation: plan.operation,
      payload: plan.payload,
      objectCount: 1,
      readBackExpectation: plan.readBackExpectation,
    })
  })
})

describe('loadPlanInput', () => {
  const source = {
    planId: 'synthetic-loader-input',
    operation: 'create',
    payload: {amount: '10.01'},
    requiredCapabilities: ['ledger.synthetic.write'],
    requiredScopes: ['ledger.synthetic.scope'],
  }

  it('validates a well-formed input file and defaults expected to the payload', () => {
    expect(loadPlanInput(writeJson(source))).toEqual({
      planId: 'synthetic-loader-input',
      operation: 'create',
      payload: {amount: '10.01'},
      expected: {amount: '10.01'},
      requiredCapabilities: ['ledger.synthetic.write'],
      requiredScopes: ['ledger.synthetic.scope'],
    })
  })

  it('passes through the optional timestamps unchanged', () => {
    const loaded = loadPlanInput(writeJson({...source, createdAt: CREATED_AT, expiresAt: EXPIRES_AT}))

    expect(loaded.createdAt).toBe(CREATED_AT)
    expect(loaded.expiresAt).toBe(EXPIRES_AT)
  })

  it('drops a non-string planId and non-numeric timestamps', () => {
    const loaded = loadPlanInput(writeJson({...source, planId: 7, createdAt: 'now', expiresAt: null}))

    expect(loaded.planId).toBeUndefined()
    expect(loaded.createdAt).toBeUndefined()
    expect(loaded.expiresAt).toBeUndefined()
  })

  it('reports FILE_UNREADABLE for a missing file', () => {
    expect(codeOf(() => loadPlanInput(join(directory, 'absent-input.json')))).toBe('FILE_UNREADABLE')
  })

  it.each([
    ['operation', {...source, operation: ''}],
    ['requiredCapabilities', {...source, requiredCapabilities: []}],
    ['requiredScopes', {...source, requiredScopes: [1]}],
  ])('reports PLAN_INVALID for a bad %s field', (_label, file) => {
    expect(codeOf(() => loadPlanInput(writeJson(file)))).toBe('PLAN_INVALID')
  })

  it.each([
    ['payload', {...source, payload: {accessToken: SECRET}}],
    ['expected', {...source, expected: {clientSecret: SECRET}}],
  ])('reports DATA_HYGIENE_REJECTED for a secret-shaped %s', (_label, file) => {
    let message = ''
    try {
      loadPlanInput(writeJson(file))
    } catch (caught) {
      expect((caught as OfflineTargetError).code).toBe('DATA_HYGIENE_REJECTED')
      message = (caught as Error).message
    }
    expect(message).not.toContain(SECRET)
  })
})
