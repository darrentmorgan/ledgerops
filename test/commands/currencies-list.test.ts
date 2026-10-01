import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {default as CurrenciesList} from '../../src/commands/currencies/list.js'

/**
 * Command-boundary coverage for `ledgerops currencies list`.
 *
 * Offline and synthetic throughout: the live Xero client is replaced with an
 * injected fake `accountingApi.getCurrencies` so every assertion is exact and
 * no real network call, token, or tenant data is involved.
 */

const TENANT = 'synthetic-currencies-tenant-must-not-echo'

const api = vi.hoisted(() => ({
  getCurrencies: vi.fn(),
}))

const profileConfig = vi.hoisted(() => ({
  defaultProfile: 'synthetic-currencies-profile',
  clientId: 'synthetic-currencies-client-id',
}))

vi.mock('../../src/lib/profiles.js', () => ({
  getDefaultProfile: () => profileConfig.defaultProfile,
  getProfileClientId: () => profileConfig.clientId,
}))

vi.mock('../../src/lib/xero-client.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/lib/xero-client.js')>()
  const fakeCreateClient = async (_profileName: string, _clientId: string) => ({
    xero: {
      accountingApi: {
        getCurrencies: api.getCurrencies,
      },
    },
    tenantId: TENANT,
  })
  return {
    ...actual,
    createXeroClient: fakeCreateClient,
    withRetry: (
      profileName: string,
      clientId: string,
      operation: (client: unknown, tenantId: string) => Promise<unknown>,
    ) => actual.withRetry(profileName, clientId, operation, 2, {createClient: fakeCreateClient}),
  }
})

const CLI_ROOT = mkdtempSync(join(tmpdir(), 'ledgerops-currencies-list-cli-'))
writeFileSync(
  join(CLI_ROOT, 'package.json'),
  JSON.stringify({
    name: 'synthetic-test-profile',
    version: '1.0.0',
    type: 'module',
    oclif: {
      bin: 'synthetic-test-profile',
      commands: join(process.cwd(), 'dist', 'commands'),
    },
  }),
)

afterAll(() => {
  rmSync(CLI_ROOT, {recursive: true, force: true})
})

beforeEach(() => {
  api.getCurrencies.mockReset()
  profileConfig.defaultProfile = 'synthetic-currencies-profile'
  profileConfig.clientId = 'synthetic-currencies-client-id'
})

async function runCommand(args: readonly string[]) {
  const stdout: string[] = []
  const stderr: string[] = []
  const previousExitCode = process.exitCode
  const consoleLog = vi.spyOn(console, 'log').mockImplementation((...logged: unknown[]) => {
    stdout.push(`${logged.map(String).join(' ')}\n`)
  })
  const consoleError = vi.spyOn(console, 'error').mockImplementation((...logged: unknown[]) => {
    stderr.push(`${logged.map(String).join(' ')}\n`)
  })
  let error: Error | undefined
  process.exitCode = undefined
  try {
    await CurrenciesList.run([...args], {root: CLI_ROOT})
  } catch (caught) {
    error = caught instanceof Error ? caught : new Error(String(caught))
  } finally {
    consoleLog.mockRestore()
    consoleError.mockRestore()
    process.exitCode = previousExitCode
  }
  return {error, stdout: stdout.join(''), stderr: stderr.join('')}
}

const CURRENCIES = [
  {code: 'USD', description: 'US dollar'},
  {code: 'AUD', description: 'Australian dollar'},
]

describe('currencies list command', () => {
  it('fetches the currency catalogue for the tenant and renders a table', async () => {
    api.getCurrencies.mockResolvedValue({body: {currencies: CURRENCIES}})

    const output = await runCommand([])

    expect(output.error).toBeUndefined()
    expect(api.getCurrencies).toHaveBeenCalledTimes(1)
    expect(api.getCurrencies).toHaveBeenCalledWith(TENANT)
    expect(output.stdout).toContain('AUD')
    expect(output.stdout).toContain('Australian dollar')
    expect(output.stdout).toContain('USD')
    expect(output.stdout).toContain('US dollar')
    expect(output.stdout).not.toContain(TENANT)
  })

  it('returns the full currency objects under --json in API order', async () => {
    api.getCurrencies.mockResolvedValue({body: {currencies: CURRENCIES}})

    const output = await runCommand(['--json'])

    expect(output.error).toBeUndefined()
    expect(JSON.parse(output.stdout)).toEqual(CURRENCIES)
  })

  it('renders deterministic CSV output', async () => {
    api.getCurrencies.mockResolvedValue({body: {currencies: CURRENCIES}})

    const output = await runCommand(['--csv'])

    expect(output.error).toBeUndefined()
    const lines = output.stdout.split('\n')
    expect(lines[0]).toBe('Code,Description')
    expect(lines[1]).toBe('USD,US dollar')
    expect(lines[2]).toBe('AUD,Australian dollar')
  })

  it('renders the no-results message when Xero returns no currencies', async () => {
    api.getCurrencies.mockResolvedValue({body: {currencies: []}})

    const output = await runCommand([])

    expect(output.error).toBeUndefined()
    expect(output.stdout).toContain('No results found')
  })

  it('maps a Xero API 403 to a sanitized API error without leaking headers or tokens', async () => {
    api.getCurrencies.mockRejectedValue(
      new Error(
        JSON.stringify({
          response: {
            statusCode: 403,
            body: {Message: 'AuthenticationUnsuccessful'},
            headers: {authorization: 'Bearer synthetic-token-must-not-leak'},
          },
        }),
      ),
    )

    const output = await runCommand([])

    expect(output.error).toBeDefined()
    expect(`${output.error?.message ?? ''}${output.stderr}`).toMatch(/403|AuthenticationUnsuccessful/)
    expect(`${output.error?.message ?? ''}${output.stderr}`).not.toContain('synthetic-token-must-not-leak')
    expect(output.stdout).toBe('')
  })
})
