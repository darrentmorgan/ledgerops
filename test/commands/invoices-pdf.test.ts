import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterAll, afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {default as InvoicesPdf} from '../../src/commands/invoices/pdf.js'

/**
 * Command-boundary coverage for `ledgerops invoices pdf` (issue #109, packet ACC-03).
 *
 * Offline and synthetic: `accountingApi.getInvoiceAsPdf` (and `getInvoice`, used only to
 * resolve the default filename) are replaced with injected fakes, and `%PDF-1.4 fake...`
 * fixture bytes stand in for a real PDF. This is also the first exerciser of the shared
 * `src/lib/file-download.ts` helper that later quotes/credit-notes/purchase-orders PDF
 * commands reuse unchanged.
 */

const TENANT = 'synthetic-pdf-tenant-must-not-echo'
const PROFILE = 'synthetic-pdf-profile'
const CLIENT_ID = 'synthetic-pdf-client-id'

const SYNTHETIC_INVOICE_ID = '22222222-2222-2222-2222-222222222222'
const SYNTHETIC_INVOICE_NUMBER = 'INV-0042'
const FIXTURE_PDF_BYTES = Buffer.from('%PDF-1.4 fake pdf bytes\n', 'utf-8')

const api = vi.hoisted(() => ({
  getInvoiceAsPdf: vi.fn(),
  getInvoice: vi.fn(),
}))

const profileConfig = vi.hoisted(() => ({
  defaultProfile: 'synthetic-pdf-profile',
  clientId: 'synthetic-pdf-client-id',
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
          getInvoiceAsPdf: api.getInvoiceAsPdf,
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

const CLI_ROOT = mkdtempSync(join(tmpdir(), 'ledgerops-invoices-pdf-cli-'))
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

let workDir: string

afterAll(() => {
  rmSync(CLI_ROOT, {recursive: true, force: true})
})

beforeEach(() => {
  profileConfig.defaultProfile = PROFILE
  profileConfig.clientId = CLIENT_ID
  api.getInvoiceAsPdf.mockReset()
  api.getInvoice.mockReset()
  workDir = mkdtempSync(join(tmpdir(), 'ledgerops-invoices-pdf-work-'))
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(workDir, {recursive: true, force: true})
})

async function runCommand(args: readonly string[]) {
  const stdoutChunks: Buffer[] = []
  const stderr: string[] = []
  const previousExitCode = process.exitCode
  const consoleLog = vi.spyOn(console, 'log').mockImplementation((...logged: unknown[]) => {
    stdoutChunks.push(Buffer.from(`${logged.map(String).join(' ')}\n`))
  })
  const consoleError = vi.spyOn(console, 'error').mockImplementation((...logged: unknown[]) => {
    stderr.push(`${logged.map(String).join(' ')}\n`)
  })
  const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    return true
  })
  let error: Error | undefined
  process.exitCode = undefined
  try {
    await InvoicesPdf.run([...args], {root: CLI_ROOT})
  } catch (caught) {
    error = caught instanceof Error ? caught : new Error(String(caught))
  } finally {
    consoleLog.mockRestore()
    consoleError.mockRestore()
    stdoutWrite.mockRestore()
    process.exitCode = previousExitCode
  }
  return {error, stdout: Buffer.concat(stdoutChunks), stderr: stderr.join('')}
}

describe('invoices pdf validation', () => {
  it('exits non-zero with a usage message when --invoice-id is missing', async () => {
    const output = await runCommand([])

    expect(output.error).toBeDefined()
    expect(api.getInvoiceAsPdf).not.toHaveBeenCalled()
    expect(`${output.error?.message ?? ''}${output.stderr}`).toMatch(/invoice-id/i)
  })

  it('rejects --json as unsupported for binary output', async () => {
    const output = await runCommand(['--invoice-id', SYNTHETIC_INVOICE_ID, '--json'])

    expect(output.error).toBeDefined()
    expect(api.getInvoiceAsPdf).not.toHaveBeenCalled()
    expect(`${output.error?.message ?? ''}${output.stderr}`).toMatch(/json/i)
  })
})

describe('invoices pdf file output', () => {
  it('writes fixture bytes to the resolved --out path', async () => {
    api.getInvoiceAsPdf.mockResolvedValueOnce({response: {}, body: FIXTURE_PDF_BYTES})

    const target = join(workDir, 'custom.pdf')
    const output = await runCommand(['--invoice-id', SYNTHETIC_INVOICE_ID, '--out', target])

    expect(output.error).toBeUndefined()
    expect(api.getInvoiceAsPdf).toHaveBeenCalledWith(TENANT, SYNTHETIC_INVOICE_ID)
    expect(api.getInvoice).not.toHaveBeenCalled()
    expect(existsSync(target)).toBe(true)
    expect(readFileSync(target)).toEqual(FIXTURE_PDF_BYTES)
    expect(output.stdout.toString('utf-8')).toContain('custom.pdf')
    expect(output.stdout.toString('utf-8')).toContain(String(FIXTURE_PDF_BYTES.length))
  })

  it('defaults the filename to ./INV-<number>.pdf using the resolved invoice number', async () => {
    api.getInvoiceAsPdf.mockResolvedValueOnce({response: {}, body: FIXTURE_PDF_BYTES})
    api.getInvoice.mockResolvedValueOnce({
      response: {},
      body: {invoices: [{invoiceID: SYNTHETIC_INVOICE_ID, invoiceNumber: SYNTHETIC_INVOICE_NUMBER}]},
    })

    const previousCwd = process.cwd()
    process.chdir(workDir)
    let output: Awaited<ReturnType<typeof runCommand>>
    try {
      output = await runCommand(['--invoice-id', SYNTHETIC_INVOICE_ID])
    } finally {
      process.chdir(previousCwd)
    }

    expect(output.error).toBeUndefined()
    expect(api.getInvoice).toHaveBeenCalledWith(TENANT, SYNTHETIC_INVOICE_ID)
    const expectedPath = join(workDir, `INV-${SYNTHETIC_INVOICE_NUMBER}.pdf`)
    expect(existsSync(expectedPath)).toBe(true)
    expect(readFileSync(expectedPath)).toEqual(FIXTURE_PDF_BYTES)
  })

  it('errors clearly when the --out parent directory does not exist', async () => {
    api.getInvoiceAsPdf.mockResolvedValueOnce({response: {}, body: FIXTURE_PDF_BYTES})

    const target = join(workDir, 'missing-dir', 'out.pdf')
    const output = await runCommand(['--invoice-id', SYNTHETIC_INVOICE_ID, '--out', target])

    expect(output.error).toBeDefined()
    expect(`${output.error?.message ?? ''}${output.stderr}`).toMatch(/directory does not exist/i)
    expect(existsSync(target)).toBe(false)
  })

  it('maps a 404 from Xero to a clear not-found error', async () => {
    api.getInvoiceAsPdf.mockRejectedValueOnce(
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

describe('invoices pdf stdout mode', () => {
  it('streams raw bytes to stdout with zero other stdout output', async () => {
    api.getInvoiceAsPdf.mockResolvedValueOnce({response: {}, body: FIXTURE_PDF_BYTES})

    const output = await runCommand(['--invoice-id', SYNTHETIC_INVOICE_ID, '--out', '-'])

    expect(output.error).toBeUndefined()
    expect(api.getInvoice).not.toHaveBeenCalled()
    expect(output.stdout).toEqual(FIXTURE_PDF_BYTES)
  })
})
