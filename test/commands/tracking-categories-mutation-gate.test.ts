import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterAll, beforeEach, describe, expect, it, vi} from 'vitest'
import TrackingCategoriesCreate from '../../src/commands/tracking/categories/create.js'
import TrackingCategoriesUpdate from '../../src/commands/tracking/categories/update.js'

import {mutationCommandBoundaryTests} from '../support/mutation-command-boundary.js'

const TENANT = 'synthetic-tracking-tenant-must-not-echo'
const CLIENT_ID = 'synthetic-tracking-client-must-not-echo'
const CATEGORY_ID = 'synthetic-tracking-category-133'

const api = vi.hoisted(() => ({createTrackingCategory: vi.fn(), updateTrackingCategory: vi.fn()}))
const profile = vi.hoisted(() => ({
  name: 'synthetic-tracking-profile',
  clientId: 'synthetic-tracking-client-must-not-echo',
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

const root = mkdtempSync(join(tmpdir(), 'ledgerops-tracking-gate-root-'))
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

afterAll(() => rmSync(root, {recursive: true, force: true}))
beforeEach(() => {
  api.createTrackingCategory.mockReset()
  api.updateTrackingCategory.mockReset()
  profile.name = 'synthetic-tracking-profile'
  profile.clientId = CLIENT_ID
  profile.resolves = 0
  targets.length = 0
  prompt.answer = 'y'
  prompt.calls.length = 0
  prompt.questions.length = 0
  prompt.onQuestion = undefined
})

const createArgs = ['--name', 'Synthetic Department'] as const
const updateArgs = ['--category-id', CATEGORY_ID, '--name', 'Synthetic Division', '--status', 'ARCHIVED'] as const

describe.each([
  {
    label: 'create',
    command: TrackingCategoriesCreate,
    apiMethod: api.createTrackingCategory,
    args: createArgs,
    result: {body: {trackingCategories: [{trackingCategoryID: CATEGORY_ID, name: 'Synthetic Department'}]}},
    line: 'Tracking category created: Synthetic Department',
  },
  {
    label: 'update',
    command: TrackingCategoriesUpdate,
    apiMethod: api.updateTrackingCategory,
    args: updateArgs,
    result: {
      body: {trackingCategories: [{trackingCategoryID: CATEGORY_ID, name: 'Synthetic Division', status: 'ARCHIVED'}]},
    },
    line: 'Tracking category updated: Synthetic Division',
  },
])('tracking categories $label shared boundary', ({label, command, apiMethod, args, result, line}) => {
  mutationCommandBoundaryTests({
    command,
    apiMethod,
    args,
    expectedPreviewLiteral: `${label} tracking-categories`,
    expectedResultLine: line,
    executeResponse: result,
    targetsExistingResource: label === 'update',
    run,
    interactiveCalls: () => prompt.calls,
  })

  it('dispatches exactly once with --execute and --execute --yes', async () => {
    for (const extra of [['--execute'], ['--execute', '--yes']]) {
      apiMethod.mockReset().mockResolvedValue(result)
      const output = await run(command, [...args, ...extra])
      expect(output.error).toBeUndefined()
      expect(apiMethod).toHaveBeenCalledTimes(1)
      expect(output.stdout).toContain(line)
    }
  })
})

describe('tracking category payload binding and safety', () => {
  it('seals create and update payloads, including the update path ID and named changes', async () => {
    const created = JSON.parse((await run(TrackingCategoriesCreate, ['--json', ...createArgs])).stdout)
    expect(created.payload).toEqual({name: 'Synthetic Department'})
    expect(created.payloadDigest).toMatch(/^sha256:[0-9a-f]{64}$/)

    const updatedOutput = await run(TrackingCategoriesUpdate, ['--json', ...updateArgs])
    const updated = JSON.parse(updatedOutput.stdout)
    expect(updated.payload).toEqual({trackingCategoryID: CATEGORY_ID, name: 'Synthetic Division', status: 'ARCHIVED'})
    expect(updated.payloadDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    const text = await run(TrackingCategoriesUpdate, updateArgs)
    expect(text.stdout).toContain(`tracking category ${CATEGORY_ID} (Synthetic Division)`)
    expect(text.stdout).toContain('changed fields: name, status')
    expect(text.stdout).toContain('status ARCHIVED')
  })

  it('uses the sealed trackingCategoryID for the API path and request body', async () => {
    api.updateTrackingCategory.mockResolvedValue({
      body: {trackingCategories: [{trackingCategoryID: CATEGORY_ID, name: 'Synthetic Division'}]},
    })
    await run(TrackingCategoriesUpdate, [...updateArgs, '--execute'])
    expect(api.updateTrackingCategory).toHaveBeenCalledWith(TENANT, CATEGORY_ID, {
      trackingCategoryID: CATEGORY_ID,
      name: 'Synthetic Division',
      status: 'ARCHIVED',
    })
  })

  it("shows the pending preview on stderr, rejects 'y', and accepts ' YES ' without target rotation", async () => {
    await dualTty(async () => {
      api.createTrackingCategory.mockResolvedValue({
        body: {trackingCategories: [{trackingCategoryID: CATEGORY_ID, name: 'Synthetic Department'}]},
      })
      prompt.answer = 'y'
      const declined = await run(TrackingCategoriesCreate, [...createArgs, '--execute'])
      expect(declined.error?.message).toMatch(/declined/i)
      expect(api.createTrackingCategory).not.toHaveBeenCalled()
      expect(prompt.calls[0]?.output).toBe(process.stderr)
      expect(declined.stderr).toContain('PENDING MUTATION')

      prompt.answer = ' YES '
      prompt.onQuestion = () => {
        profile.name = 'rotated-profile'
        profile.clientId = 'rotated-client'
      }
      profile.resolves = 0
      const accepted = await run(TrackingCategoriesCreate, [...createArgs, '--execute'])
      expect(accepted.error).toBeUndefined()
      expect(api.createTrackingCategory).toHaveBeenCalledTimes(1)
      expect(profile.resolves).toBe(1)
      expect(targets).toEqual([{profileName: 'synthetic-tracking-profile', clientId: CLIENT_ID}])
    })
  })

  it('resolves the target before validation and refuses an empty update with zero dispatch', async () => {
    const malformed = await run(TrackingCategoriesCreate, ['--name', ''])
    expect(profile.resolves).toBe(1)
    expect(malformed.error?.message).toMatch(/Validation errors/)
    expect(api.createTrackingCategory).not.toHaveBeenCalled()

    profile.resolves = 0
    const empty = await run(TrackingCategoriesUpdate, ['--category-id', CATEGORY_ID])
    expect(profile.resolves).toBe(1)
    expect(empty.error?.message).toMatch(/At least one change/)
    expect(api.updateTrackingCategory).not.toHaveBeenCalled()
    expect(empty.stdout).not.toContain('PREVIEW')
  })

  it.each([
    {command: TrackingCategoriesCreate, apiMethod: api.createTrackingCategory, args: createArgs},
    {command: TrackingCategoriesUpdate, apiMethod: api.updateTrackingCategory, args: updateArgs},
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
