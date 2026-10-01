import {describe, expect, it, vi} from 'vitest'
import {EncryptionKeyError} from '../../../src/lib/crypto.js'
import {
  LIVE_DEMO_PROFILE,
  LIVE_DEMO_RESOURCE,
  LiveIdentityFailure,
  type LiveIdentityTransport,
} from '../../../src/lib/ledgerops/live-identity.js'
import {
  createXeroLiveIdentityTransport,
  type XeroLiveIdentityClient,
  type XeroLiveIdentityToken,
} from '../../../src/lib/ledgerops/xero-live-identity.js'

const NOW = Date.parse('2026-08-08T00:00:00.000Z')
const CLIENT_ID = 'synthetic-client-id'
const ACCESS_TOKEN = 'synthetic-access-token-must-not-echo'
const TENANT = 'synthetic-tenant-id'
const ORGANISATION = 'synthetic-organisation-id'
const RAW_RESPONSE = 'synthetic-xero-raw-response-must-not-echo'
const API_ERROR = 'synthetic-api-error-must-not-echo'

interface HarnessOptions {
  readonly configPresent?: boolean
  readonly tokenFilePresent?: boolean
  readonly clientId?: string
  readonly clientIdError?: Error
  readonly token?: XeroLiveIdentityToken | null
  readonly tokenError?: Error
  readonly setTokenError?: Error
  readonly connections?: unknown
  readonly connectionsError?: Error
  readonly organisationsResponse?: unknown
  readonly organisationsError?: Error
}

function makeHarness(options: HarnessOptions = {}): {
  transport: LiveIdentityTransport
  fileExists: ReturnType<typeof vi.fn>
  readClientId: ReturnType<typeof vi.fn>
  readTokenSet: ReturnType<typeof vi.fn>
  createClient: ReturnType<typeof vi.fn>
  setTokenSet: ReturnType<typeof vi.fn>
  updateTenants: ReturnType<typeof vi.fn>
  getOrganisations: ReturnType<typeof vi.fn>
  forbidden: Record<string, ReturnType<typeof vi.fn>>
} {
  const fileExists = vi.fn((path: string) =>
    path.endsWith('config.json') ? (options.configPresent ?? true) : (options.tokenFilePresent ?? true),
  )
  const readClientId = vi.fn(async () => {
    if (options.clientIdError) throw options.clientIdError
    return options.clientId ?? CLIENT_ID
  })
  const readTokenSet = vi.fn(async () => {
    if (options.tokenError) throw options.tokenError
    return options.token === undefined
      ? {accessToken: ACCESS_TOKEN, expiresAt: NOW + 120_000, tenantId: TENANT}
      : options.token
  })
  const setTokenSet = vi.fn(() => {
    if (options.setTokenError) throw options.setTokenError
  })
  const updateTenants = vi.fn(async () => {
    if (options.connectionsError) throw options.connectionsError
    return (options.connections ?? [{tenantId: TENANT}]) as readonly unknown[]
  })
  const getOrganisations = vi.fn(async () => {
    if (options.organisationsError) throw options.organisationsError
    return options.organisationsResponse === undefined
      ? {body: {organisations: [{organisationID: ORGANISATION, isDemoCompany: true}]}}
      : options.organisationsResponse
  })
  const forbidden = Object.fromEntries(
    ['refreshTokenSet', 'retry', 'cacheTokenSet', 'clearTokenSet', 'login', 'writeProfile'].map(name => [
      name,
      vi.fn(),
    ]),
  ) as Record<string, ReturnType<typeof vi.fn>>
  const client = {
    setTokenSet,
    updateTenants,
    accountingApi: {getOrganisations},
    ...forbidden,
  } as unknown as XeroLiveIdentityClient
  const createClient = vi.fn(() => client)
  const transport = createXeroLiveIdentityTransport({
    fileExists,
    readClientId,
    readTokenSet,
    createClient,
  })

  return {
    transport,
    fileExists,
    readClientId,
    readTokenSet,
    createClient,
    setTokenSet,
    updateTenants,
    getOrganisations,
    forbidden,
  }
}

async function reasonOf(
  transport: LiveIdentityTransport,
  resource = LIVE_DEMO_RESOURCE,
  profileName: typeof LIVE_DEMO_PROFILE = LIVE_DEMO_PROFILE,
): Promise<string> {
  try {
    await transport.read({profileName, resource: resource as typeof LIVE_DEMO_RESOURCE, now: NOW})
    return 'NO_FAILURE'
  } catch (error) {
    if (error instanceof LiveIdentityFailure) return error.reasonCode
    return String(error)
  }
}

describe('Xero live identity transport', () => {
  it('uses injected read seams and exactly one connection and organisation call on success', async () => {
    const harness = makeHarness({
      organisationsResponse: {
        body: {
          organisations: [
            {
              organisationID: TENANT,
              isDemoCompany: true,
              name: ORGANISATION,
              shortCode: ORGANISATION,
              rawResponse: RAW_RESPONSE,
              error: API_ERROR,
              token: ACCESS_TOKEN,
            },
          ],
        },
      },
    })

    const observation = await harness.transport.read({
      profileName: LIVE_DEMO_PROFILE,
      resource: LIVE_DEMO_RESOURCE,
      now: NOW,
    })

    expect(observation).toEqual({tenantId: TENANT, organisationId: TENANT, isDemoCompany: true})
    expect(Object.keys(observation)).toEqual(['tenantId', 'organisationId', 'isDemoCompany'])
    expect(harness.fileExists).toHaveBeenCalledTimes(2)
    expect(harness.readClientId).toHaveBeenCalledTimes(1)
    expect(harness.readClientId).toHaveBeenCalledWith(LIVE_DEMO_PROFILE)
    expect(harness.readTokenSet).toHaveBeenCalledTimes(1)
    expect(harness.readTokenSet).toHaveBeenCalledWith(LIVE_DEMO_PROFILE)
    expect(harness.createClient).toHaveBeenCalledTimes(1)
    expect(harness.createClient).toHaveBeenCalledWith(CLIENT_ID)
    expect(harness.setTokenSet).toHaveBeenCalledTimes(1)
    expect(harness.setTokenSet).toHaveBeenCalledWith({access_token: ACCESS_TOKEN})
    expect(harness.updateTenants).toHaveBeenCalledTimes(1)
    expect(harness.updateTenants).toHaveBeenCalledWith(false)
    expect(harness.getOrganisations).toHaveBeenCalledTimes(1)
    expect(harness.getOrganisations).toHaveBeenCalledWith(TENANT)
    for (const method of Object.values(harness.forbidden)) expect(method).not.toHaveBeenCalled()
  })

  it('rejects a non-demo-au profile before any dependency access', async () => {
    const harness = makeHarness()

    expect(await reasonOf(harness.transport, LIVE_DEMO_RESOURCE, 'other-profile' as typeof LIVE_DEMO_PROFILE)).toBe(
      'PROFILE_MISMATCH',
    )
    for (const dependency of [
      harness.fileExists,
      harness.readClientId,
      harness.readTokenSet,
      harness.createClient,
      harness.setTokenSet,
      harness.updateTenants,
      harness.getOrganisations,
      ...Object.values(harness.forbidden),
    ])
      expect(dependency).not.toHaveBeenCalled()
  })

  it('rejects an unexpected resource before any config, token, or client access', async () => {
    const harness = makeHarness()

    const reason = await reasonOf(harness.transport, 'unexpected-resource')

    expect(reason).toBe('RESOURCE_MISMATCH')
    expect(harness.fileExists).not.toHaveBeenCalled()
    expect(harness.readClientId).not.toHaveBeenCalled()
    expect(harness.readTokenSet).not.toHaveBeenCalled()
    expect(harness.createClient).not.toHaveBeenCalled()
  })

  it.each([
    ['missing config', {configPresent: false}, 'CONFIG_MISSING'],
    ['missing token file', {tokenFilePresent: false}, 'TOKEN_MISSING'],
    ['empty cached token', {token: null}, 'TOKEN_MISSING'],
    ['expired token', {token: {accessToken: ACCESS_TOKEN, expiresAt: NOW - 1, tenantId: TENANT}}, 'TOKEN_NEAR_EXPIRY'],
    [
      'near-expiry token',
      {token: {accessToken: ACCESS_TOKEN, expiresAt: NOW + 60_000, tenantId: TENANT}},
      'TOKEN_NEAR_EXPIRY',
    ],
    ['missing access token', {token: {accessToken: ' ', expiresAt: NOW + 120_000, tenantId: TENANT}}, 'TOKEN_INVALID'],
    ['invalid expiry', {token: {accessToken: ACCESS_TOKEN, expiresAt: Number.NaN, tenantId: TENANT}}, 'TOKEN_INVALID'],
    [
      'missing token tenant',
      {token: {accessToken: ACCESS_TOKEN, expiresAt: NOW + 120_000, tenantId: ''}},
      'TOKEN_INVALID',
    ],
    ['decrypt failure', {tokenError: new EncryptionKeyError(API_ERROR)}, 'TOKEN_DECRYPT_FAILED'],
    ['client-id failure', {clientIdError: new Error(API_ERROR)}, 'AUTH_FAILED'],
    ['blank client-id', {clientId: ' '}, 'AUTH_FAILED'],
    ['client construction failure', {connectionsError: undefined, setTokenError: new Error(API_ERROR)}, 'AUTH_FAILED'],
    ['connection API failure', {connectionsError: new Error(API_ERROR)}, 'AUTH_FAILED'],
    ['organisation API failure', {organisationsError: new Error(API_ERROR)}, 'AUTH_FAILED'],
  ])('returns only %s without echoing token or error details', async (_label, options, reasonCode) => {
    const harness = makeHarness(options)
    const reason = await reasonOf(harness.transport)

    expect(reason).toBe(reasonCode)
    expect(reason).not.toContain(API_ERROR)
    expect(reason).not.toContain(ACCESS_TOKEN)
  })

  it.each([
    ['zero connections', [], 'CONNECTION_COUNT'],
    ['multiple connections', [{tenantId: TENANT}, {tenantId: 'other-tenant'}], 'CONNECTION_COUNT'],
    ['null connection', [null], 'CONNECTION_COUNT'],
    ['malformed connection', [{tenant: TENANT}], 'CONNECTION_COUNT'],
    ['mismatched connection tenant', [{tenantId: 'other-tenant'}], 'IDENTITY_MISMATCH'],
  ])('stops for %s', async (_label, connections, reasonCode) => {
    const harness = makeHarness({connections})

    expect(await reasonOf(harness.transport)).toBe(reasonCode)
    expect(harness.updateTenants).toHaveBeenCalledTimes(1)
    expect(harness.getOrganisations).not.toHaveBeenCalled()
  })

  it.each([
    ['null response', null],
    ['missing body', {}],
    ['null body', {body: null}],
    ['missing organisations', {body: {}}],
    ['null organisations', {body: {organisations: null}}],
    ['zero organisations', {body: {organisations: []}}],
    [
      'multiple organisations',
      {
        body: {
          organisations: [
            {organisationID: TENANT, isDemoCompany: true},
            {organisationID: TENANT, isDemoCompany: true},
          ],
        },
      },
    ],
    ['null organisation', {body: {organisations: [null]}}],
    ['malformed organisation', {body: {organisations: [{name: 'Synthetic Demo'}]}}],
    ['missing organisation id', {body: {organisations: [{isDemoCompany: true}]}}],
  ])('stops for %s', async (_label, organisationsResponse) => {
    const harness = makeHarness({organisationsResponse})

    expect(await reasonOf(harness.transport)).toBe('ORGANISATION_COUNT')
    expect(harness.getOrganisations).toHaveBeenCalledTimes(1)
  })

  it('stops for a mismatched organisation id or a non-Demo organisation', async () => {
    const mismatched = makeHarness({
      organisationsResponse: {body: {organisations: [{organisationID: 'other-org', isDemoCompany: true}]}},
    })
    const nonDemo = makeHarness({
      organisationsResponse: {body: {organisations: [{organisationID: TENANT, isDemoCompany: false}]}},
    })

    expect(await reasonOf(mismatched.transport)).toBe('IDENTITY_MISMATCH')
    expect(await reasonOf(nonDemo.transport)).toBe('DEMO_COMPANY_REQUIRED')
  })

  it('does not require or return organisation name, shortCode, or the raw response', async () => {
    const harness = makeHarness({
      organisationsResponse: {body: {organisations: [{organisationID: TENANT, isDemoCompany: true}]}},
    })

    const observation = await harness.transport.read({
      profileName: LIVE_DEMO_PROFILE,
      resource: LIVE_DEMO_RESOURCE,
      now: NOW,
    })
    const serialized = JSON.stringify(observation)

    expect(serialized).not.toContain('name')
    expect(serialized).not.toContain('shortCode')
    expect(serialized).not.toContain('body')
    expect(serialized).not.toContain(RAW_RESPONSE)
    expect(serialized).not.toContain(API_ERROR)
    expect(serialized).not.toContain(ACCESS_TOKEN)
    expect(serialized).toContain(TENANT)
  })
})
