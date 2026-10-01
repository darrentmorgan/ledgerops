import {chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {getConfigDir} from './config-paths.js'
import {decrypt, EncryptionKeyError, encrypt, getOrCreateKey} from './crypto.js'
import {getProfileClientId} from './profiles.js'

export interface TokenEntry {
  accessToken: string
  refreshToken: string
  expiresAt: number // Unix timestamp in ms
  tenantId: string
  tenantName?: string
}

interface EncryptedTokenEntry {
  clientId: string
  accessToken: string // encrypted
  refreshToken: string // encrypted
  expiresAt: number
  tenantId: string
  tenantName?: string
}

interface TokenCache {
  [profileName: string]: EncryptedTokenEntry
}

function tokenPath(): string {
  return join(getConfigDir(), 'tokens.json')
}

const TOKEN_BUFFER_MS = 60_000 // Refresh 60s before expiry

function ensureConfigDir(): void {
  const dir = dirname(tokenPath())
  if (!existsSync(dir)) {
    mkdirSync(dir, {recursive: true, mode: 0o700})
  }
  chmodSync(dir, 0o700)
}

function readTokenCache(): TokenCache {
  ensureConfigDir()
  if (!existsSync(tokenPath())) {
    return {}
  }
  chmodSync(tokenPath(), 0o600)
  try {
    return JSON.parse(readFileSync(tokenPath(), 'utf-8')) as TokenCache
  } catch {
    return {}
  }
}

function writeTokenCache(cache: TokenCache): void {
  ensureConfigDir()
  if (existsSync(tokenPath())) chmodSync(tokenPath(), 0o600)
  writeFileSync(tokenPath(), JSON.stringify(cache, null, 2), {mode: 0o600})
}

export async function getCachedTokenSet(profileName: string, clientId?: string): Promise<TokenEntry | null> {
  const cache = readTokenCache()
  const entry = cache[profileName]
  if (!entry) return null
  const expectedClientId = clientId ?? getProfileClientId(profileName)
  if (!entry.clientId || entry.clientId !== expectedClientId) return null

  try {
    const key = await getOrCreateKey()
    return {
      accessToken: decrypt(entry.accessToken, key),
      refreshToken: decrypt(entry.refreshToken, key),
      expiresAt: entry.expiresAt,
      tenantId: entry.tenantId,
      tenantName: entry.tenantName,
    }
  } catch (error) {
    if (error instanceof EncryptionKeyError) throw error
    throw new EncryptionKeyError('Could not decrypt cached tokens. Run "ledgerops login" to re-authenticate.')
  }
}

export function isTokenExpired(entry: TokenEntry): boolean {
  return Date.now() >= entry.expiresAt - TOKEN_BUFFER_MS
}

export async function cacheTokenSet(
  profileName: string,
  tokenSet: {access_token?: string; refresh_token?: string; expires_in?: number; expires_at?: number},
  tenantId: string,
  tenantName?: string,
  clientId?: string,
): Promise<void> {
  const accessToken = tokenSet.access_token
  const refreshToken = tokenSet.refresh_token
  if (!accessToken || !refreshToken) return

  let expiresAt: number
  if (tokenSet.expires_at) {
    // expires_at is in seconds since epoch
    expiresAt = tokenSet.expires_at * 1000
  } else if (tokenSet.expires_in) {
    expiresAt = Date.now() + tokenSet.expires_in * 1000
  } else {
    // Default 30 min
    expiresAt = Date.now() + 1800 * 1000
  }

  const boundClientId = clientId ?? getProfileClientId(profileName)
  if (!boundClientId) throw new Error('An OAuth client ID is required to cache tokens.')
  const key = await getOrCreateKey()
  const cache = readTokenCache()
  cache[profileName] = {
    clientId: boundClientId,
    accessToken: encrypt(accessToken, key),
    refreshToken: encrypt(refreshToken, key),
    expiresAt,
    tenantId,
    tenantName,
  }
  writeTokenCache(cache)
}

export function clearCachedToken(profileName: string): void {
  const cache = readTokenCache()
  delete cache[profileName]
  writeTokenCache(cache)
}
