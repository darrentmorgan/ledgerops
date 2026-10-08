import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterAll, beforeEach, describe, expect, it, vi} from 'vitest'
import TrackingOptionsCreate from '../../src/commands/tracking/options/create.js'
import TrackingOptionsUpdate from '../../src/commands/tracking/options/update.js'

import {mutationCommandBoundaryTests} from '../support/mutation-command-boundary.js'

const TENANT = 'synthetic-option-tenant-must-not-echo'
const CLIENT_ID = 'synthetic-option-client-must-not-echo'
const CATEGORY_ID = 'synthetic-tracking-category-134'
const OPTION_ID = 'synthetic-tracking-option-134'

const api = vi.hoisted(() => ({createTrackingOptions: vi.fn(), updateTrackingOptions: vi.fn()}))
const profile = vi.hoisted(() => ({
  name: 'synthetic-option-profile',
  clientId: 'synthetic-option-client-must-not-echo',
  resolves: 0,
}))
const targets = vi.hoisted(() => [] as Array<{profileName: string; clientId: string}>)
const prompt = vi.hoisted(() => ({
  answer: 'y',
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

const root = mkdtempSync(join(tmpdir(), 'ledgerops-option-gate-root-'))
writeFileSync(
  join(root, 'package.json'),
  JSON.stringify({
    name: 'ledgerops-test',
    version: '1.0.0',
    type: 'module',
    oclif: {bin: 'ledgerops', commands: join(process.cwd(), 'dist', 'commands')},
  }),
)

type Command = {run(args?: string[], config?: {root: string}): Promise<unknown>}

async function run(command: Command, args: readonly string[]) {
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

afterAll(() => rmSync(root, {recursive: true, force: true}))
beforeEach(() => {
  api.createTrackingOptions.mockReset()
  api.updateTrackingOptions.mockReset()
  profile.name = 'synthetic-option-profile'
  profile.clientId = CLIENT_ID
  profile.resolves = 0
  targets.length = 0
  prompt.answer = 'y'
  prompt.calls.length = 0
  prompt.onQuestion = undefined
})

const createArgs = ['--category-id', CATEGORY_ID, '--name', 'Synthetic Region'] as const
const updateArgs = [
  '--category-id',
  CATEGORY_ID,
  '--option-id',
  OPTION_ID,
  '--name',
  'Synthetic Territory',
  '--status',
  'ARCHIVED',
] as const

describe.each([
  {
    label: 'create',
    command: TrackingOptionsCreate,
    apiMethod: api.createTrackingOptions,
    args: createArgs,
    result: {body: {options: [{trackingOptionID: OPTION_ID, name: 'Synthetic Region'}]}},
    line: 'Tracking option created: Synthetic Region',
  },
  {
    label: 'update',
    command: TrackingOptionsUpdate,
    apiMethod: api.updateTrackingOptions,
    args: updateArgs,
    result: {body: {options: [{trackingOptionID: OPTION_ID, name: 'Synthetic Territory', status: 'ARCHIVED'}]}},
    line: 'Tracking option updated: Synthetic Territory',
  },
])('tracking options $label shared boundary', ({label, command, apiMethod, args, result, line}) => {
  mutationCommandBoundaryTests({
    command,
    apiMethod,
    args,
    expectedPreviewLiteral: `${label} tracking-options`,
    expectedResultLine: line,
    executeResponse: result,
    targetsExistingResource: label === 'update',
    run,
    interactiveCalls: () => prompt.calls,
  })

  it('dispatches exactly one mutation with --execute and --execute --yes', async () => {
    for (const extra of [['--execute'], ['--execute', '--yes']]) {
      apiMethod.mockReset().mockResolvedValue(result)
      const output = await run(command, [...args, ...extra])
      expect(output.error).toBeUndefined()
      expect(apiMethod).toHaveBeenCalledTimes(1)
      expect(output.stdout).toContain(line)
    }
  })
})

describe('tracking option payload binding and safety', () => {
  it('seals exactly one option per invocation and reports update fields and status', async () => {
    const created = JSON.parse((await run(TrackingOptionsCreate, ['--json', ...createArgs])).stdout)
    expect(created.payload).toEqual({trackingCategoryID: CATEGORY_ID, option: {name: 'Synthetic Region'}})
    expect(created.payloadDigest).toMatch(/^sha256:[0-9a-f]{64}$/)

    const updated = JSON.parse((await run(TrackingOptionsUpdate, ['--json', ...updateArgs])).stdout)
    expect(updated.payload).toEqual({
      trackingCategoryID: CATEGORY_ID,
      option: {trackingOptionID: OPTION_ID, name: 'Synthetic Territory', status: 'ARCHIVED'},
    })
    expect(updated.payloadDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    const text = await run(TrackingOptionsUpdate, updateArgs)
    expect(text.stdout).toContain(CATEGORY_ID)
    expect(text.stdout).toContain(OPTION_ID)
    expect(text.stdout).toContain('changed fields: name, status')
    expect(text.stdout).toContain('status ARCHIVED')
  })

  it('drives both update route IDs and body from the sealed snapshot', async () => {
    api.updateTrackingOptions.mockResolvedValue({body: {options: [{trackingOptionID: OPTION_ID}]}})
    const preview = JSON.parse((await run(TrackingOptionsUpdate, ['--json', ...updateArgs])).stdout)
    const changedCategory = JSON.parse(
      (
        await run(TrackingOptionsUpdate, [
          '--json',
          ...updateArgs.map(value => (value === CATEGORY_ID ? `${CATEGORY_ID}-other` : value)),
        ])
      ).stdout,
    )
    const changedOption = JSON.parse(
      (
        await run(TrackingOptionsUpdate, [
          '--json',
          ...updateArgs.map(value => (value === OPTION_ID ? `${OPTION_ID}-other` : value)),
        ])
      ).stdout,
    )
    expect(changedCategory.payloadDigest).not.toBe(preview.payloadDigest)
    expect(changedOption.payloadDigest).not.toBe(preview.payloadDigest)

    await run(TrackingOptionsUpdate, [...updateArgs, '--execute'])
    expect(api.updateTrackingOptions).toHaveBeenCalledExactlyOnceWith(
      TENANT,
      CATEGORY_ID,
      OPTION_ID,
      preview.payload.option,
    )
  })

  it('binds create category ID and exactly one option into the API request', async () => {
    api.createTrackingOptions.mockResolvedValue({body: {options: [{trackingOptionID: OPTION_ID}]}})
    await run(TrackingOptionsCreate, [...createArgs, '--execute'])
    expect(api.createTrackingOptions).toHaveBeenCalledExactlyOnceWith(TENANT, CATEGORY_ID, {name: 'Synthetic Region'})
  })

  it('rejects removed comma-list and file interfaces without dispatch', async () => {
    const list = await run(TrackingOptionsCreate, ['--category-id', CATEGORY_ID, '--names', 'One,Two'])
    expect(list.error?.message).toMatch(/Nonexistent flag: --names|--names.*not found/i)
    expect(api.createTrackingOptions).not.toHaveBeenCalled()

    const file = await run(TrackingOptionsUpdate, ['--file', 'legacy-options.json'])
    expect(file.error?.message).toMatch(/Nonexistent flag: --file|--file.*not found/i)
    expect(api.updateTrackingOptions).not.toHaveBeenCalled()
    expect(TrackingOptionsCreate.flags).not.toHaveProperty('names')
    expect(TrackingOptionsUpdate.flags).not.toHaveProperty('file')
  })

  it("shows the pending preview on stderr, rejects 'y', and accepts ' YES ' without target rotation", async () => {
    await dualTty(async () => {
      api.createTrackingOptions.mockResolvedValue({
        body: {options: [{trackingOptionID: OPTION_ID, name: 'Synthetic Region'}]},
      })
      prompt.answer = 'y'
      const declined = await run(TrackingOptionsCreate, [...createArgs, '--execute'])
      expect(declined.error?.message).toMatch(/declined/i)
      expect(api.createTrackingOptions).not.toHaveBeenCalled()
      expect(prompt.calls[0]?.output).toBe(process.stderr)
      expect(declined.stderr).toContain('PENDING MUTATION')

      prompt.answer = ' YES '
      prompt.onQuestion = () => {
        profile.name = 'rotated-option-profile'
        profile.clientId = 'rotated-option-client'
      }
      profile.resolves = 0
      const accepted = await run(TrackingOptionsCreate, [...createArgs, '--execute'])
      expect(accepted.error).toBeUndefined()
      expect(api.createTrackingOptions).toHaveBeenCalledTimes(1)
      expect(profile.resolves).toBe(1)
      expect(targets).toEqual([{profileName: 'synthetic-option-profile', clientId: CLIENT_ID}])
    })
  })

  it('resolves the target before validation and refuses malformed or empty updates', async () => {
    const malformed = await run(TrackingOptionsCreate, ['--category-id', CATEGORY_ID, '--name', ''])
    expect(profile.resolves).toBe(1)
    expect(malformed.error?.message).toMatch(/Validation errors/)
    expect(api.createTrackingOptions).not.toHaveBeenCalled()

    profile.resolves = 0
    const empty = await run(TrackingOptionsUpdate, ['--category-id', CATEGORY_ID, '--option-id', OPTION_ID])
    expect(profile.resolves).toBe(1)
    expect(empty.error?.message).toMatch(/At least one change/)
    expect(api.updateTrackingOptions).not.toHaveBeenCalled()
    expect(empty.stdout).not.toContain('PREVIEW')
  })

  it.each([
    {command: TrackingOptionsCreate, apiMethod: api.createTrackingOptions, args: createArgs},
    {command: TrackingOptionsUpdate, apiMethod: api.updateTrackingOptions, args: updateArgs},
  ])('does not retry or leak target secrets after a 401', async ({command, apiMethod, args}) => {
    apiMethod.mockRejectedValue(
      new Error(JSON.stringify({response: {statusCode: 401}, tenantId: TENANT, clientId: CLIENT_ID})),
    )
    const output = await run(command, [...args, '--execute'])
    expect(apiMethod).toHaveBeenCalledTimes(1)
    expect(output.error?.message).toMatch(/session expired|re-authenticate/i)
    expect(`${output.stdout}${output.stderr}${output.error?.message}`).not.toContain(TENANT)
    expect(`${output.stdout}${output.stderr}${output.error?.message}`).not.toContain(CLIENT_ID)
  })
})
