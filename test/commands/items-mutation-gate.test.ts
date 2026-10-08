import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterAll, beforeEach, describe, expect, it, vi} from 'vitest'
import ItemsCreate from '../../src/commands/items/create.js'
import ItemsUpdate from '../../src/commands/items/update.js'
import {mutationCommandBoundaryTests, type CommandClass} from '../support/mutation-command-boundary.js'

const TENANT = 'synthetic-item-tenant-must-not-echo'
const CLIENT_ID = 'synthetic-item-client-must-not-echo'
const ITEM_ID = '00000000-0000-0000-0000-000000001300'

const api = vi.hoisted(() => ({createItems: vi.fn(), updateItem: vi.fn()}))
const profile = vi.hoisted(() => ({
  name: 'synthetic-item-profile',
  clientId: 'synthetic-item-client-must-not-echo',
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
    return {
      xero: {accountingApi: {createItems: api.createItems, updateItem: api.updateItem}},
      tenantId: TENANT,
    }
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

const root = mkdtempSync(join(tmpdir(), 'ledgerops-item-gate-root-'))
const fixtures = mkdtempSync(join(tmpdir(), 'ledgerops-item-gate-fixtures-'))
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
    code: 'ITEM-130',
    name: 'Synthetic Item 130',
    description: 'Synthetic item create',
    salesDetails: {unitPrice: 13, accountCode: '200'},
  },
): string {
  return fixture('create', data)
}

function updateFixture(
  data: unknown = {
    itemID: ITEM_ID,
    code: 'ITEM-130-UPDATED',
    name: 'Synthetic Item Updated',
    purchaseDetails: {unitPrice: 6.5, accountCode: '300'},
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
  api.createItems.mockReset()
  api.updateItem.mockReset()
  profile.name = 'synthetic-item-profile'
  profile.clientId = CLIENT_ID
  profile.resolves = 0
  targets.length = 0
  prompt.answer = 'YES'
  prompt.calls.length = 0
  prompt.onQuestion = undefined
})

describe('items create shared command boundary', () => {
  mutationCommandBoundaryTests({
    command: ItemsCreate,
    apiMethod: api.createItems,
    fixture: createFixture,
    expectedPreviewLiteral: 'create items',
    expectedResultLine: `Item created: ITEM-130 - Synthetic Item 130 (${ITEM_ID})`,
    executeResponse: {body: {items: [{itemID: ITEM_ID, code: 'ITEM-130', name: 'Synthetic Item 130'}]}},
    run,
    interactiveCalls: () => prompt.calls,
  })
})

describe('items update shared command boundary', () => {
  mutationCommandBoundaryTests({
    command: ItemsUpdate,
    apiMethod: api.updateItem,
    fixture: updateFixture,
    expectedPreviewLiteral: 'update items',
    expectedResultLine: `Item updated: ITEM-130-UPDATED - Synthetic Item Updated (${ITEM_ID})`,
    targetsExistingResource: true,
    executeResponse: {body: {items: [{itemID: ITEM_ID, code: 'ITEM-130-UPDATED', name: 'Synthetic Item Updated'}]}},
    run,
    interactiveCalls: () => prompt.calls,
  })
})

describe.each([
  {name: 'create', command: ItemsCreate, apiMethod: api.createItems, fixture: createFixture},
  {name: 'update', command: ItemsUpdate, apiMethod: api.updateItem, fixture: updateFixture},
])('items $name target and confirmation safety', ({command, apiMethod, fixture: commandFixture}) => {
  it("requires the exact dual-TTY answer 'YES' and seals the pre-prompt profile", async () => {
    await dualTty(async () => {
      apiMethod.mockResolvedValue({body: {items: [{itemID: ITEM_ID, code: 'ITEM-130', name: 'Synthetic Item 130'}]}})
      prompt.answer = 'y'
      const declined = await run(command, ['--file', commandFixture(), '--execute'])
      expect(declined.error?.message).toMatch(/declined/i)
      expect(apiMethod).not.toHaveBeenCalled()
      expect(prompt.calls[0]?.output).toBe(process.stderr)
      expect(declined.stderr).toContain('PENDING MUTATION')

      prompt.answer = ' YES '
      prompt.onQuestion = () => {
        profile.name = 'rotated-item-profile'
        profile.clientId = 'rotated-item-client'
      }
      profile.resolves = 0
      const accepted = await run(command, ['--file', commandFixture(), '--execute'])
      expect(accepted.error).toBeUndefined()
      expect(apiMethod).toHaveBeenCalledTimes(1)
      expect(profile.resolves).toBe(1)
      expect(targets).toEqual([{profileName: 'synthetic-item-profile', clientId: CLIENT_ID}])
    })
  })

  it('resolves the target before validation and dispatches nothing for malformed input', async () => {
    const malformed =
      command === ItemsCreate ? createFixture({name: 'missing code'}) : updateFixture({name: 'missing item ID'})
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

describe('items command-specific mutation records', () => {
  it('seals the create payload and keeps target secrets out of previews', async () => {
    const output = await run(ItemsCreate, ['--json', '--file', createFixture()])
    const preview = JSON.parse(output.stdout) as {payloadDigest: string; payload: Record<string, unknown>}
    expect(preview.payload).toEqual({
      code: 'ITEM-130',
      name: 'Synthetic Item 130',
      description: 'Synthetic item create',
      salesDetails: {unitPrice: 13, accountCode: '200'},
    })
    expect(preview.payloadDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(output.stdout).not.toContain(TENANT)
    expect(output.stdout).not.toContain(CLIENT_ID)
  })

  it('binds the update path ID into the record and digest, and names changed fields', async () => {
    const path = updateFixture()
    const output = await run(ItemsUpdate, ['--json', '--file', path])
    const preview = JSON.parse(output.stdout) as {payloadDigest: string; payload: Record<string, unknown>}
    expect(preview.payload.itemID).toBe(ITEM_ID)
    expect(preview.payloadDigest).toMatch(/^sha256:[0-9a-f]{64}$/)

    const text = await run(ItemsUpdate, ['--file', path])
    expect(text.stdout).toContain(ITEM_ID)
    expect(text.stdout).toContain('changed fields: code, name, purchaseDetails')
    expect(text.stdout).not.toContain(TENANT)
    expect(text.stdout).not.toContain(CLIENT_ID)
  })

  it('drives the update API path from the sealed record ID and binds it into the digest', async () => {
    api.updateItem.mockResolvedValue({
      body: {items: [{itemID: ITEM_ID, code: 'ITEM-130-UPDATED', name: 'Synthetic Item Updated'}]},
    })
    const path = updateFixture()
    const preview = await run(ItemsUpdate, ['--json', '--file', path])
    const sealed = JSON.parse(preview.stdout) as {payload: Record<string, unknown>; payloadDigest: string}

    const changed = await run(ItemsUpdate, [
      '--json',
      '--file',
      updateFixture({...sealed.payload, itemID: `${ITEM_ID}-other`}),
    ])
    expect((JSON.parse(changed.stdout) as {payloadDigest: string}).payloadDigest).not.toBe(sealed.payloadDigest)

    const output = await run(ItemsUpdate, ['--json', '--file', path, '--execute'])
    expect(output.error).toBeUndefined()
    expect(api.updateItem).toHaveBeenCalledExactlyOnceWith(TENANT, ITEM_ID, {items: [sealed.payload]})
  })
})
