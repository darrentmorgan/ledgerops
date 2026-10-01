import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {default as ContactsGet} from '../../src/commands/contacts/get.js'

/**
 * Command-boundary coverage for `ledgerops contacts get` (issue #102, CON-29).
 *
 * Everything is offline and synthetic: the live Xero client is replaced with
 * an injected fake accountingApi, so assertions about which selector reached
 * Xero (and what came back) are exact rather than inferred.
 */

const TENANT = 'synthetic-contacts-get-tenant-must-not-echo'

const api = vi.hoisted(() => ({
  getContact: vi.fn(),
}))

const profileConfig = vi.hoisted(() => ({
  defaultProfile: 'synthetic-contacts-get-profile',
  clientId: 'synthetic-contacts-get-client-id',
}))

const seenTargets = vi.hoisted(() => [] as {profileName: string; clientId: string}[])
const seenIdentifiers = vi.hoisted(() => [] as string[])

vi.mock('../../src/lib/profiles.js', () => ({
  getDefaultProfile: () => profileConfig.defaultProfile,
  getProfileClientId: () => profileConfig.clientId,
}))

vi.mock('../../src/lib/xero-client.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/lib/xero-client.js')>()
  const fakeCreateClient = async (profileName: string, clientId: string) => {
    seenTargets.push({profileName, clientId})
    return {
      xero: {
        accountingApi: {
          getContact: (tenantId: string, contactId: string) => {
            seenIdentifiers.push(contactId)
            return api.getContact(tenantId, contactId)
          },
        },
      },
      tenantId: TENANT,
    }
  }
  return {
    ...actual,
    createXeroClient: fakeCreateClient,
    withRetry: (
      profileName: string,
      clientId: string,
      operation: (client: unknown, tenantId: string) => Promise<unknown>,
    ) => actual.withRetry(profileName, clientId, operation, 2, {createClient: fakeCreateClient}),
  }
})

const CLI_ROOT = mkdtempSync(join(tmpdir(), 'ledgerops-contacts-get-cli-'))
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

afterAll(() => {
  rmSync(CLI_ROOT, {recursive: true, force: true})
})

beforeEach(() => {
  api.getContact.mockReset()
  seenTargets.length = 0
  seenIdentifiers.length = 0
})

async function runCommand(
  command: {run(args?: string[], config?: {root: string}): Promise<unknown>},
  args: readonly string[],
) {
  const stdout: string[] = []
  const stderr: string[] = []
  const previousExitCode = process.exitCode
  const consoleLog = vi.spyOn(console, 'log').mockImplementation((...logged: unknown[]) => {
    stdout.push(`${logged.map(String).join(' ')}\n`)
  })
  const consoleError = vi.spyOn(console, 'error').mockImplementation((...logged: unknown[]) => {
    stderr.push(`${logged.map(String).join(' ')}\n`)
  })
  let error: Error | undefined
  process.exitCode = undefined
  try {
    await command.run([...args], {root: CLI_ROOT})
  } catch (caught) {
    error = caught instanceof Error ? caught : new Error(String(caught))
  } finally {
    consoleLog.mockRestore()
    consoleError.mockRestore()
    process.exitCode = previousExitCode
  }
  return {error, stdout: stdout.join(''), stderr: stderr.join('')}
}

const CONTACT_ID = '00000000-0000-0000-0000-00000000aaa1'
const CONTACT_NUMBER = 'CN001'

const SYNTHETIC_CONTACT = {
  contactID: CONTACT_ID,
  contactNumber: CONTACT_NUMBER,
  name: 'Acme Ltd',
  emailAddress: 'billing@acme.example',
  contactStatus: 'ACTIVE',
  balances: {
    accountsReceivable: {outstanding: 1250.5, overdue: 0},
    accountsPayable: {outstanding: 0, overdue: 0},
  },
  phones: [{phoneType: 'DEFAULT', phoneNumber: '5551234', phoneAreaCode: '02', phoneCountryCode: '61'}],
  addresses: [{addressType: 'STREET', addressLine1: '1 Example St', city: 'Sydney', country: 'Australia'}],
}

describe('contacts get selector validation', () => {
  it('requires exactly one selector: fails with neither --contact-id nor --contact-number', async () => {
    const {error, stderr} = await runCommand(ContactsGet, [])

    expect(error).toBeDefined()
    expect(process.exitCode).not.toBe(0)
    expect(stderr + (error?.message ?? '')).toMatch(/exactly one/i)
    expect(api.getContact).not.toHaveBeenCalled()
  })

  it('requires exactly one selector: fails when both --contact-id and --contact-number are set', async () => {
    const {error} = await runCommand(ContactsGet, ['--contact-id', CONTACT_ID, '--contact-number', CONTACT_NUMBER])

    expect(error).toBeDefined()
    expect(error?.message).toMatch(/exactly one/i)
    expect(api.getContact).not.toHaveBeenCalled()
  })
})

describe('contacts get selectors', () => {
  it('fetches by --contact-id', async () => {
    api.getContact.mockResolvedValue({body: {contacts: [SYNTHETIC_CONTACT]}})

    const {error, stdout} = await runCommand(ContactsGet, ['--contact-id', CONTACT_ID, '--json'])

    expect(error).toBeUndefined()
    expect(seenIdentifiers).toEqual([CONTACT_ID])
    expect(seenTargets).toEqual([{profileName: profileConfig.defaultProfile, clientId: profileConfig.clientId}])
    const parsed = JSON.parse(stdout)
    expect(parsed.contactID).toBe(CONTACT_ID)
  })

  it('fetches by --contact-number', async () => {
    api.getContact.mockResolvedValue({body: {contacts: [SYNTHETIC_CONTACT]}})

    const {error} = await runCommand(ContactsGet, ['--contact-number', CONTACT_NUMBER, '--json'])

    expect(error).toBeUndefined()
    expect(seenIdentifiers).toEqual([CONTACT_NUMBER])
  })
})

describe('contacts get output', () => {
  it('--json returns the full Contact object including balances, phones, addresses', async () => {
    api.getContact.mockResolvedValue({body: {contacts: [SYNTHETIC_CONTACT]}})

    const {stdout} = await runCommand(ContactsGet, ['--contact-id', CONTACT_ID, '--json'])

    const parsed = JSON.parse(stdout)
    expect(parsed).toMatchObject({
      contactID: CONTACT_ID,
      balances: SYNTHETIC_CONTACT.balances,
      phones: SYNTHETIC_CONTACT.phones,
      addresses: SYNTHETIC_CONTACT.addresses,
    })
  })

  it('renders a human table with columns consistent with contacts list', async () => {
    api.getContact.mockResolvedValue({body: {contacts: [SYNTHETIC_CONTACT]}})

    const {stdout} = await runCommand(ContactsGet, ['--contact-id', CONTACT_ID])

    expect(stdout).toContain(CONTACT_ID)
    expect(stdout).toContain('Acme Ltd')
    expect(stdout).toContain('billing@acme.example')
  })

  it('maps a 404 from Xero to a not-found error', async () => {
    const notFound = new Error(JSON.stringify({response: {statusCode: 404, body: {Message: 'Contact not found'}}}))
    api.getContact.mockRejectedValue(notFound)

    const {error} = await runCommand(ContactsGet, ['--contact-id', CONTACT_ID])

    expect(error).toBeDefined()
    expect(error?.message).toMatch(/not found/i)
  })
})
