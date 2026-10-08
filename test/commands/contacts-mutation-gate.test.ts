import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterAll, beforeEach, describe, expect, it, vi} from 'vitest'
import ContactsCreate from '../../src/commands/contacts/create.js'
import ContactsUpdate from '../../src/commands/contacts/update.js'
import {mutationCommandBoundaryTests, type CommandClass} from '../support/mutation-command-boundary.js'

const TENANT = 'synthetic-contact-tenant-must-not-echo'
const CLIENT_ID = 'synthetic-contact-client-must-not-echo'
const CONTACT_ID = '00000000-0000-0000-0000-000000001270'

const api = vi.hoisted(() => ({
  createContacts: vi.fn(),
  updateContact: vi.fn(),
  getOrganisations: vi.fn(),
}))
const profile = vi.hoisted(() => ({
  name: 'synthetic-contact-profile',
  clientId: 'synthetic-contact-client-must-not-echo',
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
        createContacts: (...args: unknown[]) => {
          dispatchClients.push(xero)
          return api.createContacts(...args)
        },
        updateContact: (...args: unknown[]) => {
          dispatchClients.push(xero)
          return api.updateContact(...args)
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

const root = mkdtempSync(join(tmpdir(), 'ledgerops-contact-gate-root-'))
const fixtures = mkdtempSync(join(tmpdir(), 'ledgerops-contact-gate-fixtures-'))
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
  data: unknown = {name: 'Synthetic Contact 127', emailAddress: 'contact-127@example.invalid'},
): string {
  return fixture('create', data)
}

function updateFixture(
  data: unknown = {contactID: CONTACT_ID, name: 'Synthetic Contact Updated', contactStatus: 'ARCHIVED'},
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
  api.createContacts.mockReset()
  api.updateContact.mockReset()
  api.getOrganisations.mockReset().mockResolvedValue({body: {organisations: [{shortCode: 'synthetic-short-code'}]}})
  profile.name = 'synthetic-contact-profile'
  profile.clientId = CLIENT_ID
  profile.resolves = 0
  targets.length = 0
  dispatchClients.length = 0
  lookupClients.length = 0
  prompt.answer = 'YES'
  prompt.calls.length = 0
  prompt.onQuestion = undefined
})

describe('contacts create shared command boundary', () => {
  mutationCommandBoundaryTests({
    command: ContactsCreate,
    apiMethod: api.createContacts,
    optionalLookup: api.getOrganisations,
    fixture: createFixture,
    expectedPreviewLiteral: 'create contacts',
    expectedResultLine: `Contact created: Synthetic Contact 127 (${CONTACT_ID})`,
    executeResponse: {body: {contacts: [{contactID: CONTACT_ID, name: 'Synthetic Contact 127'}]}},
    run,
    interactiveCalls: () => prompt.calls,
  })
})

describe('contacts update shared command boundary', () => {
  mutationCommandBoundaryTests({
    command: ContactsUpdate,
    apiMethod: api.updateContact,
    fixture: updateFixture,
    expectedPreviewLiteral: 'update contacts',
    expectedResultLine: `Contact updated: Synthetic Contact Updated (${CONTACT_ID})`,
    targetsExistingResource: true,
    executeResponse: {
      body: {contacts: [{contactID: CONTACT_ID, name: 'Synthetic Contact Updated', contactStatus: 'ARCHIVED'}]},
    },
    run,
    interactiveCalls: () => prompt.calls,
  })
})

describe.each([
  {name: 'create', command: ContactsCreate, apiMethod: api.createContacts, fixture: createFixture},
  {name: 'update', command: ContactsUpdate, apiMethod: api.updateContact, fixture: updateFixture},
])('contacts $name target and confirmation safety', ({command, apiMethod, fixture: commandFixture}) => {
  it("requires the exact dual-TTY answer 'YES' and seals the pre-prompt profile", async () => {
    await dualTty(async () => {
      apiMethod.mockResolvedValue({body: {contacts: [{contactID: CONTACT_ID, name: 'Synthetic Contact 127'}]}})
      prompt.answer = 'y'
      const declined = await run(command, ['--file', commandFixture(), '--execute'])
      expect(declined.error?.message).toMatch(/declined/i)
      expect(apiMethod).not.toHaveBeenCalled()
      expect(prompt.calls[0]?.output).toBe(process.stderr)
      expect(declined.stderr).toContain('PENDING MUTATION')

      prompt.answer = ' YES '
      prompt.onQuestion = () => {
        profile.name = 'rotated-contact-profile'
        profile.clientId = 'rotated-contact-client'
      }
      profile.resolves = 0
      const accepted = await run(command, ['--file', commandFixture(), '--execute'])
      expect(accepted.error).toBeUndefined()
      expect(apiMethod).toHaveBeenCalledTimes(1)
      expect(profile.resolves).toBe(1)
      expect(targets.map(({profileName, clientId}) => ({profileName, clientId}))).toEqual([
        {profileName: 'synthetic-contact-profile', clientId: CLIENT_ID},
      ])
    })
  })

  it('resolves the target before validation and dispatches nothing for malformed input', async () => {
    const malformed =
      command === ContactsCreate
        ? createFixture({emailAddress: 'missing-name@example.invalid'})
        : updateFixture({name: 'missing contact ID'})
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

describe('contacts command-specific mutation records', () => {
  it('seals the create payload and keeps target secrets out of previews', async () => {
    const output = await run(ContactsCreate, ['--json', '--file', createFixture()])
    const preview = JSON.parse(output.stdout) as {payloadDigest: string; payload: Record<string, unknown>}
    expect(preview.payload).toEqual({name: 'Synthetic Contact 127', emailAddress: 'contact-127@example.invalid'})
    expect(preview.payloadDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(output.stdout).not.toContain(TENANT)
    expect(output.stdout).not.toContain(CLIENT_ID)
  })

  it('binds the update path ID into the record and digest, and names fields and status', async () => {
    const path = updateFixture()
    const output = await run(ContactsUpdate, ['--json', '--file', path])
    const preview = JSON.parse(output.stdout) as {payloadDigest: string; payload: Record<string, unknown>}
    expect(preview.payload.contactID).toBe(CONTACT_ID)
    expect(preview.payloadDigest).toMatch(/^sha256:[0-9a-f]{64}$/)

    const text = await run(ContactsUpdate, ['--file', path])
    expect(text.stdout).toContain(CONTACT_ID)
    expect(text.stdout).toContain('changed fields: name, contactStatus')
    expect(text.stdout).toContain('status ARCHIVED')
    expect(text.stdout).not.toContain(TENANT)
    expect(text.stdout).not.toContain(CLIENT_ID)
  })

  it('drives the update API path from the sealed record ID and binds it into the digest', async () => {
    api.updateContact.mockResolvedValue({
      body: {contacts: [{contactID: CONTACT_ID, name: 'Synthetic Contact Updated'}]},
    })
    const path = updateFixture()
    const preview = await run(ContactsUpdate, ['--json', '--file', path])
    const sealed = JSON.parse(preview.stdout) as {payload: Record<string, unknown>; payloadDigest: string}

    const changed = await run(ContactsUpdate, [
      '--json',
      '--file',
      updateFixture({...sealed.payload, contactID: `${CONTACT_ID}-other`}),
    ])
    expect((JSON.parse(changed.stdout) as {payloadDigest: string}).payloadDigest).not.toBe(sealed.payloadDigest)

    const output = await run(ContactsUpdate, ['--json', '--file', path, '--execute'])
    expect(output.error).toBeUndefined()
    expect(api.updateContact).toHaveBeenCalledExactlyOnceWith(TENANT, CONTACT_ID, {contacts: [sealed.payload]})
  })

  it('uses the sealed dispatch client for the post-write organisation lookup and renders the contact URL', async () => {
    api.createContacts.mockResolvedValue({body: {contacts: [{contactID: CONTACT_ID, name: 'Synthetic Contact 127'}]}})
    const output = await run(ContactsCreate, ['--file', createFixture(), '--execute'])
    expect(output.error).toBeUndefined()
    expect(api.createContacts).toHaveBeenCalledTimes(1)
    expect(api.getOrganisations).toHaveBeenCalledTimes(1)
    expect(dispatchClients).toHaveLength(1)
    expect(lookupClients).toEqual(dispatchClients)
    expect(targets).toHaveLength(1)
    expect(output.stdout).toContain(`https://go.xero.com/app/synthetic-short-code/contacts/contact/${CONTACT_ID}`)
  })

  it('does not retry or redispatch a successful mutation when the short-code lookup fails', async () => {
    api.createContacts.mockResolvedValue({body: {contacts: [{contactID: CONTACT_ID, name: 'Synthetic Contact 127'}]}})
    api.getOrganisations.mockRejectedValue(new Error('synthetic lookup failure'))
    const output = await run(ContactsCreate, ['--file', createFixture(), '--execute'])
    expect(output.error).toBeUndefined()
    expect(api.createContacts).toHaveBeenCalledTimes(1)
    expect(api.getOrganisations).toHaveBeenCalledTimes(1)
    expect(targets).toHaveLength(1)
    expect(output.stdout).toContain(`Contact created: Synthetic Contact 127 (${CONTACT_ID})`)
    expect(output.stdout).not.toContain('View in Xero:')
  })
})
