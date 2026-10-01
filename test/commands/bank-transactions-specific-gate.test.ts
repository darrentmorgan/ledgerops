import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterAll, beforeEach, describe, expect, it, vi} from 'vitest'
import BankTransactionsCreate from '../../src/commands/bank-transactions/create.js'
import BankTransactionsUpdate from '../../src/commands/bank-transactions/update.js'
import type {CommandClass} from '../support/mutation-command-boundary.js'

const TENANT = 'synthetic-bank-tenant-must-not-echo'
const CLIENT_ID = 'synthetic-bank-client-must-not-echo'

const api = vi.hoisted(() => ({
  createBankTransactions: vi.fn(),
  getOrganisations: vi.fn(),
  updateBankTransaction: vi.fn(),
}))
const profile = vi.hoisted(() => ({
  name: 'synthetic-bank-profile',
  clientId: 'synthetic-bank-client-must-not-echo',
  resolves: 0,
}))
const targets = vi.hoisted(() => [] as Array<{profileName: string; clientId: string}>)
const prompt = vi.hoisted(() => ({
  answer: 'y',
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
      question: async (question: string) => {
        prompt.questions.push(question)
        prompt.onQuestion?.()
        return prompt.answer
      },
      close: () => {},
    }
  },
}))

const root = mkdtempSync(join(tmpdir(), 'ledgerops-bank-gate-root-'))
const fixtures = mkdtempSync(join(tmpdir(), 'ledgerops-bank-gate-fixtures-'))
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

function fixture(data: unknown): string {
  fixtureNumber += 1
  const path = join(fixtures, `bank-${fixtureNumber}.json`)
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

afterAll(() => {
  rmSync(root, {recursive: true, force: true})
  rmSync(fixtures, {recursive: true, force: true})
})
beforeEach(() => {
  api.updateBankTransaction.mockReset()
  api.createBankTransactions.mockReset()
  api.getOrganisations.mockReset()
  profile.name = 'synthetic-bank-profile'
  profile.clientId = CLIENT_ID
  profile.resolves = 0
  targets.length = 0
  prompt.answer = 'y'
  prompt.calls.length = 0
  prompt.questions.length = 0
  prompt.onQuestion = undefined
})

describe('bank transaction command-specific safety', () => {
  it('seals normalized create data and preserves successful output after deep-link lookup failure', async () => {
    const file = fixture({
      type: 'SPEND',
      contactID: 'contact-126',
      bankAccountId: 'bank-126',
      lineItems: [{description: 'Synthetic', unitAmount: 12}],
    })
    const preview = await run(BankTransactionsCreate, ['--file', file, '--json'])
    expect(preview.error).toBeUndefined()
    const payload = JSON.parse(preview.stdout).payload
    expect(payload.contact).toEqual({contactID: 'contact-126'})
    expect(payload.bankAccount).toEqual({accountID: 'bank-126'})
    expect(api.getOrganisations).not.toHaveBeenCalled()
    api.createBankTransactions.mockResolvedValue({body: {bankTransactions: [{bankTransactionID: 'tx-126'}]}})
    api.getOrganisations.mockRejectedValue({response: {statusCode: 401}})
    const executed = await run(BankTransactionsCreate, ['--file', file, '--json', '--execute'])
    expect(executed.error).toBeUndefined()
    expect(JSON.parse(executed.stdout)).toEqual({bankTransactionID: 'tx-126'})
    expect(api.createBankTransactions).toHaveBeenCalledExactlyOnceWith(TENANT, {bankTransactions: [payload]})
    expect(api.getOrganisations).toHaveBeenCalledExactlyOnceWith(TENANT)
    expect(targets).toHaveLength(1)
  })

  it('includes update identity in digest and names changed fields and requested status', async () => {
    const file = fixture({bankTransactionID: 'tx-126', reference: 'Synthetic', status: 'DELETED'})
    const preview = await run(BankTransactionsUpdate, ['--file', file, '--json'])
    expect(preview.error).toBeUndefined()
    const sealed = JSON.parse(preview.stdout)
    expect(sealed.payload.bankTransactionID).toBe('tx-126')
    const other = await run(BankTransactionsUpdate, [
      '--file',
      fixture({...sealed.payload, bankTransactionID: 'other-126'}),
      '--json',
    ])
    expect(JSON.parse(other.stdout).payloadDigest).not.toBe(sealed.payloadDigest)
    const human = await run(BankTransactionsUpdate, ['--file', file])
    expect(human.stdout).toContain('bank transaction tx-126')
    expect(human.stdout).toContain('changed fields: reference, status')
    expect(human.stdout).toContain('DELETED')
    api.updateBankTransaction.mockResolvedValue({body: {bankTransactions: [{bankTransactionID: 'tx-126'}]}})
    const executed = await run(BankTransactionsUpdate, ['--file', file, '--execute', '--json'])
    expect(executed.error).toBeUndefined()
    expect(api.updateBankTransaction).toHaveBeenCalledExactlyOnceWith(TENANT, sealed.payload.bankTransactionID, {
      bankTransactions: [sealed.payload],
    })
  })
})
