import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

const harness = vi.hoisted(() => ({
  browser: vi.fn<(url: string) => Promise<unknown>>(),
  handler: undefined as ((request: {url?: string}, response: FakeResponse) => void) | undefined,
  listen: undefined as (() => void) | undefined,
  error: undefined as ((error: NodeJS.ErrnoException) => void) | undefined,
  listenError: undefined as Error | undefined,
  close: vi.fn(),
  closeAllConnections: vi.fn(),
}))

class FakeResponse {
  status = 0
  headers: Record<string, string> = {}
  body = ''

  writeHead(status: number, headers: Record<string, string> = {}): void {
    this.status = status
    this.headers = headers
  }

  end(body = ''): void {
    this.body = body
  }
}

vi.mock('open', () => ({default: harness.browser}))
vi.mock('node:http', () => ({
  createServer: (handler: typeof harness.handler) => {
    harness.handler = handler
    return {
      close: harness.close,
      closeAllConnections: harness.closeAllConnections,
      listen: (_port: number, _host: string, callback: () => void) => {
        if (harness.listenError) throw harness.listenError
        harness.listen = callback
      },
      on: (_event: string, callback: (error: NodeJS.ErrnoException) => void) => {
        harness.error = callback
      },
    }
  },
}))

const {performLogin, refreshAccessToken, sanitizeTerminalText} = await import('../../src/lib/oauth.js')

function request(url: string): FakeResponse {
  const response = new FakeResponse()
  harness.handler?.({url}, response)
  return response
}

async function beginLogin(): Promise<{login: ReturnType<typeof performLogin>; state: string}> {
  const login = performLogin('synthetic-client-id')
  await vi.waitFor(() => expect(harness.listen).toBeTypeOf('function'))
  harness.listen?.()
  await vi.waitFor(() => expect(harness.browser).toHaveBeenCalledOnce())
  const authUrl = new URL(harness.browser.mock.calls[0][0] as unknown as string)
  const state = authUrl.searchParams.get('state')
  if (!state) throw new Error('Synthetic authorization URL did not contain state')
  return {login, state}
}

function expectCleanedUpOnce(): void {
  expect(harness.close).toHaveBeenCalledOnce()
  expect(harness.closeAllConnections).toHaveBeenCalledOnce()
}

describe('OAuth boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    harness.handler = undefined
    harness.listen = undefined
    harness.error = undefined
    harness.listenError = undefined
    harness.browser.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('rejects mismatched state before reading hostile provider fields', async () => {
    const {login, state} = await beginLogin()
    const hostile = '<script>token=provider-secret</script>\u001b[31m'
    const rejected = request(`/callback?state=wrong&error=denied&error_description=${encodeURIComponent(hostile)}`)
    expect(rejected.status).toBe(400)
    expect(rejected.body).toBe('Invalid OAuth state.')
    expect(rejected.body).not.toContain('provider-secret')
    expect(harness.close).not.toHaveBeenCalled()

    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ok: true, json: async () => ({access_token: 'synthetic-access'})})
        .mockResolvedValueOnce({ok: true, json: async () => [{tenantId: 'tenant-1', tenantName: 'Synthetic Org'}]}),
    )
    const accepted = request(`/callback?state=${state}&code=synthetic-code`)
    expect(accepted.status).toBe(200)
    await expect(login).resolves.toMatchObject({tenantId: 'tenant-1'})
    expectCleanedUpOnce()
  })

  it('escapes provider error HTML and strips terminal control characters', async () => {
    const {login, state} = await beginLogin()
    const hostile = `<script>alert('x')</script>&\u001b[31mspoof\u202e`
    const response = request(`/callback?state=${state}&error=denied&error_description=${encodeURIComponent(hostile)}`)
    expect(response.headers['Content-Type']).toBe('text/html; charset=utf-8')
    expect(response.body).toContain('&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;&amp;')
    expect(response.body).not.toContain('<script>')
    await expect(login).rejects.toThrow("OAuth error: <script>alert('x')</script>&spoof")
    expectCleanedUpOnce()
  })

  it('sanitizes C0, C1, bidi override, and isolate controls', () => {
    expect(sanitizeTerminalText('safe\u0000\u001b\u007f\u009f\u202e\u2066text')).toBe('safetext')
  })

  it('cleans up once when browser opening fails', async () => {
    harness.browser.mockRejectedValue(new Error('hostile browser detail'))
    const login = performLogin('synthetic-client-id')
    await vi.waitFor(() => expect(harness.listen).toBeTypeOf('function'))
    harness.listen?.()
    await expect(login).rejects.toThrow('Could not open the browser for OAuth login.')
    expectCleanedUpOnce()
  })

  it.each([
    [
      'address in use',
      Object.assign(new Error('sensitive bind detail'), {code: 'EADDRINUSE'}),
      'Port 8742 is already in use',
    ],
    ['generic server error', new Error('sensitive server detail'), 'Could not start the OAuth callback server.'],
  ])('cleans up once on %s', async (_label, error, message) => {
    const login = performLogin('synthetic-client-id')
    await vi.waitFor(() => expect(harness.error).toBeTypeOf('function'))
    harness.error?.(error)
    await expect(login).rejects.toThrow(message)
    expectCleanedUpOnce()
  })

  it('cleans up once when callback server listen throws synchronously', async () => {
    harness.listenError = new Error('sensitive listen detail')
    await expect(performLogin('synthetic-client-id')).rejects.toThrow('Could not start the OAuth callback server.')
    expectCleanedUpOnce()
  })

  it('cleans up once when the callback times out', async () => {
    vi.useFakeTimers()
    const login = performLogin('synthetic-client-id')
    const rejected = expect(login).rejects.toThrow('OAuth callback timed out')
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(120_000)
    await rejected
    expectCleanedUpOnce()
  })

  it.each([
    [
      'exchange',
      async () => {
        const {login, state} = await beginLogin()
        request(`/callback?state=${state}&code=synthetic-code`)
        return login
      },
    ],
    ['refresh', () => refreshAccessToken('synthetic-client-id', 'synthetic-refresh')],
  ])('redacts hostile %s token endpoint response bodies', async (_kind, operation) => {
    const text = vi.fn(async () => 'access_token=secret&refresh_token=secret-2')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ok: false, status: 401, text})),
    )
    await expect(operation()).rejects.toThrow(/failed \(401\).*log in again/i)
    expect(text).not.toHaveBeenCalled()
  })
})
