import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterAll, afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {default as CreditNotesPdf} from '../../src/commands/credit-notes/pdf.js'

/**
 * Command-boundary coverage for `ledgerops credit-notes pdf` (issue #111, packet CN-07).
 *
 * Offline and synthetic: `accountingApi.getCreditNoteAsPdf` (and `getCreditNote`, used only
 * to resolve the default filename) are replaced with injected fakes, and
 * `%PDF-1.4 fake...` fixture bytes stand in for a real PDF. Mirrors
 * `test/commands/invoices-pdf.test.ts`, which exercises the same shared
 * `src/lib/file-download.ts` helper.
 */

const TENANT = 'synthetic-pdf-tenant-must-not-echo'
const PROFILE = 'synthetic-pdf-profile'
const CLIENT_ID = 'synthetic-pdf-client-id'

const SYNTHETIC_CREDIT_NOTE_ID = '33333333-3333-3333-3333-333333333333'
const SYNTHETIC_CREDIT_NOTE_NUMBER = 'CN-0007'
const FIXTURE_PDF_BYTES = Buffer.from('%PDF-1.4 fake credit note pdf bytes\n', 'utf-8')

const api = vi.hoisted(() => ({
  getCreditNoteAsPdf: vi.fn(),
  getCreditNote: vi.fn(),
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
          getCreditNoteAsPdf: api.getCreditNoteAsPdf,
          getCreditNote: api.getCreditNote,
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

const CLI_ROOT = mkdtempSync(join(tmpdir(), 'ledgerops-credit-notes-pdf-cli-'))
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
  api.getCreditNoteAsPdf.mockReset()
  api.getCreditNote.mockReset()
  workDir = mkdtempSync(join(tmpdir(), 'ledgerops-credit-notes-pdf-work-'))
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
    await CreditNotesPdf.run([...args], {root: CLI_ROOT})
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

describe('credit-notes pdf validation', () => {
  it('exits non-zero with a usage message when --credit-note-id is missing', async () => {
    const output = await runCommand([])

    expect(output.error).toBeDefined()
    expect(api.getCreditNoteAsPdf).not.toHaveBeenCalled()
    expect(`${output.error?.message ?? ''}${output.stderr}`).toMatch(/credit-note-id/i)
  })

  it('rejects --json as unsupported for binary output', async () => {
    const output = await runCommand(['--credit-note-id', SYNTHETIC_CREDIT_NOTE_ID, '--json'])

    expect(output.error).toBeDefined()
    expect(api.getCreditNoteAsPdf).not.toHaveBeenCalled()
    expect(`${output.error?.message ?? ''}${output.stderr}`).toMatch(/json/i)
  })
})

describe('credit-notes pdf file output', () => {
  it('writes fixture bytes to the resolved --out path', async () => {
    api.getCreditNoteAsPdf.mockResolvedValueOnce({response: {}, body: FIXTURE_PDF_BYTES})

    const target = join(workDir, 'custom.pdf')
    const output = await runCommand(['--credit-note-id', SYNTHETIC_CREDIT_NOTE_ID, '--out', target])

    expect(output.error).toBeUndefined()
    expect(api.getCreditNoteAsPdf).toHaveBeenCalledWith(TENANT, SYNTHETIC_CREDIT_NOTE_ID)
    expect(api.getCreditNote).not.toHaveBeenCalled()
    expect(existsSync(target)).toBe(true)
    expect(readFileSync(target)).toEqual(FIXTURE_PDF_BYTES)
    expect(output.stdout.toString('utf-8')).toContain('custom.pdf')
    expect(output.stdout.toString('utf-8')).toContain(String(FIXTURE_PDF_BYTES.length))
  })

  it('defaults the filename to ./CN-<number>.pdf using the resolved credit note number', async () => {
    api.getCreditNoteAsPdf.mockResolvedValueOnce({response: {}, body: FIXTURE_PDF_BYTES})
    api.getCreditNote.mockResolvedValueOnce({
      response: {},
      body: {creditNotes: [{creditNoteID: SYNTHETIC_CREDIT_NOTE_ID, creditNoteNumber: SYNTHETIC_CREDIT_NOTE_NUMBER}]},
    })

    const previousCwd = process.cwd()
    process.chdir(workDir)
    let output: Awaited<ReturnType<typeof runCommand>>
    try {
      output = await runCommand(['--credit-note-id', SYNTHETIC_CREDIT_NOTE_ID])
    } finally {
      process.chdir(previousCwd)
    }

    expect(output.error).toBeUndefined()
    expect(api.getCreditNote).toHaveBeenCalledWith(TENANT, SYNTHETIC_CREDIT_NOTE_ID)
    const expectedPath = join(workDir, `CN-${SYNTHETIC_CREDIT_NOTE_NUMBER}.pdf`)
    expect(existsSync(expectedPath)).toBe(true)
    expect(readFileSync(expectedPath)).toEqual(FIXTURE_PDF_BYTES)
  })

  it('errors clearly when the --out parent directory does not exist', async () => {
    api.getCreditNoteAsPdf.mockResolvedValueOnce({response: {}, body: FIXTURE_PDF_BYTES})

    const target = join(workDir, 'missing-dir', 'out.pdf')
    const output = await runCommand(['--credit-note-id', SYNTHETIC_CREDIT_NOTE_ID, '--out', target])

    expect(output.error).toBeDefined()
    expect(`${output.error?.message ?? ''}${output.stderr}`).toMatch(/directory does not exist/i)
    expect(existsSync(target)).toBe(false)
  })

  it('maps a 404 from Xero to a clear not-found error', async () => {
    api.getCreditNoteAsPdf.mockRejectedValueOnce(
      new Error(
        JSON.stringify({
          response: {statusCode: 404},
          body: {},
        }),
      ),
    )

    const output = await runCommand(['--credit-note-id', SYNTHETIC_CREDIT_NOTE_ID])

    expect(output.error).toBeDefined()
    expect(`${output.error?.message ?? ''}${output.stderr}`).toMatch(/not found/i)
  })
})

describe('credit-notes pdf stdout mode', () => {
  it('streams raw bytes to stdout with zero other stdout output', async () => {
    api.getCreditNoteAsPdf.mockResolvedValueOnce({response: {}, body: FIXTURE_PDF_BYTES})

    const output = await runCommand(['--credit-note-id', SYNTHETIC_CREDIT_NOTE_ID, '--out', '-'])

    expect(output.error).toBeUndefined()
    expect(api.getCreditNote).not.toHaveBeenCalled()
    expect(output.stdout).toEqual(FIXTURE_PDF_BYTES)
  })
})
