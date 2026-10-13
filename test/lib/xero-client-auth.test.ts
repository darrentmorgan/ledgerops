import {beforeEach, describe, expect, it, vi} from 'vitest'
import type {XeroClient} from 'xero-node'

const auth = vi.hoisted(() => ({
  getCachedTokenSet: vi.fn(),
  isTokenExpired: vi.fn(),
  cacheTokenSet: vi.fn(),
  clearCachedToken: vi.fn(),
  refreshAccessToken: vi.fn(),
  setTokenSet: vi.fn(),
  construct: vi.fn(),
}))

vi.mock('../../src/lib/auth.js', () => auth)
vi.mock('../../src/lib/oauth.js', () => ({refreshAccessToken: auth.refreshAccessToken}))
vi.mock('xero-node', () => ({
  XeroClient: class {
    accountingApi = {defaultHeaders: {'synthetic-existing-header': 'preserved'}}
    setTokenSet = auth.setTokenSet
    constructor(options: unknown) {
      auth.construct(options)
    }
  },
}))

const {createXeroClient, withRetry, withSingleAttempt} = await import('../../src/lib/xero-client.js')
const {EncryptionKeyError} = await import('../../src/lib/crypto.js')

const PROFILE = 'synthetic-profile'
const CLIENT = 'synthetic-client'
const cached = {
  accessToken: 'synthetic-access',
  refreshToken: 'synthetic-refresh',
  tenantId: 'synthetic-tenant',
  tenantName: 'Synthetic Organisation',
}
const refreshed = {access_token: 'synthetic-refreshed-access', refresh_token: 'synthetic-rotated-refresh'}
const unauthorized = () => new Error(JSON.stringify({response: {statusCode: 401}}))

beforeEach(() => {
  vi.resetAllMocks()
  auth.getCachedTokenSet.mockResolvedValue({...cached})
  auth.isTokenExpired.mockReturnValue(false)
  auth.refreshAccessToken.mockResolvedValue({...refreshed})
})

describe('Xero client authentication boundary', () => {
  it('refuses an absent client-bound cache before constructing a client', async () => {
    auth.getCachedTokenSet.mockResolvedValue(null)
    await expect(createXeroClient(PROFILE, CLIENT)).rejects.toThrow('Not logged in')
    expect(auth.getCachedTokenSet).toHaveBeenCalledExactlyOnceWith(PROFILE, CLIENT)
    expect(auth.refreshAccessToken).not.toHaveBeenCalled()
    expect(auth.construct).not.toHaveBeenCalled()
  })

  it('uses an unexpired token without refreshing and preserves existing API headers', async () => {
    const result = await createXeroClient(PROFILE, CLIENT)
    expect(result.tenantId).toBe(cached.tenantId)
    expect(auth.setTokenSet).toHaveBeenCalledExactlyOnceWith({access_token: cached.accessToken})
    expect(result.xero.accountingApi.defaultHeaders).toMatchObject({'synthetic-existing-header': 'preserved'})
    expect(auth.refreshAccessToken).not.toHaveBeenCalled()
    expect(auth.cacheTokenSet).not.toHaveBeenCalled()
  })

  it('persists rotated tokens with the same profile, client and organisation before using them', async () => {
    auth.isTokenExpired.mockReturnValue(true)
    const result = await createXeroClient(PROFILE, CLIENT)
    expect(auth.refreshAccessToken).toHaveBeenCalledExactlyOnceWith(CLIENT, cached.refreshToken)
    expect(auth.cacheTokenSet).toHaveBeenCalledExactlyOnceWith(
      PROFILE,
      refreshed,
      cached.tenantId,
      cached.tenantName,
      CLIENT,
    )
    expect(auth.setTokenSet).toHaveBeenCalledExactlyOnceWith({access_token: refreshed.access_token})
    expect(auth.cacheTokenSet.mock.invocationCallOrder[0]).toBeLessThan(auth.setTokenSet.mock.invocationCallOrder[0])
    expect(result.tenantId).toBe(cached.tenantId)
    expect(auth.clearCachedToken).not.toHaveBeenCalled()
  })

  it.each(['refresh', 'cache'])('fails closed when expired-token %s fails', async stage => {
    auth.isTokenExpired.mockReturnValue(true)
    auth[stage === 'refresh' ? 'refreshAccessToken' : 'cacheTokenSet'].mockRejectedValue(
      new Error('synthetic-sensitive-provider-detail'),
    )
    await expect(createXeroClient(PROFILE, CLIENT)).rejects.toThrow(
      'Session expired. Run "ledgerops login" to re-authenticate.',
    )
    expect(auth.clearCachedToken).toHaveBeenCalledExactlyOnceWith(PROFILE)
    expect(auth.construct).not.toHaveBeenCalled()
    expect(auth.setTokenSet).not.toHaveBeenCalled()
  })

  it('preserves the cache when reading it raises an encryption-key error', async () => {
    const error = new EncryptionKeyError('synthetic key unavailable')
    auth.getCachedTokenSet.mockRejectedValue(error)
    await expect(createXeroClient(PROFILE, CLIENT)).rejects.toBe(error)
    expect(auth.clearCachedToken).not.toHaveBeenCalled()
    expect(auth.construct).not.toHaveBeenCalled()
  })
})

describe('read retries versus mutation attempts', () => {
  const client = {xero: {} as XeroClient, tenantId: cached.tenantId}

  it('refreshes after a read 401 and rebuilds the client before retrying the read', async () => {
    const createClient = vi.fn().mockResolvedValue(client)
    const operation = vi.fn().mockRejectedValueOnce(unauthorized()).mockResolvedValueOnce('read-result')
    await expect(withRetry(PROFILE, CLIENT, operation, 2, {createClient})).resolves.toBe('read-result')
    expect(createClient).toHaveBeenCalledTimes(2)
    expect(createClient).toHaveBeenNthCalledWith(2, PROFILE, CLIENT)
    expect(operation).toHaveBeenCalledTimes(2)
    expect(operation).toHaveBeenLastCalledWith(client.xero, cached.tenantId)
    expect(auth.cacheTokenSet).toHaveBeenCalledExactlyOnceWith(
      PROFILE,
      refreshed,
      cached.tenantId,
      cached.tenantName,
      CLIENT,
    )
    expect(auth.cacheTokenSet.mock.invocationCallOrder[0]).toBeLessThan(createClient.mock.invocationCallOrder[1])
  })

  it('bounds persistent read 401s and does not refresh after the final attempt', async () => {
    const createClient = vi.fn().mockResolvedValue(client)
    const operation = vi.fn().mockRejectedValue(unauthorized())
    await expect(withRetry(PROFILE, CLIENT, operation, 2, {createClient})).rejects.toThrow('Xero API error (401)')
    expect(operation).toHaveBeenCalledTimes(3)
    expect(createClient).toHaveBeenCalledTimes(3)
    expect(auth.refreshAccessToken).toHaveBeenCalledTimes(2)
  })

  it('stops read retries and clears only the selected profile when refresh fails', async () => {
    auth.refreshAccessToken.mockRejectedValue(new Error('synthetic-sensitive-provider-detail'))
    const createClient = vi.fn().mockResolvedValue(client)
    const operation = vi.fn().mockRejectedValue(unauthorized())
    await expect(withRetry(PROFILE, CLIENT, operation, 2, {createClient})).rejects.toThrow('Session expired')
    expect(operation).toHaveBeenCalledOnce()
    expect(createClient).toHaveBeenCalledOnce()
    expect(auth.clearCachedToken).toHaveBeenCalledExactlyOnceWith(PROFILE)
  })

  it('never refreshes or replays a mutation after its dispatch returns 401', async () => {
    const createClient = vi.fn().mockResolvedValue(client)
    const operation = vi.fn().mockRejectedValue(unauthorized())
    await expect(withSingleAttempt(PROFILE, CLIENT, operation, {createClient})).rejects.toThrow('Session expired')
    expect(operation).toHaveBeenCalledExactlyOnceWith(client.xero, cached.tenantId)
    expect(createClient).toHaveBeenCalledExactlyOnceWith(PROFILE, CLIENT)
    expect(auth.refreshAccessToken).not.toHaveBeenCalled()
    expect(auth.clearCachedToken).not.toHaveBeenCalled()
  })
})
