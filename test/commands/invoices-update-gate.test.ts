import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterAll, beforeEach, describe, expect, it, vi} from 'vitest'
import InvoicesUpdate from '../../src/commands/invoices/update.js'
import {type CommandClass, mutationCommandBoundaryTests} from '../support/mutation-command-boundary.js'

const TENANT = 'synthetic-invoice-tenant-must-not-echo'
const CLIENT_ID = 'synthetic-invoice-client-must-not-echo'
const INVOICE_ID = '00000000-0000-0000-0000-000000001290'

const api = vi.hoisted(() => ({updateInvoice: vi.fn()}))
const profile = vi.hoisted(() => ({
  name: 'synthetic-invoice-profile',
  clientId: 'synthetic-invoice-client-must-not-echo',
  resolves: 0,
}))
const targets = vi.hoisted(() => [] as Array<{profileName: string; clientId: string}>)
const prompt = vi.hoisted(() => ({
  answer: 'YES',
  calls: [] as Array<{input?: unknown; output?: unknown}>,
  onQuestion: undefined as undefined | (() => void),
}))

vi.mock('../../src/lib/profiles.js', () => ({
  getDefaultProfile: () => {
    profile.resolves += 1
    return profile.name
  },
  getProfileClientId: () => profile.clientId,
}))

vi.mock('../../src/lib/xero-client.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/lib/xero-client.js')>()
  const createClient = async (profileName: string, clientId: string) => {
    targets.push({profileName, clientId})
    return {xero: {accountingApi: api}, tenantId: TENANT}
  }
  return {
    ...actual,
    withSingleAttempt: (
      profileName: string,
      clientId: string,
      operation: (client: unknown, tenantId: string) => Promise<unknown>,
    ) => actual.withSingleAttempt(profileName, clientId, operation, {createClient}),
    withRetry: vi.fn(() => {
      throw new Error('retry wrapper must not serve a gated mutation')
    }),
  }
})

vi.mock('node:readline/promises', () => ({
  createInterface: ({input, output}: {input?: unknown; output?: unknown}) => {
    prompt.calls.push({input, output})
    return {
      question: async () => {
        prompt.onQuestion?.()
        return prompt.answer
      },
      close: () => {},
    }
  },
}))

const root = mkdtempSync(join(tmpdir(), 'ledgerops-invoice-update-gate-root-'))
const fixtures = mkdtempSync(join(tmpdir(), 'ledgerops-invoice-update-gate-fixtures-'))
writeFileSync(
  join(root, 'package.json'),
  JSON.stringify({
    name: 'ledgerops-test',
    version: '1.0.0',
    type: 'module',
    oclif: {bin: 'ledgerops', commands: join(process.cwd(), 'dist', 'commands')},
  }),
)
let fixtureNumber = 0

function fixture(data: unknown = {invoiceID: INVOICE_ID, reference: 'INV-UPDATED-129', status: 'AUTHORISED'}): string {
  fixtureNumber += 1
  const path = join(fixtures, `invoice-update-${fixtureNumber}.json`)
  writeFileSync(path, JSON.stringify(data))
  return path
}

async function run(command: CommandClass, args: readonly string[]) {
  const stdout: string[] = []
  const stderr: string[] = []
  const log = vi.spyOn(console, 'log').mockImplementation((...values) => {
    stdout.push(`${values.map(String).join(' ')}\n`)
  })
  const errorLog = vi.spyOn(console, 'error').mockImplementation((...values) => {
    stderr.push(`${values.map(String).join(' ')}\n`)
  })
  let error: Error | undefined
  const priorExitCode = process.exitCode
  process.exitCode = undefined
  try {
    await command.run([...args], {root})
  } catch (caught) {
    error = caught instanceof Error ? caught : new Error(String(caught))
  } finally {
    log.mockRestore()
    errorLog.mockRestore()
    process.exitCode = priorExitCode
  }
  return {error, stdout: stdout.join(''), stderr: stderr.join('')}
}

async function dualTty<T>(body: () => Promise<T>): Promise<T> {
  const stdin = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
  const stdout = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  Object.defineProperty(process.stdin, 'isTTY', {value: true, configurable: true})
  Object.defineProperty(process.stdout, 'isTTY', {value: true, configurable: true})
  try {
    return await body()
  } finally {
    if (stdin) Object.defineProperty(process.stdin, 'isTTY', stdin)
    else delete (process.stdin as {isTTY?: boolean}).isTTY
    if (stdout) Object.defineProperty(process.stdout, 'isTTY', stdout)
    else delete (process.stdout as {isTTY?: boolean}).isTTY
  }
}

afterAll(() => {
  rmSync(root, {recursive: true, force: true})
  rmSync(fixtures, {recursive: true, force: true})
})

beforeEach(() => {
  api.updateInvoice.mockReset()
  profile.name = 'synthetic-invoice-profile'
  profile.clientId = CLIENT_ID
  profile.resolves = 0
  targets.length = 0
  prompt.answer = 'YES'
  prompt.calls.length = 0
  prompt.onQuestion = undefined
})

describe('invoices update shared command boundary', () => {
  mutationCommandBoundaryTests({
    command: InvoicesUpdate,
    apiMethod: api.updateInvoice,
    fixture,
    expectedPreviewLiteral: 'update invoices',
    expectedResultLine: `Invoice updated: INV-0129 (${INVOICE_ID})`,
    targetsExistingResource: true,
    executeResponse: {body: {invoices: [{invoiceID: INVOICE_ID, invoiceNumber: 'INV-0129'}]}},
    run,
    interactiveCalls: () => prompt.calls,
  })
})

describe('invoices update target and confirmation safety', () => {
  it("requires the exact dual-TTY answer 'YES' and seals the pre-prompt profile", async () => {
    await dualTty(async () => {
      api.updateInvoice.mockResolvedValue({body: {invoices: [{invoiceID: INVOICE_ID, invoiceNumber: 'INV-0129'}]}})
      prompt.answer = 'y'
      const declined = await run(InvoicesUpdate, ['--file', fixture(), '--execute'])
      expect(declined.error?.message).toMatch(/declined/i)
      expect(api.updateInvoice).not.toHaveBeenCalled()
      expect(prompt.calls[0]?.output).toBe(process.stderr)
      expect(declined.stderr).toContain('PENDING MUTATION')

      prompt.answer = ' YES '
      prompt.onQuestion = () => {
        profile.name = 'rotated-invoice-profile'
        profile.clientId = 'rotated-invoice-client'
      }
      profile.resolves = 0
      const accepted = await run(InvoicesUpdate, ['--file', fixture(), '--execute'])
      expect(accepted.error).toBeUndefined()
      expect(api.updateInvoice).toHaveBeenCalledTimes(1)
      expect(profile.resolves).toBe(1)
      expect(targets).toEqual([{profileName: 'synthetic-invoice-profile', clientId: CLIENT_ID}])
    })
  })

  it('resolves the target before validation and dispatches nothing for malformed input', async () => {
    const output = await run(InvoicesUpdate, ['--file', fixture({reference: 'missing invoice ID'})])
    expect(profile.resolves).toBe(1)
    expect(output.error?.message).toMatch(/Validation errors/)
    expect(api.updateInvoice).not.toHaveBeenCalled()
  })

  it('does not replay or leak target data after a 401', async () => {
    api.updateInvoice.mockRejectedValue(
      new Error(JSON.stringify({response: {statusCode: 401}, tenantId: TENANT, clientId: CLIENT_ID})),
    )
    const output = await run(InvoicesUpdate, ['--file', fixture(), '--execute'])
    expect(api.updateInvoice).toHaveBeenCalledTimes(1)
    expect(output.error?.message).toMatch(/session expired|re-authenticate/i)
    expect(`${output.stdout}${output.stderr}${output.error?.message}`).not.toContain(TENANT)
    expect(`${output.stdout}${output.stderr}${output.error?.message}`).not.toContain(CLIENT_ID)
  })
})

describe('invoices update sealed record', () => {
  it.each(['AUTHORISED', 'VOIDED'] as const)(
    'binds invoiceID into the digest and names changed fields and the %s status transition',
    async status => {
      const path = fixture({invoiceID: INVOICE_ID, reference: 'INV-UPDATED-129', status})
      const output = await run(InvoicesUpdate, ['--json', '--file', path])
      const preview = JSON.parse(output.stdout) as {payloadDigest: string; payload: Record<string, unknown>}
      expect(preview.payload).toEqual({invoiceID: INVOICE_ID, reference: 'INV-UPDATED-129', status})
      expect(preview.payloadDigest).toMatch(/^sha256:[0-9a-f]{64}$/)

      const text = await run(InvoicesUpdate, ['--file', path])
      expect(text.stdout).toContain(INVOICE_ID)
      expect(text.stdout).toContain('changed fields: reference, status')
      expect(text.stdout).toContain(`status transition: to ${status}`)
      expect(text.stdout).not.toContain(TENANT)
      expect(text.stdout).not.toContain(CLIENT_ID)
    },
  )

  it('drives the API path from the sealed invoiceID and changes the digest when that ID changes', async () => {
    api.updateInvoice.mockResolvedValue({body: {invoices: [{invoiceID: INVOICE_ID, invoiceNumber: 'INV-0129'}]}})
    const path = fixture()
    const preview = await run(InvoicesUpdate, ['--json', '--file', path])
    const sealed = JSON.parse(preview.stdout) as {payload: Record<string, unknown>; payloadDigest: string}

    const changed = await run(InvoicesUpdate, [
      '--json',
      '--file',
      fixture({...sealed.payload, invoiceID: `${INVOICE_ID}-other`}),
    ])
    expect((JSON.parse(changed.stdout) as {payloadDigest: string}).payloadDigest).not.toBe(sealed.payloadDigest)

    const output = await run(InvoicesUpdate, ['--json', '--file', path, '--execute'])
    expect(output.error).toBeUndefined()
    expect(api.updateInvoice).toHaveBeenCalledExactlyOnceWith(TENANT, INVOICE_ID, {invoices: [sealed.payload]})
  })
})
