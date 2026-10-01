import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterAll, beforeEach, describe, expect, it, vi} from 'vitest'
import BankTransactionsCreate from '../../src/commands/bank-transactions/create.js'
import BankTransactionsUpdate from '../../src/commands/bank-transactions/update.js'
import {mutationCommandBoundaryTests, type CommandClass} from '../support/mutation-command-boundary.js'

const TENANT = 'synthetic-bank-transaction-tenant-must-not-echo'
const CLIENT_ID = 'synthetic-bank-transaction-client-must-not-echo'
const CREATE_ID = '00000000-0000-0000-0000-000000001260'
const UPDATE_ID = '00000000-0000-0000-0000-000000001261'

const api = vi.hoisted(() => ({
  createBankTransactions: vi.fn(),
  updateBankTransaction: vi.fn(),
  getOrganisations: vi.fn(),
}))
const profile = vi.hoisted(() => ({
  name: 'synthetic-bank-profile',
  clientId: 'synthetic-bank-transaction-client-must-not-echo',
  resolves: 0,
}))
const targets = vi.hoisted(() => [] as Array<{profileName: string; clientId: string; xero: object}>)
const dispatchClients = vi.hoisted(() => [] as object[])
const lookupClients = vi.hoisted(() => [] as object[])
const prompt = vi.hoisted(() => ({
  answer: 'YES',
  calls: [] as Array<{input?: unknown; output?: unknown}>,
  questions: [] as string[],
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
    const xero = {
      accountingApi: {
        createBankTransactions: (...args: unknown[]) => {
          dispatchClients.push(xero)
          return api.createBankTransactions(...args)
        },
        updateBankTransaction: (...args: unknown[]) => {
          dispatchClients.push(xero)
          return api.updateBankTransaction(...args)
        },
        getOrganisations: (...args: unknown[]) => {
          lookupClients.push(xero)
          return api.getOrganisations(...args)
        },
      },
    }
    targets.push({profileName, clientId, xero})
    return {xero, tenantId: TENANT}
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
      question: async (question: string) => {
        prompt.questions.push(question)
        prompt.onQuestion?.()
        return prompt.answer
      },
      close: () => {},
    }
  },
}))

const root = mkdtempSync(join(tmpdir(), 'ledgerops-bank-transaction-gate-root-'))
const fixtures = mkdtempSync(join(tmpdir(), 'ledgerops-bank-transaction-gate-fixtures-'))
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

function fixture(prefix: string, data: unknown): string {
  fixtureNumber += 1
  const path = join(fixtures, `${prefix}-${fixtureNumber}.json`)
  writeFileSync(path, JSON.stringify(data))
  return path
}

function createFixture(
  data: unknown = {
    type: 'SPEND',
    bankAccount: {accountID: 'synthetic-bank-account-126'},
    contact: {contactID: 'synthetic-contact-126'},
    reference: 'BT-CREATE-126',
    lineItems: [{description: 'Synthetic supplies', quantity: 1, unitAmount: 12.6, accountCode: '429'}],
  },
): string {
  return fixture('create', data)
}

function updateFixture(
  data: unknown = {
    bankTransactionID: UPDATE_ID,
    reference: 'BT-UPDATED-126',
    status: 'DELETED',
  },
): string {
  return fixture('update', data)
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
  api.createBankTransactions.mockReset()
  api.updateBankTransaction.mockReset()
  api.getOrganisations.mockReset().mockResolvedValue({body: {organisations: [{shortCode: 'synthetic-short-code'}]}})
  profile.name = 'synthetic-bank-profile'
  profile.clientId = CLIENT_ID
  profile.resolves = 0
  targets.length = 0
  dispatchClients.length = 0
  lookupClients.length = 0
  prompt.answer = 'YES'
  prompt.calls.length = 0
  prompt.questions.length = 0
  prompt.onQuestion = undefined
})

describe('bank-transactions create shared command boundary', () => {
  mutationCommandBoundaryTests({
    command: BankTransactionsCreate,
    apiMethod: api.createBankTransactions,
    fixture: createFixture,
    expectedPreviewLiteral: 'create bank-transactions',
    expectedResultLine: `Bank transaction created: ${CREATE_ID}`,
    executeResponse: {body: {bankTransactions: [{bankTransactionID: CREATE_ID, type: 'SPEND'}]}},
    run,
    interactiveCalls: () => prompt.calls,
  })
})

describe('bank-transactions update shared command boundary', () => {
  mutationCommandBoundaryTests({
    command: BankTransactionsUpdate,
    apiMethod: api.updateBankTransaction,
    fixture: updateFixture,
    expectedPreviewLiteral: 'update bank-transactions',
    expectedResultLine: `Bank transaction updated: ${UPDATE_ID}`,
    executeResponse: {
      body: {bankTransactions: [{bankTransactionID: UPDATE_ID, reference: 'BT-UPDATED-126', status: 'DELETED'}]},
    },
    run,
    interactiveCalls: () => prompt.calls,
  })
})

describe.each([
  {name: 'create', command: BankTransactionsCreate, apiMethod: api.createBankTransactions, fixture: createFixture},
  {name: 'update', command: BankTransactionsUpdate, apiMethod: api.updateBankTransaction, fixture: updateFixture},
])('bank-transactions $name target and confirmation safety', ({command, apiMethod, fixture: commandFixture}) => {
  it("requires the exact dual-TTY answer 'YES' and seals the pre-prompt profile", async () => {
    await dualTty(async () => {
      apiMethod.mockResolvedValue({
        body: {bankTransactions: [{bankTransactionID: command === BankTransactionsCreate ? CREATE_ID : UPDATE_ID}]},
      })
      prompt.answer = 'y'
      const declined = await run(command, ['--file', commandFixture(), '--execute'])
      expect(declined.error?.message).toMatch(/declined/i)
      expect(apiMethod).not.toHaveBeenCalled()
      expect(prompt.calls[0]?.output).toBe(process.stderr)
      expect(declined.stderr).toContain('PENDING MUTATION')

      prompt.answer = ' YES '
      prompt.onQuestion = () => {
        profile.name = 'rotated-bank-profile'
        profile.clientId = 'rotated-bank-client'
      }
      profile.resolves = 0
      const accepted = await run(command, ['--file', commandFixture(), '--execute'])
      expect(accepted.error).toBeUndefined()
      expect(apiMethod).toHaveBeenCalledTimes(1)
      expect(profile.resolves).toBe(1)
      expect(targets.map(({profileName, clientId}) => ({profileName, clientId}))).toEqual([
        {profileName: 'synthetic-bank-profile', clientId: CLIENT_ID},
      ])
    })
  })

  it('resolves the target before validation and dispatches nothing for malformed input', async () => {
    const malformed =
      command === BankTransactionsCreate
        ? createFixture({type: 'SPEND', lineItems: []})
        : updateFixture({reference: 'missing path ID'})
    const output = await run(command, ['--file', malformed])
    expect(profile.resolves).toBe(1)
    expect(output.error?.message).toMatch(/Validation errors/)
    expect(apiMethod).not.toHaveBeenCalled()
  })

  it('does not retry or leak target data after a 401', async () => {
    apiMethod.mockRejectedValue(
      new Error(JSON.stringify({response: {statusCode: 401}, tenantId: TENANT, clientId: CLIENT_ID})),
    )
    const output = await run(command, ['--file', commandFixture(), '--execute'])
    expect(apiMethod).toHaveBeenCalledTimes(1)
    expect(output.error?.message).toMatch(/session expired|re-authenticate/i)
    expect(`${output.stdout}${output.stderr}${output.error?.message}`).not.toContain(TENANT)
    expect(`${output.stdout}${output.stderr}${output.error?.message}`).not.toContain(CLIENT_ID)
  })
})

describe('bank-transactions command-specific mutation records', () => {
  it('seals the create payload and keeps target secrets out of previews', async () => {
    const output = await run(BankTransactionsCreate, [
      '--json',
      '--file',
      createFixture({
        type: 'SPEND',
        bankAccountId: 'synthetic-bank-account-126',
        contactID: 'synthetic-contact-126',
        reference: 'BT-CREATE-126',
        lineItems: [{description: 'Synthetic supplies', quantity: 1, unitAmount: 12.6, accountCode: '429'}],
      }),
    ])
    const preview = JSON.parse(output.stdout) as {payloadDigest: string; payload: Record<string, unknown>}
    expect(preview.payload).toEqual(expect.objectContaining({type: 'SPEND', reference: 'BT-CREATE-126'}))
    expect(preview.payload.bankAccount).toEqual({accountID: 'synthetic-bank-account-126'})
    expect(preview.payload.contact).toEqual({contactID: 'synthetic-contact-126'})
    expect(preview.payload).not.toHaveProperty('bankAccountId')
    expect(preview.payload).not.toHaveProperty('contactID')
    expect(preview.payloadDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(output.stdout).not.toContain(TENANT)
    expect(output.stdout).not.toContain(CLIENT_ID)
  })

  it('binds the update path ID into the record and digest, and names fields and status', async () => {
    const path = updateFixture()
    const output = await run(BankTransactionsUpdate, ['--json', '--file', path])
    const preview = JSON.parse(output.stdout) as {payloadDigest: string; payload: Record<string, unknown>}
    expect(preview.payload.bankTransactionID).toBe(UPDATE_ID)
    expect(preview.payloadDigest).toMatch(/^sha256:[0-9a-f]{64}$/)

    const text = await run(BankTransactionsUpdate, ['--file', path])
    expect(text.stdout).toContain(UPDATE_ID)
    expect(text.stdout).toContain('changed fields: reference, status')
    expect(text.stdout).toContain('status transition: to DELETED')
    expect(text.stdout).not.toContain(TENANT)
    expect(text.stdout).not.toContain(CLIENT_ID)
  })

  it('uses the sealed dispatch client for the post-write organisation lookup', async () => {
    api.createBankTransactions.mockResolvedValue({body: {bankTransactions: [{bankTransactionID: CREATE_ID}]}})
    const output = await run(BankTransactionsCreate, ['--file', createFixture(), '--execute'])
    expect(output.error).toBeUndefined()
    expect(api.createBankTransactions).toHaveBeenCalledTimes(1)
    expect(api.getOrganisations).toHaveBeenCalledTimes(1)
    expect(dispatchClients).toHaveLength(1)
    expect(lookupClients).toEqual(dispatchClients)
    expect(targets).toHaveLength(1)
  })

  it('drives the update API path from the sealed record ID', async () => {
    api.updateBankTransaction.mockResolvedValue({body: {bankTransactions: [{bankTransactionID: UPDATE_ID}]}})
    const file = updateFixture()
    const preview = await run(BankTransactionsUpdate, ['--json', '--file', file])
    const sealed = JSON.parse(preview.stdout) as {payload: Record<string, unknown>; payloadDigest: string}
    expect(sealed.payload.bankTransactionID).toBe(UPDATE_ID)

    const changed = await run(BankTransactionsUpdate, [
      '--json',
      '--file',
      updateFixture({...sealed.payload, bankTransactionID: `${UPDATE_ID}-other`}),
    ])
    expect((JSON.parse(changed.stdout) as {payloadDigest: string}).payloadDigest).not.toBe(sealed.payloadDigest)

    const output = await run(BankTransactionsUpdate, ['--json', '--file', file, '--execute'])
    expect(output.error).toBeUndefined()
    expect(api.updateBankTransaction).toHaveBeenCalledExactlyOnceWith(TENANT, UPDATE_ID, {
      bankTransactions: [sealed.payload],
    })
  })

  it('does not retry or redispatch a successful mutation when the short-code lookup fails', async () => {
    api.createBankTransactions.mockResolvedValue({body: {bankTransactions: [{bankTransactionID: CREATE_ID}]}})
    api.getOrganisations.mockRejectedValue(new Error('synthetic lookup failure'))
    const output = await run(BankTransactionsCreate, ['--file', createFixture(), '--execute'])
    expect(output.error).toBeUndefined()
    expect(api.createBankTransactions).toHaveBeenCalledTimes(1)
    expect(api.getOrganisations).toHaveBeenCalledTimes(1)
    expect(targets).toHaveLength(1)
    expect(output.stdout).toContain(`Bank transaction created: ${CREATE_ID}`)
    expect(output.stdout).not.toContain('View in Xero:')
  })
})
