import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterAll, beforeEach, describe, expect, it, vi} from 'vitest'
import CreditNotesCreate from '../../src/commands/credit-notes/create.js'
import CreditNotesUpdate from '../../src/commands/credit-notes/update.js'
import {type CommandClass, mutationCommandBoundaryTests} from '../support/mutation-command-boundary.js'

const TENANT = 'synthetic-credit-note-tenant-must-not-echo'
const CLIENT_ID = 'synthetic-credit-note-client-must-not-echo'
const CREATE_ID = '00000000-0000-0000-0000-000000001280'
const UPDATE_ID = '00000000-0000-0000-0000-000000001281'

const api = vi.hoisted(() => ({
  createCreditNotes: vi.fn(),
  updateCreditNote: vi.fn(),
  getOrganisations: vi.fn(),
}))
const profile = vi.hoisted(() => ({
  name: 'synthetic-credit-note-profile',
  clientId: 'synthetic-credit-note-client-must-not-echo',
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
        createCreditNotes: (...args: unknown[]) => {
          dispatchClients.push(xero)
          return api.createCreditNotes(...args)
        },
        updateCreditNote: (...args: unknown[]) => {
          dispatchClients.push(xero)
          return api.updateCreditNote(...args)
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

const root = mkdtempSync(join(tmpdir(), 'ledgerops-credit-note-gate-root-'))
const fixtures = mkdtempSync(join(tmpdir(), 'ledgerops-credit-note-gate-fixtures-'))
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
    type: 'ACCPAYCREDIT',
    contactID: 'synthetic-contact-128',
    reference: 'CN-CREATE-128',
    lineItems: [{description: 'Synthetic credit', quantity: 1, unitAmount: 12.8, accountCode: '429'}],
  },
): string {
  return fixture('create', data)
}

function updateFixture(
  data: unknown = {
    creditNoteID: UPDATE_ID,
    reference: 'CN-UPDATED-128',
    status: 'VOIDED',
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
  api.createCreditNotes.mockReset()
  api.updateCreditNote.mockReset()
  api.getOrganisations.mockReset().mockResolvedValue({body: {organisations: [{shortCode: 'synthetic-short-code'}]}})
  profile.name = 'synthetic-credit-note-profile'
  profile.clientId = CLIENT_ID
  profile.resolves = 0
  targets.length = 0
  dispatchClients.length = 0
  lookupClients.length = 0
  prompt.answer = 'YES'
  prompt.calls.length = 0
  prompt.onQuestion = undefined
})

describe('credit-notes create shared command boundary', () => {
  mutationCommandBoundaryTests({
    command: CreditNotesCreate,
    apiMethod: api.createCreditNotes,
    optionalLookup: api.getOrganisations,
    fixture: createFixture,
    expectedPreviewLiteral: 'create credit-notes',
    expectedResultLine: `Credit note created: CN-0128 (${CREATE_ID})`,
    executeResponse: {body: {creditNotes: [{creditNoteID: CREATE_ID, creditNoteNumber: 'CN-0128'}]}},
    run,
    interactiveCalls: () => prompt.calls,
  })
})

describe('credit-notes update shared command boundary', () => {
  mutationCommandBoundaryTests({
    command: CreditNotesUpdate,
    apiMethod: api.updateCreditNote,
    fixture: updateFixture,
    expectedPreviewLiteral: 'update credit-notes',
    expectedResultLine: `Credit note updated: CN-0129 (${UPDATE_ID})`,
    executeResponse: {
      body: {creditNotes: [{creditNoteID: UPDATE_ID, creditNoteNumber: 'CN-0129', status: 'VOIDED'}]},
    },
    run,
    interactiveCalls: () => prompt.calls,
  })
})

describe.each([
  {name: 'create', command: CreditNotesCreate, apiMethod: api.createCreditNotes, fixture: createFixture},
  {name: 'update', command: CreditNotesUpdate, apiMethod: api.updateCreditNote, fixture: updateFixture},
])('credit-notes $name target and confirmation safety', ({command, apiMethod, fixture: commandFixture}) => {
  it("requires the exact dual-TTY answer 'YES' and seals the pre-prompt profile", async () => {
    await dualTty(async () => {
      apiMethod.mockResolvedValue({body: {creditNotes: [{creditNoteID: CREATE_ID, creditNoteNumber: 'CN-0128'}]}})
      prompt.answer = 'y'
      const declined = await run(command, ['--file', commandFixture(), '--execute'])
      expect(declined.error?.message).toMatch(/declined/i)
      expect(apiMethod).not.toHaveBeenCalled()
      expect(prompt.calls[0]?.output).toBe(process.stderr)
      expect(declined.stderr).toContain('PENDING MUTATION')

      prompt.answer = ' YES '
      prompt.onQuestion = () => {
        profile.name = 'rotated-credit-note-profile'
        profile.clientId = 'rotated-credit-note-client'
      }
      profile.resolves = 0
      const accepted = await run(command, ['--file', commandFixture(), '--execute'])
      expect(accepted.error).toBeUndefined()
      expect(apiMethod).toHaveBeenCalledTimes(1)
      expect(profile.resolves).toBe(1)
      expect(targets.map(({profileName, clientId}) => ({profileName, clientId}))).toEqual([
        {profileName: 'synthetic-credit-note-profile', clientId: CLIENT_ID},
      ])
    })
  })

  it('resolves the target before validation and dispatches nothing for malformed input', async () => {
    const malformed =
      command === CreditNotesCreate ? createFixture({lineItems: []}) : updateFixture({reference: 'missing path ID'})
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

describe('credit-notes command-specific mutation records', () => {
  it('seals the create payload and keeps target secrets out of previews', async () => {
    const output = await run(CreditNotesCreate, ['--json', '--file', createFixture()])
    const preview = JSON.parse(output.stdout) as {payloadDigest: string; payload: Record<string, unknown>}
    expect(preview.payload).toEqual(expect.objectContaining({type: 'ACCPAYCREDIT', reference: 'CN-CREATE-128'}))
    expect(preview.payload.contact).toEqual({contactID: 'synthetic-contact-128'})
    expect(preview.payload).not.toHaveProperty('contactID')
    expect(preview.payloadDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(output.stdout).not.toContain(TENANT)
    expect(output.stdout).not.toContain(CLIENT_ID)
  })

  it('binds the update path ID into the record and digest, and names fields and status', async () => {
    const path = updateFixture()
    const output = await run(CreditNotesUpdate, ['--json', '--file', path])
    const preview = JSON.parse(output.stdout) as {payloadDigest: string; payload: Record<string, unknown>}
    expect(preview.payload.creditNoteID).toBe(UPDATE_ID)
    expect(preview.payloadDigest).toMatch(/^sha256:[0-9a-f]{64}$/)

    const text = await run(CreditNotesUpdate, ['--file', path])
    expect(text.stdout).toContain(UPDATE_ID)
    expect(text.stdout).toContain('changed fields: reference, status')
    expect(text.stdout).toContain('status VOIDED')
    expect(text.stdout).not.toContain(TENANT)
    expect(text.stdout).not.toContain(CLIENT_ID)
  })

  it('drives the update API path from the sealed record ID and binds it into the digest', async () => {
    api.updateCreditNote.mockResolvedValue({
      body: {creditNotes: [{creditNoteID: UPDATE_ID, creditNoteNumber: 'CN-0129'}]},
    })
    const file = updateFixture()
    const preview = await run(CreditNotesUpdate, ['--json', '--file', file])
    const sealed = JSON.parse(preview.stdout) as {payload: Record<string, unknown>; payloadDigest: string}

    const changed = await run(CreditNotesUpdate, [
      '--json',
      '--file',
      updateFixture({...sealed.payload, creditNoteID: `${UPDATE_ID}-other`}),
    ])
    expect((JSON.parse(changed.stdout) as {payloadDigest: string}).payloadDigest).not.toBe(sealed.payloadDigest)

    const output = await run(CreditNotesUpdate, ['--json', '--file', file, '--execute'])
    expect(output.error).toBeUndefined()
    expect(api.updateCreditNote).toHaveBeenCalledExactlyOnceWith(TENANT, UPDATE_ID, {creditNotes: [sealed.payload]})
  })

  it('uses the sealed dispatch client for the post-write organisation lookup', async () => {
    api.createCreditNotes.mockResolvedValue({
      body: {creditNotes: [{creditNoteID: CREATE_ID, creditNoteNumber: 'CN-0128'}]},
    })
    const output = await run(CreditNotesCreate, ['--file', createFixture(), '--execute'])
    expect(output.error).toBeUndefined()
    expect(api.createCreditNotes).toHaveBeenCalledTimes(1)
    expect(api.getOrganisations).toHaveBeenCalledTimes(1)
    expect(dispatchClients).toHaveLength(1)
    expect(lookupClients).toEqual(dispatchClients)
    expect(targets).toHaveLength(1)
  })

  it('preserves inline create dispatch and does not retry when the short-code lookup fails', async () => {
    api.createCreditNotes.mockResolvedValue({
      body: {creditNotes: [{creditNoteID: CREATE_ID, creditNoteNumber: 'CN-0128'}]},
    })
    api.getOrganisations.mockRejectedValue(new Error('synthetic lookup failure'))
    const output = await run(CreditNotesCreate, [
      '--contact-id',
      'synthetic-contact-128',
      '--description',
      'Synthetic credit',
      '--quantity',
      '1',
      '--unit-amount',
      '12.8',
      '--account-code',
      '429',
      '--tax-type',
      'NONE',
      '--execute',
    ])
    expect(output.error).toBeUndefined()
    expect(api.createCreditNotes).toHaveBeenCalledTimes(1)
    expect(api.getOrganisations).toHaveBeenCalledTimes(1)
    expect(targets).toHaveLength(1)
    expect(output.stdout).toContain(`Credit note created: CN-0128 (${CREATE_ID})`)
    expect(output.stdout).not.toContain('View in Xero:')
  })
})
