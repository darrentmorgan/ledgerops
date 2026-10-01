import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterAll, afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {default as QuotesPdf} from '../../src/commands/quotes/pdf.js'

/**
 * Command-boundary coverage for `ledgerops quotes pdf` (issue #110, packet QTE-39).
 *
 * Offline and synthetic: `accountingApi.getQuoteAsPdf` (and `getQuote`, used only to
 * resolve the default filename) are replaced with injected fakes, and `%PDF-1.4 fake...`
 * fixture bytes stand in for a real PDF. This reuses the shared `src/lib/file-download.ts`
 * helper introduced by `invoices pdf` (ACC-03), unchanged.
 */

const TENANT = 'synthetic-quotes-pdf-tenant-must-not-echo'
const PROFILE = 'synthetic-quotes-pdf-profile'
const CLIENT_ID = 'synthetic-quotes-pdf-client-id'

const SYNTHETIC_QUOTE_ID = '44444444-4444-4444-4444-444444444444'
const SYNTHETIC_QUOTE_NUMBER = 'QU-0042'
const FIXTURE_PDF_BYTES = Buffer.from('%PDF-1.4 fake pdf bytes\n', 'utf-8')

const api = vi.hoisted(() => ({
  getQuoteAsPdf: vi.fn(),
  getQuote: vi.fn(),
}))

const profileConfig = vi.hoisted(() => ({
  defaultProfile: 'synthetic-quotes-pdf-profile',
  clientId: 'synthetic-quotes-pdf-client-id',
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
          getQuoteAsPdf: api.getQuoteAsPdf,
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

const CLI_ROOT = mkdtempSync(join(tmpdir(), 'ledgerops-quotes-pdf-cli-'))
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
  api.getQuoteAsPdf.mockReset()
  api.getQuote.mockReset()
  workDir = mkdtempSync(join(tmpdir(), 'ledgerops-quotes-pdf-work-'))
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
    await QuotesPdf.run([...args], {root: CLI_ROOT})
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

describe('quotes pdf validation', () => {
  it('exits non-zero with a usage message when --quote-id is missing', async () => {
    const output = await runCommand([])

    expect(output.error).toBeDefined()
    expect(api.getQuoteAsPdf).not.toHaveBeenCalled()
    expect(`${output.error?.message ?? ''}${output.stderr}`).toMatch(/quote-id/i)
  })

  it('rejects --json as unsupported for binary output', async () => {
    const output = await runCommand(['--quote-id', SYNTHETIC_QUOTE_ID, '--json'])

    expect(output.error).toBeDefined()
    expect(api.getQuoteAsPdf).not.toHaveBeenCalled()
    expect(`${output.error?.message ?? ''}${output.stderr}`).toMatch(/json/i)
  })

  it('rejects --csv as unsupported for binary output', async () => {
    const output = await runCommand(['--quote-id', SYNTHETIC_QUOTE_ID, '--csv'])

    expect(output.error).toBeDefined()
    expect(api.getQuoteAsPdf).not.toHaveBeenCalled()
    expect(`${output.error?.message ?? ''}${output.stderr}`).toMatch(/csv/i)
  })

  it('rejects --toon as unsupported for binary output', async () => {
    const output = await runCommand(['--quote-id', SYNTHETIC_QUOTE_ID, '--toon'])

    expect(output.error).toBeDefined()
    expect(api.getQuoteAsPdf).not.toHaveBeenCalled()
    expect(`${output.error?.message ?? ''}${output.stderr}`).toMatch(/toon/i)
  })
})

describe('quotes pdf file output', () => {
  it('writes fixture bytes to the resolved --out path', async () => {
    api.getQuoteAsPdf.mockResolvedValueOnce({response: {}, body: FIXTURE_PDF_BYTES})

    const target = join(workDir, 'custom.pdf')
    const output = await runCommand(['--quote-id', SYNTHETIC_QUOTE_ID, '--out', target])

    expect(output.error).toBeUndefined()
    expect(api.getQuoteAsPdf).toHaveBeenCalledWith(TENANT, SYNTHETIC_QUOTE_ID)
    expect(api.getQuote).not.toHaveBeenCalled()
    expect(existsSync(target)).toBe(true)
    expect(readFileSync(target)).toEqual(FIXTURE_PDF_BYTES)
    expect(output.stdout.toString('utf-8')).toContain('custom.pdf')
    expect(output.stdout.toString('utf-8')).toContain(String(FIXTURE_PDF_BYTES.length))
  })

  it('defaults the filename to ./QU-<number>.pdf using the resolved quote number', async () => {
    api.getQuoteAsPdf.mockResolvedValueOnce({response: {}, body: FIXTURE_PDF_BYTES})
    api.getQuote.mockResolvedValueOnce({
      response: {},
      body: {quotes: [{quoteID: SYNTHETIC_QUOTE_ID, quoteNumber: SYNTHETIC_QUOTE_NUMBER}]},
    })

    const previousCwd = process.cwd()
    process.chdir(workDir)
    let output: Awaited<ReturnType<typeof runCommand>>
    try {
      output = await runCommand(['--quote-id', SYNTHETIC_QUOTE_ID])
    } finally {
      process.chdir(previousCwd)
    }

    expect(output.error).toBeUndefined()
    expect(api.getQuote).toHaveBeenCalledWith(TENANT, SYNTHETIC_QUOTE_ID)
    const expectedPath = join(workDir, `QU-${SYNTHETIC_QUOTE_NUMBER}.pdf`)
    expect(existsSync(expectedPath)).toBe(true)
    expect(readFileSync(expectedPath)).toEqual(FIXTURE_PDF_BYTES)
  })

  it('errors clearly when the --out parent directory does not exist', async () => {
    api.getQuoteAsPdf.mockResolvedValueOnce({response: {}, body: FIXTURE_PDF_BYTES})

    const target = join(workDir, 'missing-dir', 'out.pdf')
    const output = await runCommand(['--quote-id', SYNTHETIC_QUOTE_ID, '--out', target])

    expect(output.error).toBeDefined()
    expect(`${output.error?.message ?? ''}${output.stderr}`).toMatch(/directory does not exist/i)
    expect(existsSync(target)).toBe(false)
  })

  it('maps a 404 from Xero to a clear not-found error', async () => {
    api.getQuoteAsPdf.mockRejectedValueOnce(
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

describe('quotes pdf stdout mode', () => {
  it('streams raw bytes to stdout with zero other stdout output', async () => {
    api.getQuoteAsPdf.mockResolvedValueOnce({response: {}, body: FIXTURE_PDF_BYTES})

    const output = await runCommand(['--quote-id', SYNTHETIC_QUOTE_ID, '--out', '-'])

    expect(output.error).toBeUndefined()
    expect(api.getQuote).not.toHaveBeenCalled()
    expect(output.stdout).toEqual(FIXTURE_PDF_BYTES)
  })
})
