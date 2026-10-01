import {createHash, randomBytes} from 'node:crypto'
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http'
import {stripVTControlCharacters} from 'node:util'
import {select} from '@inquirer/prompts'

const XERO_AUTH_BASE = 'https://login.xero.com/identity'
const XERO_TOKEN_BASE = 'https://identity.xero.com'
const REDIRECT_URI = 'http://localhost:8742/callback'
const CALLBACK_TIMEOUT_MS = 120_000

const REQUIRED_OAUTH_SCOPES = ['openid', 'profile', 'email', 'offline_access']

const SCOPES = [
  ...REQUIRED_OAUTH_SCOPES,
  // Contacts & settings
  'accounting.contacts',
  'accounting.settings',
  // Granular transaction scopes
  'accounting.invoices',
  'accounting.payments',
  'accounting.banktransactions',
  'accounting.manualjournals',
  // Granular report scopes. accounting.journals.read is deliberately NOT a
  // default: Xero gates it behind the Advanced tier plus certification, and an
  // unavailable scope in the request can block login outright. Eligible apps
  // opt in with `ledgerops login --scope`.
  'accounting.reports.aged.read',
  'accounting.reports.balancesheet.read',
  'accounting.reports.profitandloss.read',
  'accounting.reports.trialbalance.read',
  // Other
  'accounting.budgets.read',
  'accounting.attachments',
].join(' ')

interface TokenSet {
  access_token: string
  refresh_token?: string
  expires_in?: number
  expires_at?: number
  id_token?: string
  token_type?: string
  scope?: string
}

interface XeroTenant {
  id: string
  authEventId: string
  tenantId: string
  tenantType: string
  tenantName: string
}

function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url')
}

function generateCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

function resolveScopes(scopes?: string): string {
  if (!scopes) return SCOPES
  const requested = scopes.split(/\s+/).filter(Boolean)
  return [...new Set([...REQUIRED_OAUTH_SCOPES, ...requested])].join(' ')
}

function buildAuthUrl(clientId: string, codeChallenge: string, state: string, scopes?: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: resolveScopes(scopes),
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  })
  return `${XERO_AUTH_BASE}/connect/authorize?${params.toString()}`
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[char] ?? char,
  )
}

export function sanitizeTerminalText(value: string): string {
  return [...stripVTControlCharacters(value)]
    .filter(char => {
      const code = char.codePointAt(0) ?? 0
      return (
        code > 0x1f &&
        !(code >= 0x7f && code <= 0x9f) &&
        !(code >= 0x202a && code <= 0x202e) &&
        !(code >= 0x2066 && code <= 0x2069)
      )
    })
    .join('')
}

function waitForCallback(expectedState: string, openBrowser: () => Promise<unknown>): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: Error, code?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      server.close()
      server.closeAllConnections()
      if (error) reject(error)
      else if (code !== undefined) resolve(code)
      else reject(new Error('OAuth callback did not provide a code'))
    }
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://localhost:8742')
      if (url.pathname !== '/callback') {
        res.writeHead(404)
        res.end('Not found')
        return
      }
      // Validate state before even reading provider-controlled success/error fields.
      if (url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== expectedState) {
        res.writeHead(400)
        res.end('Invalid OAuth state.')
        return
      }
      const error = url.searchParams.get('error')
      if (error) {
        const desc = url.searchParams.get('error_description') ?? error
        res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'})
        res.end(
          `<html><body><h1>Authentication Failed</h1><p>${escapeHtml(desc)}</p><p>You can close this window.</p></body></html>`,
        )
        finish(new Error(`OAuth error: ${sanitizeTerminalText(desc)}`))
        return
      }
      const code = url.searchParams.get('code')
      if (!code || url.searchParams.getAll('code').length !== 1) {
        res.writeHead(400)
        res.end('Missing or ambiguous authorization code.')
        return
      }
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'})
      res.end('<html><body><h1>Success!</h1><p>You are now logged in. You can close this window.</p></body></html>')
      finish(undefined, code)
    })
    const timeout = setTimeout(() => {
      finish(new Error('OAuth callback timed out after 2 minutes. Please try again.'))
    }, CALLBACK_TIMEOUT_MS)
    server.on('error', err => {
      finish(
        new Error(
          (err as NodeJS.ErrnoException).code === 'EADDRINUSE'
            ? 'Port 8742 is already in use. Close any other login attempts and try again.'
            : 'Could not start the OAuth callback server.',
        ),
      )
    })
    try {
      server.listen(8742, '127.0.0.1', () => {
        if (settled) return
        Promise.resolve()
          .then(openBrowser)
          .catch(() => finish(new Error('Could not open the browser for OAuth login.')))
      })
    } catch {
      finish(new Error('Could not start the OAuth callback server.'))
    }
  })
}

async function exchangeCodeForTokens(clientId: string, code: string, codeVerifier: string): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: codeVerifier,
  })

  const response = await fetch(`${XERO_TOKEN_BASE}/connect/token`, {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: body.toString(),
  }).catch(() => {
    throw new Error('OAuth token request failed. Please log in again.')
  })

  if (!response.ok) {
    throw new Error(`Token exchange failed (${response.status}). Please log in again.`)
  }

  try {
    return (await response.json()) as TokenSet
  } catch {
    throw new Error('Invalid OAuth token response. Please log in again.')
  }
}

async function fetchTenants(accessToken: string): Promise<XeroTenant[]> {
  const response = await fetch('https://api.xero.com/connections', {
    headers: {Authorization: `Bearer ${accessToken}`},
  })

  if (!response.ok) {
    throw new Error(`Failed to fetch Xero tenants (${response.status})`)
  }

  return response.json() as Promise<XeroTenant[]>
}

export async function performLogin(
  clientId: string,
  scopes?: string,
): Promise<{tokenSet: TokenSet; tenantId: string; tenantName: string}> {
  const {default: open} = await import('open')

  const codeVerifier = generateCodeVerifier()
  const codeChallenge = generateCodeChallenge(codeVerifier)
  const state = randomBytes(16).toString('hex')

  const authUrl = buildAuthUrl(clientId, codeChallenge, state, scopes)

  // Start the callback server before opening the browser
  const code = await waitForCallback(state, () => open(authUrl))
  const tokenSet = await exchangeCodeForTokens(clientId, code, codeVerifier)

  // Resolve tenant
  const tenants = await fetchTenants(tokenSet.access_token)

  if (tenants.length === 0) {
    throw new Error('No Xero organisations found. Please connect at least one organisation to your app.')
  }

  let tenant: XeroTenant
  if (tenants.length === 1) {
    tenant = tenants[0]
  } else {
    const selected = await select({
      message: 'Select a Xero organisation:',
      choices: tenants.map(t => ({name: sanitizeTerminalText(t.tenantName), value: t.tenantId})),
    })
    const selectedTenant = tenants.find(t => t.tenantId === selected)
    if (!selectedTenant) throw new Error('Selected organisation is unavailable')
    tenant = selectedTenant
  }

  return {tokenSet, tenantId: tenant.tenantId, tenantName: tenant.tenantName}
}

export async function refreshAccessToken(clientId: string, refreshToken: string): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: refreshToken,
  })

  const response = await fetch(`${XERO_TOKEN_BASE}/connect/token`, {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: body.toString(),
  }).catch(() => {
    throw new Error('OAuth token request failed. Please log in again.')
  })

  if (!response.ok) {
    throw new Error(`Token refresh failed (${response.status}). Please log in again.`)
  }

  try {
    return (await response.json()) as TokenSet
  } catch {
    throw new Error('Invalid OAuth token response. Please log in again.')
  }
}
