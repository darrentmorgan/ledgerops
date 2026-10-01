import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterAll, afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {default as InvoicesGet} from '../../src/commands/invoices/get.js'

/**
 * Command-boundary coverage for `ledgerops invoices get` (issue #101, packet ACC-01).
 *
 * Everything is offline and synthetic: `accountingApi.getInvoice` is replaced with an
 * injected fake, so every assertion is exact rather than inferred against live Xero data.
 */

const TENANT = 'synthetic-get-tenant-must-not-echo'
const PROFILE = 'synthetic-get-profile'
const CLIENT_ID = 'synthetic-get-client-id'

const SYNTHETIC_INVOICE_ID = '11111111-1111-1111-1111-111111111111'
const SYNTHETIC_INVOICE_NUMBER = 'INV-0001'

const SYNTHETIC_INVOICE = {
  invoiceID: SYNTHETIC_INVOICE_ID,
  invoiceNumber: SYNTHETIC_INVOICE_NUMBER,
  type: 'ACCREC',
  status: 'AUTHORISED',
  reference: 'REF-0001',
  date: '2026-08-01',
  dueDate: '2026-08-15',
  total: 150,
  amountDue: 150,
  contact: {name: 'Acme Ltd'},
  lineItems: [
    {description: 'Consulting', quantity: 2, unitAmount: 75, accountCode: '200', taxType: 'OUTPUT2', lineAmount: 150},
  ],
}

const api = vi.hoisted(() => ({
  getInvoice: vi.fn(),
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
  const fakeCreateClient = async (_profileName: string, _clientId: string) => {
    return {
      xero: {
        accountingApi: {
          getInvoice: api.getInvoice,
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

const CLI_ROOT = mkdtempSync(join(tmpdir(), 'ledgerops-invoices-get-cli-'))
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
  api.getInvoice.mockReset()
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
    await InvoicesGet.run([...args], {root: CLI_ROOT})
  } catch (caught) {
    error = caught instanceof Error ? caught : new Error(String(caught))
  } finally {
    consoleLog.mockRestore()
    consoleError.mockRestore()
    process.exitCode = previousExitCode
  }
  return {error, stdout: stdout.join(''), stderr: stderr.join('')}
}

describe('invoices get selector validation', () => {
  it('exits non-zero with a usage message when neither selector is set', async () => {
    const output = await runCommand([])

    expect(output.error).toBeDefined()
    expect(api.getInvoice).not.toHaveBeenCalled()
    expect(`${output.error?.message ?? ''}${output.stderr}`).toMatch(/invoice-id|invoice-number/i)
  })

  it('exits non-zero with a usage message when both selectors are set', async () => {
    const output = await runCommand([
      '--invoice-id',
      SYNTHETIC_INVOICE_ID,
      '--invoice-number',
      SYNTHETIC_INVOICE_NUMBER,
    ])

    expect(output.error).toBeDefined()
    expect(api.getInvoice).not.toHaveBeenCalled()
    expect(`${output.error?.message ?? ''}${output.stderr}`).toMatch(/invoice-id|invoice-number/i)
  })
})

describe('invoices get selector forms', () => {
  it('fetches by --invoice-id', async () => {
    api.getInvoice.mockResolvedValueOnce({response: {}, body: {invoices: [SYNTHETIC_INVOICE]}})

    const output = await runCommand(['--invoice-id', SYNTHETIC_INVOICE_ID])

    expect(output.error).toBeUndefined()
    expect(api.getInvoice).toHaveBeenCalledWith(TENANT, SYNTHETIC_INVOICE_ID)
    expect(output.stdout).toContain(SYNTHETIC_INVOICE_ID)
  })

  it('fetches by --invoice-number', async () => {
    api.getInvoice.mockResolvedValueOnce({response: {}, body: {invoices: [SYNTHETIC_INVOICE]}})

    const output = await runCommand(['--invoice-number', SYNTHETIC_INVOICE_NUMBER])

    expect(output.error).toBeUndefined()
    expect(api.getInvoice).toHaveBeenCalledWith(TENANT, SYNTHETIC_INVOICE_NUMBER)
    expect(output.stdout).toContain(SYNTHETIC_INVOICE_ID)
  })
})

describe('invoices get output', () => {
  it('renders the required human table columns', async () => {
    api.getInvoice.mockResolvedValueOnce({response: {}, body: {invoices: [SYNTHETIC_INVOICE]}})

    const output = await runCommand(['--invoice-id', SYNTHETIC_INVOICE_ID])

    expect(output.error).toBeUndefined()
    expect(output.stdout).toContain(SYNTHETIC_INVOICE_ID)
    expect(output.stdout).toContain('ACCREC')
    expect(output.stdout).toContain('REF-0001')
    expect(output.stdout).toContain('Acme Ltd')
    expect(output.stdout).toContain('150.00')
    expect(output.stdout).toContain('1') // line-item count
  })

  it('returns the raw Invoice object under --json', async () => {
    api.getInvoice.mockResolvedValueOnce({response: {}, body: {invoices: [SYNTHETIC_INVOICE]}})

    const output = await runCommand(['--invoice-id', SYNTHETIC_INVOICE_ID, '--json'])

    expect(output.error).toBeUndefined()
    const printed = JSON.parse(output.stdout) as Record<string, unknown>
    expect(printed).toEqual(SYNTHETIC_INVOICE)
  })

  it('maps a 404 from Xero to a clear not-found error', async () => {
    api.getInvoice.mockRejectedValueOnce(
      new Error(
        JSON.stringify({
          response: {statusCode: 404},
          body: {},
        }),
      ),
    )

    const output = await runCommand(['--invoice-id', SYNTHETIC_INVOICE_ID])

    expect(output.error).toBeDefined()
    expect(`${output.error?.message ?? ''}${output.stderr}`).toMatch(/not found/i)
  })
})
