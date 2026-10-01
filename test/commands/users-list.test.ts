import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {default as UsersList} from '../../src/commands/users/list.js'

/**
 * Command-boundary coverage for `ledgerops users list` (issue #103, packet USR-23).
 *
 * Offline and synthetic throughout: the live Xero client is replaced with an
 * injected fake so both `getUsers` and `getUser` are exercised without any
 * real network call, token, or tenant data.
 */

const TENANT = 'synthetic-users-tenant-must-not-echo'

const api = vi.hoisted(() => ({
  getUsers: vi.fn(),
  getUser: vi.fn(),
}))

const profileConfig = vi.hoisted(() => ({
  defaultProfile: 'synthetic-users-profile',
  clientId: 'synthetic-users-client-id',
}))

vi.mock('../../src/lib/profiles.js', () => ({
  getDefaultProfile: () => profileConfig.defaultProfile,
  getProfileClientId: () => profileConfig.clientId,
}))

vi.mock('../../src/lib/xero-client.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/lib/xero-client.js')>()
  const fakeCreateClient = async (_profileName: string, _clientId: string) => ({
    xero: {
      accountingApi: {
        getUsers: api.getUsers,
        getUser: api.getUser,
      },
    },
    tenantId: TENANT,
  })
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

const CLI_ROOT = mkdtempSync(join(tmpdir(), 'ledgerops-users-list-cli-'))
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
  api.getUsers.mockReset()
  api.getUser.mockReset()
})

async function runList(args: readonly string[]) {
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
    await UsersList.run([...args], {root: CLI_ROOT})
  } catch (caught) {
    error = caught instanceof Error ? caught : new Error(String(caught))
  } finally {
    consoleLog.mockRestore()
    consoleError.mockRestore()
    process.exitCode = previousExitCode
  }
  return {error, stdout: stdout.join(''), stderr: stderr.join('')}
}

const USER_ONE = {
  userID: '00000000-0000-0000-0000-00000000u001',
  emailAddress: 'alice@example-synthetic.test',
  firstName: 'Alice',
  lastName: 'Anderson',
  isSubscriber: true,
  organisationRole: 'STANDARD',
}

const USER_TWO = {
  userID: '00000000-0000-0000-0000-00000000u002',
  emailAddress: 'bob@example-synthetic.test',
  firstName: 'Bob',
  lastName: 'Baker',
  isSubscriber: false,
  organisationRole: 'READONLY',
}

describe('users list command boundary', () => {
  it('renders the fixture table of tenant users', async () => {
    api.getUsers.mockResolvedValue({body: {users: [USER_ONE, USER_TWO]}})

    const output = await runList([])

    expect(output.error).toBeUndefined()
    expect(api.getUsers).toHaveBeenCalledTimes(1)
    expect(output.stdout).toContain('Alice Anderson')
    expect(output.stdout).toContain('alice@example-synthetic.test')
    expect(output.stdout).toContain('Bob Baker')
    expect(output.stdout).toContain('bob@example-synthetic.test')
    expect(output.stdout).not.toContain(TENANT)
  })

  it('calls getUser and renders a single row when --user-id is given', async () => {
    api.getUser.mockResolvedValue({body: {users: [USER_ONE]}})

    const output = await runList(['--user-id', USER_ONE.userID])

    expect(output.error).toBeUndefined()
    expect(api.getUser).toHaveBeenCalledTimes(1)
    expect(api.getUser).toHaveBeenCalledWith(TENANT, USER_ONE.userID)
    expect(api.getUsers).not.toHaveBeenCalled()
    expect(output.stdout).toContain('Alice Anderson')
    expect(output.stdout).not.toContain('Bob Baker')
  })

  it('returns full User objects with --json', async () => {
    api.getUsers.mockResolvedValue({body: {users: [USER_ONE, USER_TWO]}})

    const output = await runList(['--json'])

    expect(output.error).toBeUndefined()
    const printed = JSON.parse(output.stdout) as unknown[]
    expect(printed).toEqual([USER_ONE, USER_TWO])
  })
})
