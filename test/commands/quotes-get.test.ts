import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterAll, afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {default as QuotesGet} from '../../src/commands/quotes/get.js'

/**
 * Command-boundary coverage for `ledgerops quotes get` (issue #110, packet QTE-39).
 *
 * Everything is offline and synthetic: `accountingApi.getQuote` is replaced with an
 * injected fake, so every assertion is exact rather than inferred against live Xero data.
 */

const TENANT = 'synthetic-quotes-get-tenant-must-not-echo'
const PROFILE = 'synthetic-quotes-get-profile'
const CLIENT_ID = 'synthetic-quotes-get-client-id'

const SYNTHETIC_QUOTE_ID = '33333333-3333-3333-3333-333333333333'
const SYNTHETIC_QUOTE_NUMBER = 'QU-0001'

const SYNTHETIC_QUOTE = {
  quoteID: SYNTHETIC_QUOTE_ID,
  quoteNumber: SYNTHETIC_QUOTE_NUMBER,
  reference: 'REF-0001',
  status: 'SENT',
  date: '2026-08-01',
  expiryDate: '2026-08-15',
  total: 150,
  contact: {name: 'Acme Ltd'},
  lineItems: [
    {description: 'Consulting', quantity: 2, unitAmount: 75, accountCode: '200', taxType: 'OUTPUT2', lineAmount: 150},
  ],
}

const api = vi.hoisted(() => ({
  getQuote: vi.fn(),
}))

const profileConfig = vi.hoisted(() => ({
  defaultProfile: 'synthetic-quotes-get-profile',
  clientId: 'synthetic-quotes-get-client-id',
}))

vi.mock('../../src/lib/profiles.js', () => ({
  getDefaultProfile: () => profileConfig.defaultProfile,
  getProfileClientId: () => profileConfig.clientId,
}))

vi.mock('../../src/lib/xero-client.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/lib/xero-client.js')>()
  const fakeCreateClient = async (_profileName: string, _clientId: string) => {
    return {
      xero: {
        accountingApi: {
          getQuote: api.getQuote,
        },
      },
      tenantId: TENANT,
    }
  }
  return {
    ...actual,
    createXeroClient: fakeCreateClient,
    withRetry: (
      profileNameArg: string,
      clientIdArg: string,
      operation: (client: unknown, tenantId: string) => Promise<unknown>,
    ) => actual.withRetry(profileNameArg, clientIdArg, operation, 2, {createClient: fakeCreateClient}),
  }
})

const CLI_ROOT = mkdtempSync(join(tmpdir(), 'ledgerops-quotes-get-cli-'))
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
  profileConfig.defaultProfile = PROFILE
  profileConfig.clientId = CLIENT_ID
  api.getQuote.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
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
    await QuotesGet.run([...args], {root: CLI_ROOT})
  } catch (caught) {
    error = caught instanceof Error ? caught : new Error(String(caught))
  } finally {
    consoleLog.mockRestore()
    consoleError.mockRestore()
    process.exitCode = previousExitCode
  }
  return {error, stdout: stdout.join(''), stderr: stderr.join('')}
}

describe('quotes get selector validation', () => {
  it('exits non-zero with a usage message when --quote-id is missing', async () => {
    const output = await runCommand([])

    expect(output.error).toBeDefined()
    expect(api.getQuote).not.toHaveBeenCalled()
    expect(`${output.error?.message ?? ''}${output.stderr}`).toMatch(/quote-id/i)
  })
})

describe('quotes get output', () => {
  it('fetches by --quote-id and renders the required human table columns', async () => {
    api.getQuote.mockResolvedValueOnce({response: {}, body: {quotes: [SYNTHETIC_QUOTE]}})

    const output = await runCommand(['--quote-id', SYNTHETIC_QUOTE_ID])

    expect(output.error).toBeUndefined()
    expect(api.getQuote).toHaveBeenCalledWith(TENANT, SYNTHETIC_QUOTE_ID)
    expect(output.stdout).toContain(SYNTHETIC_QUOTE_ID)
    expect(output.stdout).toContain(SYNTHETIC_QUOTE_NUMBER)
    expect(output.stdout).toContain('Acme Ltd')
    expect(output.stdout).toContain('150.00')
    expect(output.stdout).toContain('1') // line-item count
  })

  it('returns the raw Quote object under --json', async () => {
    api.getQuote.mockResolvedValueOnce({response: {}, body: {quotes: [SYNTHETIC_QUOTE]}})

    const output = await runCommand(['--quote-id', SYNTHETIC_QUOTE_ID, '--json'])

    expect(output.error).toBeUndefined()
    const printed = JSON.parse(output.stdout) as Record<string, unknown>
    expect(printed).toEqual(SYNTHETIC_QUOTE)
  })

  it('maps a 404 from Xero to a clear not-found error', async () => {
    api.getQuote.mockRejectedValueOnce(
      new Error(
        JSON.stringify({
          response: {statusCode: 404},
          body: {},
        }),
      ),
    )

    const output = await runCommand(['--quote-id', SYNTHETIC_QUOTE_ID])

    expect(output.error).toBeDefined()
    expect(`${output.error?.message ?? ''}${output.stderr}`).toMatch(/not found/i)
  })
})
