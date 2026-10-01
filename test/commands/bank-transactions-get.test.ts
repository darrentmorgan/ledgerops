import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {default as BankTransactionsGet} from '../../src/commands/bank-transactions/get.js'

const TENANT = 'synthetic-bank-transaction-get-tenant-must-not-echo'

const api = vi.hoisted(() => ({
  getBankTransaction: vi.fn(),
}))

const profileConfig = vi.hoisted(() => ({
  defaultProfile: 'synthetic-get-profile',
  clientId: 'synthetic-get-client-id',
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
        getBankTransaction: api.getBankTransaction,
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

const CLI_ROOT = mkdtempSync(join(tmpdir(), 'ledgerops-bank-transactions-get-cli-'))
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
  api.getBankTransaction.mockReset()
  profileConfig.defaultProfile = 'synthetic-get-profile'
  profileConfig.clientId = 'synthetic-get-client-id'
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
  let exitCode: number | undefined
  process.exitCode = undefined
  try {
    await BankTransactionsGet.run([...args], {root: CLI_ROOT})
  } catch (caught) {
    error = caught instanceof Error ? caught : new Error(String(caught))
  } finally {
    exitCode = typeof process.exitCode === 'number' ? process.exitCode : undefined
    consoleLog.mockRestore()
    consoleError.mockRestore()
    process.exitCode = previousExitCode
  }
  return {error, exitCode, stdout: stdout.join(''), stderr: stderr.join('')}
}

const SYNTHETIC_ID = '00000000-0000-0000-0000-00000000fee1'

const syntheticTransaction = {
  bankTransactionID: SYNTHETIC_ID,
  type: 'SPEND',
  contact: {name: 'Synthetic Supplies Co'},
  date: '/Date(1700000000000+0000)/',
  total: 150.5,
  status: 'AUTHORISED',
  reference: 'synthetic-ref',
  lineItems: [
    {
      description: 'Office supplies',
      quantity: 1,
      unitAmount: 150.5,
      taxType: 'INPUT2',
      accountCode: '429',
      lineAmount: 150.5,
    },
  ],
}

describe('bank-transactions get command', () => {
  it('fetches a single bank transaction and renders a table', async () => {
    api.getBankTransaction.mockResolvedValue({body: {bankTransactions: [syntheticTransaction]}})

    const output = await runCommand(['--bank-transaction-id', SYNTHETIC_ID])

    expect(output.error).toBeUndefined()
    expect(api.getBankTransaction).toHaveBeenCalledTimes(1)
    expect(api.getBankTransaction).toHaveBeenCalledWith(TENANT, SYNTHETIC_ID)
    expect(output.stdout).toContain(SYNTHETIC_ID)
    expect(output.stdout).toContain('SPEND')
    expect(output.stdout).toContain('Synthetic Supplies Co')
    expect(output.stdout).not.toContain(TENANT)
  })

  it('renders the full BankTransaction object under --json', async () => {
    api.getBankTransaction.mockResolvedValue({body: {bankTransactions: [syntheticTransaction]}})

    const output = await runCommand(['--bank-transaction-id', SYNTHETIC_ID, '--json'])

    expect(output.error).toBeUndefined()
    const printed = JSON.parse(output.stdout) as Record<string, unknown>
    expect(printed).toEqual(
      expect.objectContaining({
        bankTransactionID: SYNTHETIC_ID,
        type: 'SPEND',
        reference: 'synthetic-ref',
      }),
    )
    expect(printed.lineItems).toEqual(syntheticTransaction.lineItems)
  })

  it('requires --bank-transaction-id with a non-zero exit and usage message', async () => {
    const output = await runCommand([])

    expect(output.error).toBeDefined()
    expect(output.error?.message).toMatch(/bank-transaction-id/i)
    expect(api.getBankTransaction).not.toHaveBeenCalled()
  })

  it('maps a 404 from Xero to a clear not-found error', async () => {
    api.getBankTransaction.mockRejectedValue(new Error(JSON.stringify({response: {statusCode: 404}})))

    const output = await runCommand(['--bank-transaction-id', SYNTHETIC_ID])

    expect(output.error).toBeDefined()
    expect(output.error?.message).toMatch(/not found/i)
    expect(output.stdout).toBe('')
  })
})
