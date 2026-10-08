import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterAll, beforeEach, describe, expect, it, vi} from 'vitest'
import QuotesCreate from '../../src/commands/quotes/create.js'
import QuotesUpdate from '../../src/commands/quotes/update.js'
import {mutationCommandBoundaryTests, type CommandClass} from '../support/mutation-command-boundary.js'

const TENANT = 'synthetic-quote-tenant-must-not-echo'
const CLIENT_ID = 'synthetic-quote-client-must-not-echo'
const CREATE_ID = '00000000-0000-0000-0000-000000001320'
const UPDATE_ID = '00000000-0000-0000-0000-000000001321'

const api = vi.hoisted(() => ({createQuotes: vi.fn(), updateQuote: vi.fn(), getOrganisations: vi.fn()}))
const profile = vi.hoisted(() => ({
  name: 'synthetic-quote-profile',
  clientId: 'synthetic-quote-client-must-not-echo',
  resolves: 0,
}))
const targets = vi.hoisted(() => [] as Array<{profileName: string; clientId: string; xero: object}>)
const dispatchClients = vi.hoisted(() => [] as object[])
const lookupClients = vi.hoisted(() => [] as object[])
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
    const xero = {
      accountingApi: {
        createQuotes: (...args: unknown[]) => {
          dispatchClients.push(xero)
          return api.createQuotes(...args)
        },
        updateQuote: (...args: unknown[]) => {
          dispatchClients.push(xero)
          return api.updateQuote(...args)
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
      question: async () => {
        prompt.onQuestion?.()
        return prompt.answer
      },
      close: () => {},
    }
  },
}))

const root = mkdtempSync(join(tmpdir(), 'ledgerops-quote-gate-root-'))
const fixtures = mkdtempSync(join(tmpdir(), 'ledgerops-quote-gate-fixtures-'))
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
    contactID: 'synthetic-contact-132',
    title: 'Synthetic quote 132',
    reference: 'QTE-CREATE-132',
    lineItems: [{description: 'Synthetic quote line', quantity: 1, unitAmount: 13.2, accountCode: '200'}],
  },
): string {
  return fixture('create', data)
}

function updateFixture(
  data: unknown = {
    quoteID: UPDATE_ID,
    title: 'Synthetic quote 132 updated',
    reference: 'QTE-UPDATED-132',
    status: 'SENT',
  },
): string {
  return fixture('update', data)
}

async function run(command: CommandClass, args: readonly string[]) {
  const stdout: string[] = []
  const stderr: string[] = []
  const log = vi
    .spyOn(console, 'log')
    .mockImplementation((...values) => stdout.push(`${values.map(String).join(' ')}\n`))
  const errorLog = vi
    .spyOn(console, 'error')
    .mockImplementation((...values) => stderr.push(`${values.map(String).join(' ')}\n`))
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
  api.createQuotes.mockReset()
  api.updateQuote.mockReset()
  api.getOrganisations.mockReset().mockResolvedValue({body: {organisations: [{shortCode: 'synthetic-short-code'}]}})
  profile.name = 'synthetic-quote-profile'
  profile.clientId = CLIENT_ID
  profile.resolves = 0
  targets.length = 0
  dispatchClients.length = 0
  lookupClients.length = 0
  prompt.answer = 'YES'
  prompt.calls.length = 0
  prompt.onQuestion = undefined
})

describe('quotes create shared command boundary', () => {
  mutationCommandBoundaryTests({
    command: QuotesCreate,
    apiMethod: api.createQuotes,
    optionalLookup: api.getOrganisations,
    fixture: createFixture,
    expectedPreviewLiteral: 'create quotes',
    expectedResultLine: `Quote created: QU-0132 (${CREATE_ID})`,
    executeResponse: {body: {quotes: [{quoteID: CREATE_ID, quoteNumber: 'QU-0132'}]}},
    run,
    interactiveCalls: () => prompt.calls,
  })
})

describe('quotes update shared command boundary', () => {
  mutationCommandBoundaryTests({
    command: QuotesUpdate,
    apiMethod: api.updateQuote,
    fixture: updateFixture,
    expectedPreviewLiteral: 'update quotes',
    expectedResultLine: `Quote updated: QU-0133 (${UPDATE_ID})`,
    targetsExistingResource: true,
    executeResponse: {body: {quotes: [{quoteID: UPDATE_ID, quoteNumber: 'QU-0133', status: 'SENT'}]}},
    run,
    interactiveCalls: () => prompt.calls,
  })
})

describe.each([
  {name: 'create', command: QuotesCreate, apiMethod: api.createQuotes, fixture: createFixture, id: CREATE_ID},
  {name: 'update', command: QuotesUpdate, apiMethod: api.updateQuote, fixture: updateFixture, id: UPDATE_ID},
])('quotes $name target and confirmation safety', ({command, apiMethod, fixture: commandFixture, id}) => {
  it("requires the exact dual-TTY answer 'YES' and seals the pre-prompt profile", async () => {
    await dualTty(async () => {
      apiMethod.mockResolvedValue({body: {quotes: [{quoteID: id, quoteNumber: 'QU-0132'}]}})
      prompt.answer = 'y'
      const declined = await run(command, ['--file', commandFixture(), '--execute'])
      expect(declined.error?.message).toMatch(/declined/i)
      expect(apiMethod).not.toHaveBeenCalled()
      expect(prompt.calls[0]?.output).toBe(process.stderr)
      expect(declined.stderr).toContain('PENDING MUTATION')

      prompt.answer = ' YES '
      prompt.onQuestion = () => {
        profile.name = 'rotated-quote-profile'
        profile.clientId = 'rotated-quote-client'
      }
      profile.resolves = 0
      const accepted = await run(command, ['--file', commandFixture(), '--execute'])
      expect(accepted.error).toBeUndefined()
      expect(apiMethod).toHaveBeenCalledTimes(1)
      expect(profile.resolves).toBe(1)
      expect(targets.map(({profileName, clientId}) => ({profileName, clientId}))).toEqual([
        {profileName: 'synthetic-quote-profile', clientId: CLIENT_ID},
      ])
    })
  })

  it('resolves the target before validation and dispatches nothing for malformed input', async () => {
    const malformed = command === QuotesCreate ? createFixture({lineItems: []}) : updateFixture({title: 'missing ID'})
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

describe('quotes command-specific mutation records', () => {
  it('seals the create payload and binds the same dispatch client to organisation lookup', async () => {
    const path = createFixture()
    const preview = await run(QuotesCreate, ['--json', '--file', path])
    const sealed = JSON.parse(preview.stdout) as {payloadDigest: string; payload: Record<string, unknown>}
    expect(sealed.payload).toEqual(expect.objectContaining({title: 'Synthetic quote 132', reference: 'QTE-CREATE-132'}))
    expect(sealed.payload.contact).toEqual({contactID: 'synthetic-contact-132'})
    expect(sealed.payload).not.toHaveProperty('contactID')
    expect(sealed.payloadDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(preview.stdout).not.toContain(TENANT)
    expect(preview.stdout).not.toContain(CLIENT_ID)

    api.createQuotes.mockResolvedValue({body: {quotes: [{quoteID: CREATE_ID, quoteNumber: 'QU-0132'}]}})
    const output = await run(QuotesCreate, ['--file', path, '--execute'])
    expect(output.error).toBeUndefined()
    expect(api.createQuotes).toHaveBeenCalledExactlyOnceWith(TENANT, {quotes: [sealed.payload]})
    expect(api.getOrganisations).toHaveBeenCalledTimes(1)
    expect(dispatchClients).toHaveLength(1)
    expect(lookupClients).toEqual(dispatchClients)
    expect(targets).toHaveLength(1)
  })

  it('binds quoteID into the update digest and names changed fields and status', async () => {
    const path = updateFixture()
    const output = await run(QuotesUpdate, ['--json', '--file', path])
    const preview = JSON.parse(output.stdout) as {payloadDigest: string; payload: Record<string, unknown>}
    expect(preview.payload.quoteID).toBe(UPDATE_ID)
    expect(preview.payloadDigest).toMatch(/^sha256:[0-9a-f]{64}$/)

    const text = await run(QuotesUpdate, ['--file', path])
    expect(text.stdout).toContain(UPDATE_ID)
    expect(text.stdout).toContain('changed fields: title, reference, status')
    expect(text.stdout).toContain('status SENT')
    expect(text.stdout).not.toContain(TENANT)
    expect(text.stdout).not.toContain(CLIENT_ID)
  })

  it('drives the update API path from the sealed quoteID and binds it into the digest', async () => {
    api.updateQuote.mockResolvedValue({body: {quotes: [{quoteID: UPDATE_ID, quoteNumber: 'QU-0133'}]}})
    const path = updateFixture()
    const preview = await run(QuotesUpdate, ['--json', '--file', path])
    const sealed = JSON.parse(preview.stdout) as {payload: Record<string, unknown>; payloadDigest: string}

    const changed = await run(QuotesUpdate, [
      '--json',
      '--file',
      updateFixture({...sealed.payload, quoteID: `${UPDATE_ID}-other`}),
    ])
    expect((JSON.parse(changed.stdout) as {payloadDigest: string}).payloadDigest).not.toBe(sealed.payloadDigest)

    const output = await run(QuotesUpdate, ['--json', '--file', path, '--execute'])
    expect(output.error).toBeUndefined()
    expect(api.updateQuote).toHaveBeenCalledExactlyOnceWith(TENANT, UPDATE_ID, {quotes: [sealed.payload]})
  })

  it('does not redispatch create when the post-write organisation lookup fails', async () => {
    api.createQuotes.mockResolvedValue({body: {quotes: [{quoteID: CREATE_ID, quoteNumber: 'QU-0132'}]}})
    api.getOrganisations.mockRejectedValue(new Error('synthetic lookup failure'))
    const output = await run(QuotesCreate, [
      '--contact-id',
      'synthetic-contact-132',
      '--title',
      'Synthetic quote 132',
      '--description',
      'Synthetic quote line',
      '--quantity',
      '1',
      '--unit-amount',
      '13.2',
      '--account-code',
      '200',
      '--tax-type',
      'OUTPUT',
      '--execute',
    ])
    expect(output.error).toBeUndefined()
    expect(api.createQuotes).toHaveBeenCalledTimes(1)
    expect(api.getOrganisations).toHaveBeenCalledTimes(1)
    expect(targets).toHaveLength(1)
    expect(output.stdout).toContain(`Quote created: QU-0132 (${CREATE_ID})`)
    expect(output.stdout).not.toContain('View in Xero:')
  })
})
