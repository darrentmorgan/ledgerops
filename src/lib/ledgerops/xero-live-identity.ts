import {existsSync} from 'node:fs'
import {join} from 'node:path'
import {XeroClient} from 'xero-node'
import {getCachedTokenSet} from '../auth.js'
import {EncryptionKeyError} from '../crypto.js'
import {getConfigDir} from '../config-paths.js'
import {getProfileClientId} from '../profiles.js'
import {
  LIVE_DEMO_PROFILE,
  LIVE_DEMO_RESOURCE,
  LiveIdentityFailure,
  type LiveIdentityObservation,
  type LiveIdentityTransport,
  type LiveIdentityTransportRequest,
} from './live-identity.js'

const TOKEN_SAFETY_WINDOW_MS = 60_000

export interface XeroLiveIdentityToken {
  readonly accessToken: string
  readonly expiresAt: number
  readonly tenantId: string
}

export interface XeroLiveIdentityClient {
  setTokenSet(tokenSet: {access_token: string}): void
  updateTenants(fullOrgDetails?: boolean): Promise<readonly unknown[]>
  readonly accountingApi: {
    getOrganisations(tenantId: string): Promise<unknown>
  }
}

export interface XeroLiveIdentityDependencies {
  readonly fileExists?: (path: string) => boolean
  readonly readClientId?: (profileName: string) => string | Promise<string>
  readonly readTokenSet?: (profileName: string) => XeroLiveIdentityToken | null | Promise<XeroLiveIdentityToken | null>
  readonly createClient?: (clientId: string) => XeroLiveIdentityClient
}

/** Build the one-shot, read-only Xero identity transport. */
export function createXeroLiveIdentityTransport(
  dependencies: XeroLiveIdentityDependencies = {},
): LiveIdentityTransport {
  const fileExists = dependencies.fileExists ?? existsSync
  const readClientId = dependencies.readClientId ?? getProfileClientId
  const readTokenSet = dependencies.readTokenSet ?? getCachedTokenSet
  const createClient = dependencies.createClient ?? ((clientId: string) => new XeroClient({clientId, clientSecret: ''}))

  return {
    async read(input: LiveIdentityTransportRequest): Promise<LiveIdentityObservation> {
      if (input.profileName !== LIVE_DEMO_PROFILE) throw new LiveIdentityFailure('PROFILE_MISMATCH')
      if (input.resource !== LIVE_DEMO_RESOURCE) throw new LiveIdentityFailure('RESOURCE_MISMATCH')

      if (!fileExists(join(getConfigDir(), 'config.json'))) throw new LiveIdentityFailure('CONFIG_MISSING')
      if (!fileExists(join(getConfigDir(), 'tokens.json'))) throw new LiveIdentityFailure('TOKEN_MISSING')

      let clientId: string
      try {
        clientId = await readClientId(input.profileName)
      } catch {
        throw new LiveIdentityFailure('AUTH_FAILED')
      }
      if (typeof clientId !== 'string' || clientId.trim() === '') {
        throw new LiveIdentityFailure('AUTH_FAILED')
      }

      let token: XeroLiveIdentityToken | null
      try {
        token = await readTokenSet(input.profileName)
      } catch (error) {
        if (error instanceof EncryptionKeyError) throw new LiveIdentityFailure('TOKEN_DECRYPT_FAILED')
        throw new LiveIdentityFailure('AUTH_FAILED')
      }
      if (!token) throw new LiveIdentityFailure('TOKEN_MISSING')
      if (typeof token.accessToken !== 'string' || token.accessToken.trim() === '') {
        throw new LiveIdentityFailure('TOKEN_INVALID')
      }
      if (!Number.isFinite(token.expiresAt) || typeof token.tenantId !== 'string' || token.tenantId.trim() === '') {
        throw new LiveIdentityFailure('TOKEN_INVALID')
      }
      if (input.now >= token.expiresAt - TOKEN_SAFETY_WINDOW_MS) {
        throw new LiveIdentityFailure('TOKEN_NEAR_EXPIRY')
      }

      let xero: XeroLiveIdentityClient
      try {
        xero = createClient(clientId)
        xero.setTokenSet({access_token: token.accessToken})
      } catch {
        throw new LiveIdentityFailure('AUTH_FAILED')
      }

      let connections: readonly unknown[]
      try {
        connections = await xero.updateTenants(false)
      } catch {
        throw new LiveIdentityFailure('AUTH_FAILED')
      }
      if (!Array.isArray(connections) || connections.length !== 1) {
        throw new LiveIdentityFailure('CONNECTION_COUNT')
      }

      const connection = connections[0]
      const tenantId = readStringField(connection, 'tenantId')
      if (!tenantId) throw new LiveIdentityFailure('CONNECTION_COUNT')
      if (tenantId !== token.tenantId) throw new LiveIdentityFailure('IDENTITY_MISMATCH')

      let response: unknown
      try {
        response = await xero.accountingApi.getOrganisations(tenantId)
      } catch {
        throw new LiveIdentityFailure('AUTH_FAILED')
      }
      const organisations = readOrganisations(response)
      if (organisations.length !== 1) throw new LiveIdentityFailure('ORGANISATION_COUNT')

      const organisation = organisations[0]
      const organisationId = readStringField(organisation, 'organisationID')
      if (!organisationId) throw new LiveIdentityFailure('ORGANISATION_COUNT')
      if (organisationId !== tenantId) throw new LiveIdentityFailure('IDENTITY_MISMATCH')
      if (readBooleanField(organisation, 'isDemoCompany') !== true) {
        throw new LiveIdentityFailure('DEMO_COMPANY_REQUIRED')
      }

      return {
        tenantId,
        organisationId,
        isDemoCompany: true,
      }
    },
  }
}

function readOrganisations(value: unknown): readonly unknown[] {
  if (!value || typeof value !== 'object') return []
  const body = (value as Record<string, unknown>).body
  if (!body || typeof body !== 'object') return []
  const organisations = (body as Record<string, unknown>).organisations
  return Array.isArray(organisations) ? organisations : []
}

function readStringField(value: unknown, field: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const fieldValue = (value as Record<string, unknown>)[field]
  return typeof fieldValue === 'string' && fieldValue.trim() !== '' ? fieldValue : undefined
}

function readBooleanField(value: unknown, field: string): boolean | undefined {
  if (!value || typeof value !== 'object') return undefined
  const fieldValue = (value as Record<string, unknown>)[field]
  return typeof fieldValue === 'boolean' ? fieldValue : undefined
}
