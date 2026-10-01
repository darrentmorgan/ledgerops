import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterAll, beforeEach, describe, expect, it, vi} from 'vitest'
import AccountsUpdate from '../../src/commands/accounts/update.js'
import {mutationCommandBoundaryTests, type CommandClass} from '../support/mutation-command-boundary.js'

const TENANT = 'synthetic-account-tenant-must-not-echo'
const CLIENT_ID = 'synthetic-account-client-must-not-echo'

const api = vi.hoisted(() => ({updateAccount: vi.fn(), getOrganisations: vi.fn()}))
const profile = vi.hoisted(() => ({
  name: 'synthetic-account-profile',
  clientId: 'synthetic-account-client-must-not-echo',
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

const root = mkdtempSync(join(tmpdir(), 'ledgerops-account-gate-root-'))
const fixtures = mkdtempSync(join(tmpdir(), 'ledgerops-account-gate-fixtures-'))
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

function fixture(data: unknown = {accountID: 'account-path-125', name: 'Archive Account', status: 'ARCHIVED'}): string {
  fixtureNumber += 1
  const path = join(fixtures, `account-${fixtureNumber}.json`)
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
  api.updateAccount.mockReset()
  api.getOrganisations.mockReset()
  profile.name = 'synthetic-account-profile'
  profile.clientId = CLIENT_ID
  profile.resolves = 0
  targets.length = 0
  prompt.answer = 'y'
  prompt.calls.length = 0
  prompt.questions.length = 0
  prompt.onQuestion = undefined
})

describe('accounts update shared command boundary', () => {
  mutationCommandBoundaryTests({
    command: AccountsUpdate,
    apiMethod: api.updateAccount,
    fixture,
    expectedPreviewLiteral: 'update accounts',
    expectedResultLine: 'Account updated: Archive Account (account-path-125)',
    executeResponse: {body: {accounts: [{accountID: 'account-path-125', name: 'Archive Account', status: 'ARCHIVED'}]}},
    run,
    interactiveCalls: () => prompt.calls,
  })
})

describe('accounts update binding and safety', () => {
  it('binds the path ID into the previewed payload and digest, and names fields/status without secrets', async () => {
    const output = await run(AccountsUpdate, ['--json', '--file', fixture()])
    const preview = JSON.parse(output.stdout) as {payloadDigest: string; payload: Record<string, unknown>}
    expect(preview.payload.accountID).toBe('account-path-125')
    expect(preview.payloadDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    const text = await run(AccountsUpdate, ['--file', fixture()])
    expect(text.stdout).toContain('changed fields: name, status')
    expect(text.stdout).toContain('status transition: to ARCHIVED')
    expect(text.stdout).not.toContain(CLIENT_ID)
    expect(text.stdout).not.toContain(TENANT)
  })

  it("uses stderr dual-TTY confirmation, rejects 'y', and accepts ' YES ' without target rotation", async () => {
    await dualTty(async () => {
      api.updateAccount.mockResolvedValue({
        body: {accounts: [{accountID: 'account-path-125', name: 'Archive Account'}]},
      })
      prompt.answer = 'y'
      const declined = await run(AccountsUpdate, ['--file', fixture(), '--execute'])
      expect(declined.error?.message).toMatch(/declined/i)
      expect(api.updateAccount).not.toHaveBeenCalled()
      expect(prompt.calls[0]?.output).toBe(process.stderr)
      expect(declined.stderr).toContain('PENDING MUTATION')

      prompt.answer = ' YES '
      prompt.onQuestion = () => {
        profile.name = 'rotated-profile'
        profile.clientId = 'rotated-client'
      }
      profile.resolves = 0
      const accepted = await run(AccountsUpdate, ['--file', fixture(), '--execute'])
      expect(accepted.error).toBeUndefined()
      expect(api.updateAccount).toHaveBeenCalledTimes(1)
      expect(profile.resolves).toBe(1)
      expect(targets).toEqual([{profileName: 'synthetic-account-profile', clientId: CLIENT_ID}])
    })
  })

  it('resolves the target before payload validation and dispatches nothing for malformed input', async () => {
    const output = await run(AccountsUpdate, ['--file', fixture({name: 'missing account ID'})])
    expect(profile.resolves).toBe(1)
    expect(output.error?.message).toMatch(/Validation errors/)
    expect(api.updateAccount).not.toHaveBeenCalled()
  })

  it('does not retry or leak output after a 401', async () => {
    api.updateAccount.mockRejectedValue(
      new Error(JSON.stringify({response: {statusCode: 401}, tenantId: TENANT, clientId: CLIENT_ID})),
    )
    const output = await run(AccountsUpdate, ['--file', fixture(), '--execute'])
    expect(api.updateAccount).toHaveBeenCalledTimes(1)
    expect(output.error?.message).toMatch(/session expired|re-authenticate/i)
    expect(`${output.stdout}${output.stderr}${output.error?.message}`).not.toContain(TENANT)
    expect(`${output.stdout}${output.stderr}${output.error?.message}`).not.toContain(CLIENT_ID)
  })
})
