import {existsSync} from 'node:fs'
import {join} from 'node:path'
import {getCachedTokenSet} from '../auth.js'
import {EncryptionKeyError} from '../crypto.js'
import {getConfigDir} from '../config-paths.js'
import {getProfileClientId} from '../profiles.js'

const TOKEN_SAFETY_WINDOW_MS = 60_000

/**
 * Credential resolution shared by the live adapters (read and DRAFT
 * dispatch). Both sit behind the ADR-0003 seam: credentials are resolved
 * inside the adapter, bound to one profile and one tenant, and never cross
 * back. The seam checks themselves (binding, resource, payload) stay in each
 * adapter — only the token plumbing is common.
 */
export type XeroLiveSessionFailureCode =
  | 'CONFIG_MISSING'
  | 'TOKEN_MISSING'
  | 'TOKEN_DECRYPT_FAILED'
  | 'TOKEN_INVALID'
  | 'TOKEN_NEAR_EXPIRY'
  | 'TENANT_MISMATCH'
  | 'AUTH_FAILED'

/** Internal typed boundary; its message is a reason code, never provider output. */
export class XeroLiveSessionFailure extends Error {
  readonly reasonCode: XeroLiveSessionFailureCode

  constructor(reasonCode: XeroLiveSessionFailureCode) {
    super(reasonCode)
    this.name = 'XeroLiveSessionFailure'
    this.reasonCode = reasonCode
  }
}

export interface XeroLiveToken {
  readonly accessToken: string
  readonly expiresAt: number
  readonly tenantId: string
}

export interface XeroLiveSessionDependencies<TClient> {
  readonly fileExists?: (path: string) => boolean
  readonly readClientId?: (profileName: string) => string | Promise<string>
  readonly readTokenSet?: (profileName: string) => XeroLiveToken | null | Promise<XeroLiveToken | null>
  readonly createClient?: (clientId: string) => TClient
  readonly now?: () => number
}

export interface XeroLiveSessionInput<TClient> {
  readonly profileName: string
  readonly tenantId: string
  readonly dependencies: XeroLiveSessionDependencies<TClient>
  readonly createDefaultClient: (clientId: string) => TClient
}

/**
 * Resolve an authenticated SDK client for exactly one profile and tenant, or
 * throw a typed failure. The tenant check is load-bearing: a cached token for
 * some other organisation must never authenticate a call the caller described
 * against this one.
 */
export async function resolveLiveClient<TClient extends {setTokenSet(tokenSet: {access_token: string}): void}>(
  input: XeroLiveSessionInput<TClient>,
): Promise<TClient> {
  const dependencies = input.dependencies
  const fileExists = dependencies.fileExists ?? existsSync
  const readClientId = dependencies.readClientId ?? getProfileClientId
  const readTokenSet = dependencies.readTokenSet ?? getCachedTokenSet
  const createClient = dependencies.createClient ?? input.createDefaultClient
  const now = dependencies.now ?? Date.now

  if (!fileExists(join(getConfigDir(), 'config.json'))) throw new XeroLiveSessionFailure('CONFIG_MISSING')
  if (!fileExists(join(getConfigDir(), 'tokens.json'))) throw new XeroLiveSessionFailure('TOKEN_MISSING')

  let clientId: string
  try {
    clientId = await readClientId(input.profileName)
  } catch {
    throw new XeroLiveSessionFailure('AUTH_FAILED')
  }
  if (typeof clientId !== 'string' || clientId.trim() === '') {
    throw new XeroLiveSessionFailure('AUTH_FAILED')
  }

  let token: XeroLiveToken | null
  try {
    token = await readTokenSet(input.profileName)
  } catch (error) {
    if (error instanceof EncryptionKeyError) throw new XeroLiveSessionFailure('TOKEN_DECRYPT_FAILED')
    throw new XeroLiveSessionFailure('AUTH_FAILED')
  }
  if (!token) throw new XeroLiveSessionFailure('TOKEN_MISSING')
  if (typeof token.accessToken !== 'string' || token.accessToken.trim() === '') {
    throw new XeroLiveSessionFailure('TOKEN_INVALID')
  }
  if (!Number.isFinite(token.expiresAt) || typeof token.tenantId !== 'string' || token.tenantId.trim() === '') {
    throw new XeroLiveSessionFailure('TOKEN_INVALID')
  }
  if (token.tenantId !== input.tenantId) throw new XeroLiveSessionFailure('TENANT_MISMATCH')
  if (now() >= token.expiresAt - TOKEN_SAFETY_WINDOW_MS) {
    throw new XeroLiveSessionFailure('TOKEN_NEAR_EXPIRY')
  }

  let client: TClient
  try {
    client = createClient(clientId)
    client.setTokenSet({access_token: token.accessToken})
  } catch {
    throw new XeroLiveSessionFailure('AUTH_FAILED')
  }
  return client
}
