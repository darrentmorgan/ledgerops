import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterAll, beforeEach, describe, expect, it, vi} from 'vitest'
import ManualJournalsCreate from '../../src/commands/manual-journals/create.js'
import ManualJournalsUpdate from '../../src/commands/manual-journals/update.js'
import {mutationCommandBoundaryTests, type CommandClass} from '../support/mutation-command-boundary.js'

const TENANT = 'synthetic-journal-tenant-must-not-echo'
const CLIENT_ID = 'synthetic-journal-client-must-not-echo'
const JOURNAL_ID = '00000000-0000-0000-0000-000000001310'

const api = vi.hoisted(() => ({createManualJournals: vi.fn(), updateManualJournal: vi.fn()}))
const profile = vi.hoisted(() => ({
  name: 'synthetic-journal-profile',
  clientId: 'synthetic-journal-client-must-not-echo',
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

const root = mkdtempSync(join(tmpdir(), 'ledgerops-journal-gate-root-'))
const fixtures = mkdtempSync(join(tmpdir(), 'ledgerops-journal-gate-fixtures-'))
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
    narration: 'Synthetic journal 131',
    journalLines: [
      {lineAmount: 131, accountCode: '200', description: 'Synthetic debit'},
      {lineAmount: -131, accountCode: '300', description: 'Synthetic credit'},
    ],
  },
): string {
  return fixture('create', data)
}

function updateFixture(
  data: unknown = {
    manualJournalID: JOURNAL_ID,
    narration: 'Synthetic journal 131 updated',
    journalLines: [
      {lineAmount: 132, accountCode: '200', description: 'Updated debit'},
      {lineAmount: -132, accountCode: '300', description: 'Updated credit'},
    ],
    status: 'POSTED',
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
  api.createManualJournals.mockReset()
  api.updateManualJournal.mockReset()
  profile.name = 'synthetic-journal-profile'
  profile.clientId = CLIENT_ID
  profile.resolves = 0
  targets.length = 0
  prompt.answer = 'YES'
  prompt.calls.length = 0
  prompt.onQuestion = undefined
})

describe('manual journals create shared command boundary', () => {
  mutationCommandBoundaryTests({
    command: ManualJournalsCreate,
    apiMethod: api.createManualJournals,
    fixture: createFixture,
    expectedPreviewLiteral: 'create manual-journals',
    expectedResultLine: `Manual journal created: ${JOURNAL_ID}`,
    executeResponse: {body: {manualJournals: [{manualJournalID: JOURNAL_ID}]}},
    run,
    interactiveCalls: () => prompt.calls,
  })
})

describe('manual journals update shared command boundary', () => {
  mutationCommandBoundaryTests({
    command: ManualJournalsUpdate,
    apiMethod: api.updateManualJournal,
    fixture: updateFixture,
    expectedPreviewLiteral: 'update manual-journals',
    expectedResultLine: `Manual journal updated: ${JOURNAL_ID}`,
    targetsExistingResource: true,
    executeResponse: {body: {manualJournals: [{manualJournalID: JOURNAL_ID}]}},
    run,
    interactiveCalls: () => prompt.calls,
  })
})

describe.each([
  {name: 'create', command: ManualJournalsCreate, apiMethod: api.createManualJournals, fixture: createFixture},
  {name: 'update', command: ManualJournalsUpdate, apiMethod: api.updateManualJournal, fixture: updateFixture},
])('manual journals $name target and confirmation safety', ({command, apiMethod, fixture: commandFixture}) => {
  it("requires the exact dual-TTY answer 'YES' and seals the pre-prompt profile", async () => {
    await dualTty(async () => {
      apiMethod.mockResolvedValue({body: {manualJournals: [{manualJournalID: JOURNAL_ID}]}})
      prompt.answer = 'y'
      const declined = await run(command, ['--file', commandFixture(), '--execute'])
      expect(declined.error?.message).toMatch(/declined/i)
      expect(apiMethod).not.toHaveBeenCalled()
      expect(prompt.calls[0]?.output).toBe(process.stderr)
      expect(declined.stderr).toContain('PENDING MUTATION')

      prompt.answer = ' YES '
      prompt.onQuestion = () => {
        profile.name = 'rotated-journal-profile'
        profile.clientId = 'rotated-journal-client'
      }
      profile.resolves = 0
      const accepted = await run(command, ['--file', commandFixture(), '--execute'])
      expect(accepted.error).toBeUndefined()
      expect(apiMethod).toHaveBeenCalledTimes(1)
      expect(profile.resolves).toBe(1)
      expect(targets).toEqual([{profileName: 'synthetic-journal-profile', clientId: CLIENT_ID}])
    })
  })

  it('resolves the target before validation and dispatches nothing for malformed input', async () => {
    const malformed =
      command === ManualJournalsCreate
        ? createFixture({narration: 'missing journal lines'})
        : updateFixture({narration: 'missing ID and journal lines'})
    const output = await run(command, ['--file', malformed])
    expect(profile.resolves).toBe(1)
    expect(output.error?.message).toMatch(/Validation errors/)
    expect(apiMethod).not.toHaveBeenCalled()
  })

  it('does not replay or leak target data after a 401', async () => {
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

describe('manual journals command-specific mutation records', () => {
  it('seals the create payload and binds that record to the API request', async () => {
    const path = createFixture()
    const preview = await run(ManualJournalsCreate, ['--json', '--file', path])
    const sealed = JSON.parse(preview.stdout) as {payloadDigest: string; payload: Record<string, unknown>}
    expect(sealed.payload).toEqual({
      narration: 'Synthetic journal 131',
      journalLines: [
        {lineAmount: 131, accountCode: '200', description: 'Synthetic debit'},
        {lineAmount: -131, accountCode: '300', description: 'Synthetic credit'},
      ],
    })
    expect(sealed.payloadDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(preview.stdout).not.toContain(TENANT)
    expect(preview.stdout).not.toContain(CLIENT_ID)

    api.createManualJournals.mockResolvedValue({body: {manualJournals: [{manualJournalID: JOURNAL_ID}]}})
    const output = await run(ManualJournalsCreate, ['--json', '--file', path, '--execute'])
    expect(output.error).toBeUndefined()
    expect(api.createManualJournals).toHaveBeenCalledExactlyOnceWith(TENANT, {manualJournals: [sealed.payload]})
  })

  it.each(['POSTED', 'VOIDED'] as const)(
    'binds manualJournalID into the digest and names fields and the %s status transition',
    async status => {
      const path = updateFixture({
        manualJournalID: JOURNAL_ID,
        narration: 'Synthetic journal 131 updated',
        journalLines: [
          {lineAmount: 132, accountCode: '200', description: 'Updated debit'},
          {lineAmount: -132, accountCode: '300', description: 'Updated credit'},
        ],
        status,
      })
      const output = await run(ManualJournalsUpdate, ['--json', '--file', path])
      const preview = JSON.parse(output.stdout) as {payloadDigest: string; payload: Record<string, unknown>}
      expect(preview.payload.manualJournalID).toBe(JOURNAL_ID)
      expect(preview.payloadDigest).toMatch(/^sha256:[0-9a-f]{64}$/)

      const text = await run(ManualJournalsUpdate, ['--file', path])
      expect(text.stdout).toContain(JOURNAL_ID)
      expect(text.stdout).toContain('changed fields: narration, journalLines, status')
      expect(text.stdout).toContain(`status transition: to ${status}`)
      expect(text.stdout).not.toContain(TENANT)
      expect(text.stdout).not.toContain(CLIENT_ID)
    },
  )

  it('drives the update API path from the sealed ID and changes the digest when that ID changes', async () => {
    api.updateManualJournal.mockResolvedValue({body: {manualJournals: [{manualJournalID: JOURNAL_ID}]}})
    const path = updateFixture()
    const preview = await run(ManualJournalsUpdate, ['--json', '--file', path])
    const sealed = JSON.parse(preview.stdout) as {payload: Record<string, unknown>; payloadDigest: string}

    const changed = await run(ManualJournalsUpdate, [
      '--json',
      '--file',
      updateFixture({...sealed.payload, manualJournalID: `${JOURNAL_ID}-other`}),
    ])
    expect((JSON.parse(changed.stdout) as {payloadDigest: string}).payloadDigest).not.toBe(sealed.payloadDigest)

    const output = await run(ManualJournalsUpdate, ['--json', '--file', path, '--execute'])
    expect(output.error).toBeUndefined()
    expect(api.updateManualJournal).toHaveBeenCalledExactlyOnceWith(TENANT, JOURNAL_ID, {
      manualJournals: [sealed.payload],
    })
  })
})
