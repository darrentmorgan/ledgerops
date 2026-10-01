import {XeroClient} from 'xero-node'
import {cacheTokenSet, clearCachedToken, getCachedTokenSet, isTokenExpired} from './auth.js'
import {EncryptionKeyError} from './crypto.js'
import {getClientHeaders} from './get-client-headers.js'
import {refreshAccessToken} from './oauth.js'

export {clearCachedToken}

export async function createXeroClient(
  profileName: string,
  clientId: string,
): Promise<{xero: XeroClient; tenantId: string}> {
  const cached = await getCachedTokenSet(profileName, clientId)
  if (!cached) {
    throw new Error(`Not logged in. Run "ledgerops login" to authenticate.`)
  }

  let accessToken = cached.accessToken
  const tenantId = cached.tenantId

  // If token is expired, try to refresh
  if (isTokenExpired(cached)) {
    try {
      const newTokenSet = await refreshAccessToken(clientId, cached.refreshToken)
      await cacheTokenSet(profileName, newTokenSet, cached.tenantId, cached.tenantName, clientId)
      accessToken = newTokenSet.access_token
    } catch {
      clearCachedToken(profileName)
      throw new Error(`Session expired. Run "ledgerops login" to re-authenticate.`)
    }
  }

  const xero = new XeroClient({clientId, clientSecret: ''})
  xero.setTokenSet({access_token: accessToken})

  const {headers} = getClientHeaders()
  ;(xero.accountingApi as unknown as {defaultHeaders: Record<string, string>}).defaultHeaders = {
    ...(xero.accountingApi as unknown as {defaultHeaders: Record<string, string>}).defaultHeaders,
    ...headers,
  }

  return {xero, tenantId}
}

export async function withRetry<T>(
  profileName: string,
  clientId: string,
  operation: (xero: XeroClient, tenantId: string) => Promise<T>,
  maxRetries = 2,
  dependencies: XeroClientDependencies = {},
): Promise<T> {
  const createClient = dependencies.createClient ?? createXeroClient
  let lastError: Error | undefined

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const {xero, tenantId} = await createClient(profileName, clientId)
      return await operation(xero, tenantId)
    } catch (error) {
      if (error instanceof EncryptionKeyError) throw error
      lastError = error instanceof Error ? error : new Error(String(error))

      const {statusCode, parsed} = parseXeroError(lastError)

      // Handle 401: try refreshing token
      if (statusCode === 401 && attempt < maxRetries) {
        const cached = await getCachedTokenSet(profileName, clientId)
        if (cached?.refreshToken) {
          try {
            const newTokenSet = await refreshAccessToken(clientId, cached.refreshToken)
            await cacheTokenSet(profileName, newTokenSet, cached.tenantId, cached.tenantName, clientId)
            continue
          } catch {
            clearCachedToken(profileName)
            throw new Error(`Session expired. Run "ledgerops login" to re-authenticate.`)
          }
        }
        clearCachedToken(profileName)
        continue
      }

      throw mapTerminalXeroError(lastError, {statusCode, parsed})
    }
  }

  throw lastError ? sanitizeApiError(lastError) : new Error('Operation failed after retries')
}

function mapTerminalXeroError(error: Error, hint: ParsedXeroError, options: {authExpiredMessage?: string} = {}): Error {
  const {statusCode, parsed} = hint
  if (statusCode === 401 && options.authExpiredMessage) {
    return new Error(options.authExpiredMessage)
  }
  if (statusCode === 429) {
    const retryAfter = extractRetryAfter(parsed, error.message)
    return new Error(`Rate limited. Retry after ${retryAfter} seconds.`)
  }
  if (statusCode === 404) {
    return new Error('Resource not found.')
  }
  return sanitizeApiError(error, hint)
}

export interface XeroClientDependencies {
  readonly createClient?: typeof createXeroClient
}

export async function withSingleAttempt<T>(
  profileName: string,
  clientId: string,
  operation: (xero: XeroClient, tenantId: string) => Promise<T>,
  dependencies: XeroClientDependencies = {},
): Promise<T> {
  const createClient = dependencies.createClient ?? createXeroClient
  const {xero, tenantId} = await createClient(profileName, clientId)
  try {
    return await operation(xero, tenantId)
  } catch (error) {
    if (error instanceof EncryptionKeyError) throw error
    const normalized = error instanceof Error ? error : new Error(String(error))
    const {statusCode, parsed} = parseXeroError(normalized)
    throw mapTerminalXeroError(
      normalized,
      {statusCode, parsed},
      {
        authExpiredMessage: 'Session expired. Run "ledgerops login" to re-authenticate.',
      },
    )
  }
}

interface ParsedXeroError {
  statusCode?: number
  parsed?: Record<string, unknown>
}

export function parseXeroError(error: Error): ParsedXeroError {
  const message = error.message
  if (typeof message !== 'string') return {}
  const trimmed = message.trim()
  if (!trimmed.startsWith('{')) return {}

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object') return {}

  const obj = parsed as Record<string, unknown>
  const response = obj.response as Record<string, unknown> | undefined
  const rawStatus = response?.statusCode ?? response?.status
  const statusCode = typeof rawStatus === 'number' ? rawStatus : undefined
  return {statusCode, parsed: obj}
}

export function sanitizeApiError(error: Error, hint?: ParsedXeroError): Error {
  const {statusCode, parsed} = hint ?? parseXeroError(error)

  // Non-Xero error (network, our own thrown messages, etc.) — pass through.
  if (!parsed) return new Error(error.message)

  try {
    const response = parsed.response as Record<string, unknown> | undefined
    const body = (parsed.body ?? response?.body) as Record<string, unknown> | undefined
    const statusSuffix = statusCode ? ` (${statusCode})` : ''

    if (body) {
      const elements = body.Elements as Array<Record<string, unknown>> | undefined
      if (elements?.length) {
        const messages = elements
          .flatMap(el => (el.ValidationErrors as Array<{Message?: string}> | undefined) ?? [])
          .map(ve => ve.Message)
          .filter((m): m is string => Boolean(m))
        if (messages.length) {
          return new Error(`Xero API error${statusSuffix}: ${messages.join('; ')}`)
        }
      }

      const topMessage = body.Message ?? body.message
      if (typeof topMessage === 'string' && topMessage) {
        return new Error(`Xero API error${statusSuffix}: ${topMessage}`)
      }
    }

    return new Error(`Xero API error${statusSuffix}`)
  } catch {
    return new Error(statusCode ? `Xero API error (${statusCode})` : 'Xero API error')
  }
}

function extractRetryAfter(parsed: Record<string, unknown> | undefined, fallbackMessage: string): number {
  const headers = (parsed?.response as Record<string, unknown> | undefined)?.headers as
    | Record<string, unknown>
    | undefined
  const headerValue = headers?.['retry-after']
  if (typeof headerValue === 'string' || typeof headerValue === 'number') {
    const n = Number(headerValue)
    if (Number.isFinite(n) && n > 0) return n
  }
  const match = /retry-after[":\s]+(\d+)/i.exec(fallbackMessage)
  return match ? Number(match[1]) : 60
}
