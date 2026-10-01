import {fileURLToPath} from 'node:url'
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest'
import {default as TargetRead} from '../../src/commands/target/read.js'

const PROFILE = 'synthetic-read-cli-profile'
const RESOURCE = 'accounts'
const TENANT = 'synthetic-read-tenant-must-not-echo'

// Identity freshness is checked against the wall clock inside the kernel, so
// the fixture is anchored to load time with an hour of slack.
const OBSERVED_AT = Date.now()
const FRESH_UNTIL = OBSERVED_AT + 3_600_000

const CLI_ROOT = mkdtempSync(join(tmpdir(), 'ledgerops-target-read-cli-'))
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
  capabilities: ['read.accounts'],
  scopes: ['accounting.settings.read'],
}

let directory: string
let identityPath: string
let recordsPath: string

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'ledgerops-target-read-'))
  identityPath = join(directory, 'identity.json')
  writeFileSync(identityPath, JSON.stringify(identityFile))
  recordsPath = join(directory, 'records.json')
  writeFileSync(
    recordsPath,
    JSON.stringify([
      {code: '200', name: 'Sales'},
      {code: '400', name: 'Advertising'},
    ]),
  )
})

afterAll(() => {
  rmSync(directory, {recursive: true, force: true})
  rmSync(CLI_ROOT, {recursive: true, force: true})
})

let fileCounter = 0

function writeFixture(value: unknown): string {
  fileCounter += 1
  const path = join(directory, `fixture-${fileCounter}.json`)
  writeFileSync(path, JSON.stringify(value))
  return path
}

async function runRead(args: readonly string[]) {
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
  let exitCode: number | undefined
  process.exitCode = undefined
  try {
    await TargetRead.run([...args], {root: CLI_ROOT})
  } catch (caught) {
    error = caught instanceof Error ? caught : new Error(String(caught))
  } finally {
    exitCode = typeof process.exitCode === 'number' ? process.exitCode : undefined
    consoleLog.mockRestore()
    consoleError.mockRestore()
    process.exitCode = previousExitCode
  }
  return {error, exitCode, stdout: stdout.join(''), stderr: stderr.join('')}
}

describe('target read command boundary', () => {
  it('runs one offline foundation read and prints a receipted result without echoing the tenant', async () => {
    const output = await runRead([
      '--profile',
      PROFILE,
      '--resource',
      RESOURCE,
      '--identity',
      identityPath,
      '--records',
      recordsPath,
    ])

    expect(output.error).toBeUndefined()
    expect(output.stderr).toBe('')
    const printed = JSON.parse(output.stdout) as {
      result?: unknown
      status: string
      records: unknown[]
      recordCount: number
      receipt?: {schemaVersion: string; resource: string; outcome: string}
    }
    expect(printed.status).toBe('ok')
    expect(printed.records).toEqual([
      {code: '200', name: 'Sales'},
      {code: '400', name: 'Advertising'},
    ])
    expect(printed.recordCount).toBe(2)
    expect(printed.receipt).toEqual(
      expect.objectContaining({
        schemaVersion: 'ledgerops.read.v1',
        resource: RESOURCE,
        outcome: 'OK',
      }),
    )
    expect(output.stdout).not.toContain(TENANT)
    expect(output.exitCode).toBeUndefined()
  })

  it('serves a reporting-lane resource through the same command boundary', async () => {
    const journalsIdentity = writeFixture({
      ...identityFile,
      resource: 'journals',
      capabilities: ['read.journals'],
      scopes: ['accounting.journals.read'],
    })
    const output = await runRead([
      '--profile',
      PROFILE,
      '--resource',
      'journals',
      '--identity',
      journalsIdentity,
      '--records',
      writeFixture([{journalNumber: 7}]),
    ])

    expect(output.error).toBeUndefined()
    const printed = JSON.parse(output.stdout) as {
      status: string
      records: unknown[]
      receipt?: {resource: string; outcome: string}
    }
    expect(printed.status).toBe('ok')
    expect(printed.records).toEqual([{journalNumber: 7}])
    expect(printed.receipt).toEqual(expect.objectContaining({resource: 'journals', outcome: 'OK'}))
    expect(output.stdout).not.toContain(TENANT)
  })

  it('serves a matching-lane resource through the same command boundary', async () => {
    const bankIdentity = writeFixture({
      ...identityFile,
      resource: 'bank-transactions',
      capabilities: ['read.bank-transactions'],
      scopes: ['accounting.banktransactions.read'],
    })
    const output = await runRead([
      '--profile',
      PROFILE,
      '--resource',
      'bank-transactions',
      '--identity',
      bankIdentity,
      '--records',
      writeFixture([{type: 'SPEND', reference: 'synthetic-ref'}]),
    ])

    expect(output.error).toBeUndefined()
    const printed = JSON.parse(output.stdout) as {
      status: string
      records: unknown[]
      receipt?: {resource: string; outcome: string}
    }
    expect(printed.status).toBe('ok')
    expect(printed.records).toEqual([{type: 'SPEND', reference: 'synthetic-ref'}])
    expect(printed.receipt).toEqual(expect.objectContaining({resource: 'bank-transactions', outcome: 'OK'}))
    expect(output.stdout).not.toContain(TENANT)
  })

  it('stops a resource outside both lanes at the workflow boundary with exit code 1', async () => {
    const strayIdentity = writeFixture({
      ...identityFile,
      resource: 'organisation-secrets',
    })
    const output = await runRead([
      '--profile',
      PROFILE,
      '--resource',
      'organisation-secrets',
      '--identity',
      strayIdentity,
      '--records',
      recordsPath,
    ])

    expect(output.error).toBeUndefined()
    const printed = JSON.parse(output.stdout) as {
      status: string
      reasonCode: string
      records: unknown[]
    }
    expect(printed).toMatchObject({
      status: 'stop',
      reasonCode: 'RESOURCE_NOT_ALLOWED',
      records: [],
    })
    expect(output.exitCode).toBe(1)
    expect(output.stdout).not.toContain(TENANT)
  })

  it('requires exactly one of --records or --live', async () => {
    const neither = await runRead(['--profile', PROFILE, '--resource', RESOURCE, '--identity', identityPath])
    expect(neither.error?.message).toContain('Exactly one of --records or --live')

    const both = await runRead([
      '--profile',
      PROFILE,
      '--resource',
      RESOURCE,
      '--identity',
      identityPath,
      '--records',
      recordsPath,
      '--live',
    ])
    expect(both.error?.message).toContain('Exactly one of --records or --live')
  })

  it('refuses a records fixture that is not a JSON array', async () => {
    const output = await runRead([
      '--profile',
      PROFILE,
      '--resource',
      RESOURCE,
      '--identity',
      identityPath,
      '--records',
      writeFixture({code: '200'}),
    ])
    expect(output.error?.message).toContain('FILE_UNREADABLE')
    expect(output.error?.message).toContain('one JSON array')
    expect(output.stdout).toBe('')
  })

  it('refuses a secret-shaped records fixture before any execution', async () => {
    const output = await runRead([
      '--profile',
      PROFILE,
      '--resource',
      RESOURCE,
      '--identity',
      identityPath,
      '--records',
      writeFixture([{accessToken: 'synthetic-secret-value'}]),
    ])
    expect(output.error?.message).toContain('DATA_HYGIENE_REJECTED')
    expect(output.stdout).toBe('')
    expect(output.error?.message).not.toContain('synthetic-secret-value')
  })

  it('rejects --receipts without --live instead of silently keeping receipts in memory', async () => {
    const output = await runRead([
      '--profile',
      PROFILE,
      '--resource',
      RESOURCE,
      '--identity',
      identityPath,
      '--records',
      recordsPath,
      '--receipts',
      join(directory, 'never-written.jsonl'),
    ])
    expect(output.error?.message).toContain('--live')
    expect(output.stdout).toBe('')
  })

  it('refuses a records fixture carrying a raw tenant identifier', async () => {
    const output = await runRead([
      '--profile',
      PROFILE,
      '--resource',
      RESOURCE,
      '--identity',
      identityPath,
      '--records',
      writeFixture([{tenantId: 'synthetic-raw-tenant-value'}]),
    ])
    expect(output.error?.message).toContain('tenant-identifier')
    expect(output.stdout).toBe('')
    expect(output.error?.message).not.toContain('synthetic-raw-tenant-value')
  })

  it('serves a well-formed --query from a fixture authored for it', async () => {
    const output = await runRead([
      '--profile',
      PROFILE,
      '--resource',
      RESOURCE,
      '--identity',
      identityPath,
      '--records',
      recordsPath,
      '--query',
      '{"where":"Code==\\"200\\""}',
    ])
    expect(output.error).toBeUndefined()
    const printed = JSON.parse(output.stdout) as {
      status: string
      recordCount: number
    }
    expect(printed.status).toBe('ok')
    expect(printed.recordCount).toBe(2)
  })

  it('rejects a malformed --query before the kernel runs', async () => {
    const notJson = await runRead([
      '--profile',
      PROFILE,
      '--resource',
      RESOURCE,
      '--identity',
      identityPath,
      '--records',
      recordsPath,
      '--query',
      'not-json',
    ])
    expect(notJson.error?.message).toContain('--query must be valid JSON')

    const notObject = await runRead([
      '--profile',
      PROFILE,
      '--resource',
      RESOURCE,
      '--identity',
      identityPath,
      '--records',
      recordsPath,
      '--query',
      '[1,2]',
    ])
    expect(notObject.error?.message).toContain('--query must be one JSON object')
  })

  it('stops on an out-of-bound --max-calls with a guard STOP, not a live failure', async () => {
    const output = await runRead([
      '--profile',
      PROFILE,
      '--resource',
      RESOURCE,
      '--identity',
      identityPath,
      '--records',
      recordsPath,
      '--max-calls',
      '0',
    ])
    expect(output.error).toBeUndefined()
    const printed = JSON.parse(output.stdout) as {
      status: string
      reasonCode: string
    }
    expect(printed).toMatchObject({
      status: 'stop',
      reasonCode: 'CALL_BOUND_INVALID',
    })
    expect(output.exitCode).toBe(1)
  })
})
