import {fileURLToPath} from 'node:url'
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest'
import {
  confirmationTokenFor,
  createMutationPlan,
  createTargetIdentity,
  type MutationPlan,
} from '../../src/lib/ledgerops/index.js'
import {default as TargetApply} from '../../src/commands/target/apply.js'

const PROFILE = 'synthetic-apply-profile'
const RESOURCE = 'synthetic-apply-resource'
const TENANT = 'synthetic-apply-tenant-must-not-echo'

// Freshness and plan expiry are both checked against the wall clock inside the
// command, so the fixtures are anchored to load time with an hour of slack.
const OBSERVED_AT = Date.now()
const FRESH_UNTIL = OBSERVED_AT + 3_600_000
const EXPIRES_AT = OBSERVED_AT + 3_600_000

const CLI_ROOT = mkdtempSync(join(tmpdir(), 'ledgerops-target-apply-cli-'))
writeFileSync(
  join(CLI_ROOT, 'package.json'),
  JSON.stringify({
    name: 'synthetic-test-profile',
    version: '1.0.0',
    type: 'module',
    oclif: {
      bin: 'synthetic-test-profile',
      commands: fileURLToPath(new URL('../../dist/commands', import.meta.url)),
    },
  }),
)

const identityFile = {
  profileName: PROFILE,
  tenantId: TENANT,
  resource: RESOURCE,
  isDemoCompany: true,
  observedAt: OBSERVED_AT,
  freshUntil: FRESH_UNTIL,
  capabilities: ['ledger.synthetic.write'],
  scopes: ['ledger.synthetic.scope'],
}

let directory: string
let identityPath: string
let plan: MutationPlan

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'ledgerops-target-apply-'))
  identityPath = join(directory, 'identity.json')
  writeFileSync(identityPath, JSON.stringify(identityFile))
  plan = createMutationPlan({
    planId: 'synthetic-apply-plan',
    profileName: PROFILE,
    resource: RESOURCE,
    operation: 'create',
    target: createTargetIdentity(identityFile),
    payload: {amount: '10.01', label: 'synthetic'},
    requiredCapabilities: ['ledger.synthetic.write'],
    requiredScopes: ['ledger.synthetic.scope'],
    readBack: {expected: {amount: '10.01', label: 'synthetic'}},
    createdAt: OBSERVED_AT,
    expiresAt: EXPIRES_AT,
  })
})

afterAll(() => {
  rmSync(directory, {recursive: true, force: true})
  rmSync(CLI_ROOT, {recursive: true, force: true})
})

let planCounter = 0

function writePlanFile(value: unknown): string {
  planCounter += 1
  const path = join(directory, `plan-${planCounter}.json`)
  writeFileSync(path, JSON.stringify(value))
  return path
}

async function runApply(args: readonly string[]) {
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
    await TargetApply.run([...args], {root: CLI_ROOT})
  } catch (caught) {
    error = caught instanceof Error ? caught : new Error(String(caught))
  } finally {
    consoleLog.mockRestore()
    consoleError.mockRestore()
    process.exitCode = previousExitCode
  }
  return {error, stdout: stdout.join(''), stderr: stderr.join('')}
}

describe('target apply command boundary', () => {
  it('applies a verified plan once and prints one receipt without echoing the tenant', async () => {
    const output = await runApply([
      '--profile',
      PROFILE,
      '--resource',
      RESOURCE,
      '--identity',
      identityPath,
      '--plan',
      writePlanFile(plan),
      '--confirm',
      confirmationTokenFor(plan),
    ])

    expect(output.error).toBeUndefined()
    expect(output.stderr).toBe('')
    const printed = JSON.parse(output.stdout) as {
      result: {outcome: string; dispatchState: string}
      receipts: {
        outcome: string
        dispatchState: string
        readBackClassification: string
      }[]
    }
    expect(printed.result).toEqual(
      expect.objectContaining({
        outcome: 'VERIFIED',
        dispatchState: 'accepted',
      }),
    )
    expect(printed.receipts).toHaveLength(1)
    expect(printed.receipts[0]).toEqual(
      expect.objectContaining({
        outcome: 'VERIFIED',
        dispatchState: 'accepted',
        readBackClassification: 'verified',
      }),
    )
    expect(output.stdout).not.toContain(TENANT)
  })

  it('refuses a plan file edited under its recorded digest before anything is dispatched', async () => {
    const tampered = {
      ...plan,
      payload: {amount: '99.99', label: 'synthetic'},
    }

    const output = await runApply([
      '--profile',
      PROFILE,
      '--resource',
      RESOURCE,
      '--identity',
      identityPath,
      '--plan',
      writePlanFile(tampered),
      '--confirm',
      confirmationTokenFor(plan),
    ])

    expect(output.error?.message.startsWith('PLAN_INVALID:')).toBe(true)
    expect(output.stdout).toBe('')
    expect(output.stderr).toBe('')
    expect(output.error?.message).not.toContain(TENANT)
  })

  it('stops on a confirmation token that does not match the plan digest', async () => {
    const output = await runApply([
      '--profile',
      PROFILE,
      '--resource',
      RESOURCE,
      '--identity',
      identityPath,
      '--plan',
      writePlanFile(plan),
      '--confirm',
      'CONFIRM not-the-plan-digest',
    ])

    expect(output.error).toBeUndefined()
    expect(output.stderr).toBe('')
    const printed = JSON.parse(output.stdout) as {
      result: {outcome: string; dispatchState: string}
      receipts: {
        outcome: string
        dispatchState: string
        reasonCode: string
      }[]
    }
    expect(printed.result).toEqual(
      expect.objectContaining({
        outcome: 'STOP',
        dispatchState: 'not-dispatched',
      }),
    )
    expect(printed.receipts).toHaveLength(1)
    expect(printed.receipts[0]).toEqual(
      expect.objectContaining({
        outcome: 'STOP',
        dispatchState: 'not-dispatched',
        reasonCode: 'CONFIRMATION_MISMATCH',
      }),
    )
    expect(output.stdout).not.toContain(TENANT)
  })
})
