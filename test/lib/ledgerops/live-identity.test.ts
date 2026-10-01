import {describe, expect, it, vi} from 'vitest'
import {
  LIVE_DEMO_PROFILE,
  LIVE_DEMO_RESOURCE,
  LIVE_IDENTITY_RECEIPT_SCHEMA,
  LiveIdentityFailure,
  stopLiveIdentity,
  verifyLiveDemoIdentity,
  type LiveIdentityObservation,
  type LiveIdentityTransport,
} from '../../../src/lib/ledgerops/live-identity.js'

const NOW = Date.parse('2026-08-08T00:00:00.000Z')
const TENANT_SENTINEL = 'synthetic-tenant-must-not-echo'
const ORGANISATION_SENTINEL = 'synthetic-organisation-must-not-echo'
const RAW_RESPONSE_SENTINEL = 'synthetic-raw-response-must-not-echo'
const ERROR_SENTINEL = 'synthetic-error-must-not-echo'
const TOKEN_SENTINEL = 'synthetic-token-must-not-echo'

function transportReturning(observation: unknown): LiveIdentityTransport {
  return {read: vi.fn(async () => observation as LiveIdentityObservation)}
}

function inputFor(transport: LiveIdentityTransport, overrides: Record<string, unknown> = {}) {
  return {
    profileName: LIVE_DEMO_PROFILE,
    resource: LIVE_DEMO_RESOURCE,
    liveDemo: true,
    expectDemoCompany: true,
    transport,
    clock: {now: () => NOW},
    ...overrides,
  }
}

function expectStop(value: unknown, reasonCode: string): void {
  expect(value).toEqual({
    schemaVersion: LIVE_IDENTITY_RECEIPT_SCHEMA,
    status: 'STOP',
    outcome: 'STOP',
    terminal: 'STOP',
    stop: true,
    code: 'LIVE_IDENTITY_STOP',
    reasonCode,
  })
}

describe('live Demo identity verification', () => {
  it('returns a deterministic allowlisted receipt without raw identity or response fields', async () => {
    const transport = transportReturning({
      tenantId: TENANT_SENTINEL,
      organisationId: TENANT_SENTINEL,
      isDemoCompany: true,
      capabilities: ['accounting.settings.read'],
      scopes: ['accounting.settings'],
      profileName: 'synthetic-profile-name',
      name: ORGANISATION_SENTINEL,
      shortCode: 'SYN',
      token: TOKEN_SENTINEL,
      rawResponse: RAW_RESPONSE_SENTINEL,
      error: ERROR_SENTINEL,
    })

    const result = await verifyLiveDemoIdentity(inputFor(transport))
    const serialized = JSON.stringify(result)

    expect(result).toEqual(
      expect.objectContaining({
        schemaVersion: LIVE_IDENTITY_RECEIPT_SCHEMA,
        profileName: LIVE_DEMO_PROFILE,
        resource: LIVE_DEMO_RESOURCE,
        isDemoCompany: true,
        observedAt: NOW,
        freshUntil: NOW + 5 * 60 * 1000,
        capabilitiesFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        scopesFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        targetFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    )
    expect(Object.keys(result).sort()).toEqual([
      'capabilitiesFingerprint',
      'freshUntil',
      'isDemoCompany',
      'observedAt',
      'profileName',
      'resource',
      'schemaVersion',
      'scopesFingerprint',
      'targetFingerprint',
    ])
    expect(serialized).not.toContain(TENANT_SENTINEL)
    expect(serialized).not.toContain(ORGANISATION_SENTINEL)
    expect(serialized).not.toContain(RAW_RESPONSE_SENTINEL)
    expect(serialized).not.toContain(ERROR_SENTINEL)
    expect(serialized).not.toContain(TOKEN_SENTINEL)
    expect(transport.read).toHaveBeenCalledTimes(1)
    expect(transport.read).toHaveBeenCalledWith({
      profileName: LIVE_DEMO_PROFILE,
      resource: LIVE_DEMO_RESOURCE,
      now: NOW,
    })
  })

  it.each([
    ['live flag', {liveDemo: false}, 'LIVE_FLAG_REQUIRED'],
    ['profile', {profileName: 'unexpected-profile'}, 'PROFILE_MISMATCH'],
    ['resource', {resource: 'unexpected-resource'}, 'RESOURCE_MISMATCH'],
    ['Demo expectation', {expectDemoCompany: false}, 'DEMO_EXPECTATION_REQUIRED'],
    ['offline input', {inputProvided: true}, 'INPUT_CONFLICT'],
  ])('stops before transport for an unexpected %s', async (_label, overrides, reasonCode) => {
    const transport = transportReturning({
      tenantId: TENANT_SENTINEL,
      organisationId: TENANT_SENTINEL,
      isDemoCompany: true,
    })

    const result = await verifyLiveDemoIdentity(inputFor(transport, overrides))

    expectStop(result, reasonCode)
    expect(transport.read).not.toHaveBeenCalled()
  })

  it.each([
    ['null observation', null],
    ['undefined observation', undefined],
    ['missing tenant', {organisationId: ORGANISATION_SENTINEL, isDemoCompany: true}],
    ['missing organisation', {tenantId: TENANT_SENTINEL, isDemoCompany: true}],
    ['empty tenant', {tenantId: '  ', organisationId: ORGANISATION_SENTINEL, isDemoCompany: true}],
    ['empty organisation', {tenantId: TENANT_SENTINEL, organisationId: '  ', isDemoCompany: true}],
    [
      'malformed capabilities',
      {
        tenantId: TENANT_SENTINEL,
        organisationId: ORGANISATION_SENTINEL,
        isDemoCompany: true,
        capabilities: [null],
      },
    ],
    [
      'malformed scopes',
      {
        tenantId: TENANT_SENTINEL,
        organisationId: ORGANISATION_SENTINEL,
        isDemoCompany: true,
        scopes: [''],
      },
    ],
  ])('stops on an %s', async (_label, observation) => {
    const result = await verifyLiveDemoIdentity(inputFor(transportReturning(observation)))

    expectStop(result, 'IDENTITY_INVALID')
  })

  it('stops for a non-Demo identity or mismatched tenant and organisation', async () => {
    const nonDemo = await verifyLiveDemoIdentity(
      inputFor(
        transportReturning({
          tenantId: TENANT_SENTINEL,
          organisationId: TENANT_SENTINEL,
          isDemoCompany: false,
        }),
      ),
    )
    const mismatch = await verifyLiveDemoIdentity(
      inputFor(
        transportReturning({
          tenantId: TENANT_SENTINEL,
          organisationId: ORGANISATION_SENTINEL,
          isDemoCompany: true,
        }),
      ),
    )

    expectStop(nonDemo, 'DEMO_COMPANY_REQUIRED')
    expectStop(mismatch, 'IDENTITY_MISMATCH')
  })

  it('returns structured STOP receipts for invalid transports, clocks, and failures without echoing errors', async () => {
    const invalidTransport = await verifyLiveDemoIdentity(inputFor(null as unknown as LiveIdentityTransport))
    const invalidClock = await verifyLiveDemoIdentity(
      inputFor(
        transportReturning({
          tenantId: TENANT_SENTINEL,
          organisationId: TENANT_SENTINEL,
          isDemoCompany: true,
        }),
        {clock: {now: () => Number.NaN}},
      ),
    )
    const apiFailure = await verifyLiveDemoIdentity(
      inputFor({
        read: vi.fn(async () => {
          throw new Error(ERROR_SENTINEL)
        }),
      }),
    )
    const typedFailure = await verifyLiveDemoIdentity(
      inputFor({
        read: vi.fn(async () => {
          throw new LiveIdentityFailure('AUTH_FAILED')
        }),
      }),
    )

    expectStop(invalidTransport, 'TRANSPORT_INVALID')
    expectStop(invalidClock, 'CLOCK_INVALID')
    expectStop(apiFailure, 'TRANSPORT_FAILED')
    expectStop(typedFailure, 'AUTH_FAILED')
    expect(JSON.stringify(apiFailure)).not.toContain(ERROR_SENTINEL)
  })

  it('keeps stopLiveIdentity itself to the structured allowlist', () => {
    expect(stopLiveIdentity('TOKEN_DECRYPT_FAILED')).toEqual({
      schemaVersion: LIVE_IDENTITY_RECEIPT_SCHEMA,
      status: 'STOP',
      outcome: 'STOP',
      terminal: 'STOP',
      stop: true,
      code: 'LIVE_IDENTITY_STOP',
      reasonCode: 'TOKEN_DECRYPT_FAILED',
    })
  })
})
