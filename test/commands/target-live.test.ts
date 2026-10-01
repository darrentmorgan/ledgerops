import {fileURLToPath} from 'node:url'
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {afterAll, afterEach, describe, expect, it, vi} from 'vitest'
import {LIVE_DEMO_PROFILE, LIVE_DEMO_RESOURCE} from '../../src/lib/ledgerops/live-identity.js'

const TRANSPORT_TENANT = 'synthetic-command-tenant-must-not-echo'
const TRANSPORT_ORG = 'synthetic-command-org-must-not-echo'
const STOP_ERROR = 'synthetic-command-auth-error-must-not-echo'
const SECRET_PAYLOAD = 'synthetic-command-access-token-must-not-echo'
const SECRET_EXPECTED = 'synthetic-command-client-secret-must-not-echo'
const CLI_ROOT = mkdtempSync(join(tmpdir(), 'ledgerops-target-live-cli-'))
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

vi.mock('../../src/lib/ledgerops/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/ledgerops/index.js')>(
    '../../src/lib/ledgerops/index.js',
  )
  return {...actual, createXeroLiveIdentityTransport: vi.fn()}
})

const {createXeroLiveIdentityTransport} = await import('../../src/lib/ledgerops/index.js')
const {default: TargetVerify} = await import('../../src/commands/target/verify.js')
const {default: TargetPlan} = await import('../../src/commands/target/plan.js')

afterEach(() => {
  vi.mocked(createXeroLiveIdentityTransport).mockReset()
})

afterAll(() => {
  rmSync(CLI_ROOT, {recursive: true, force: true})
})

function parseSingleJson(stdout: string): Record<string, unknown> {
  const lines = stdout.split('\n').filter(line => line.length > 0)
  expect(lines).toHaveLength(1)
  return JSON.parse(lines[0]) as Record<string, unknown>
}

async function runCommand(command: typeof TargetVerify | typeof TargetPlan, args: readonly string[]) {
  const stdout: string[] = []
  const stderr: string[] = []
  const previousExitCode = process.exitCode
  const consoleLog = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    stdout.push(`${args.map(String).join(' ')}\n`)
  })
  const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr.push(`${args.map(String).join(' ')}\n`)
  })
  let result: unknown
  let error: Error | undefined
  process.exitCode = undefined
  try {
    result = await command.run([...args], {root: CLI_ROOT})
  } catch (caught) {
    error = caught instanceof Error ? caught : new Error(String(caught))
  } finally {
    consoleLog.mockRestore()
    consoleError.mockRestore()
    process.exitCode = previousExitCode
  }
  return {result, error, stdout: stdout.join(''), stderr: stderr.join('')}
}

describe('target live command boundary', () => {
  it('prints exactly one redacted JSON receipt with no stderr on live success', async () => {
    const read = vi.fn(async () => ({
      tenantId: TRANSPORT_TENANT,
      organisationId: TRANSPORT_TENANT,
      isDemoCompany: true,
      name: TRANSPORT_ORG,
      shortCode: 'SYN',
      rawResponse: TRANSPORT_ORG,
    }))
    vi.mocked(createXeroLiveIdentityTransport).mockReturnValue({read})

    const output = await runCommand(TargetVerify, [
      '--profile',
      LIVE_DEMO_PROFILE,
      '--resource',
      LIVE_DEMO_RESOURCE,
      '--live-demo',
      '--expect-demo-company',
    ])
    const receipt = parseSingleJson(output.stdout)

    expect(output.error).toBeUndefined()
    expect(output.stderr).toBe('')
    expect(receipt).toEqual(
      expect.objectContaining({
        schemaVersion: 'ledgerops.identity.receipt.v1',
        profileName: LIVE_DEMO_PROFILE,
        resource: LIVE_DEMO_RESOURCE,
        isDemoCompany: true,
      }),
    )
    expect(output.stdout).not.toContain(TRANSPORT_TENANT)
    expect(output.stdout).not.toContain(TRANSPORT_ORG)
    expect(read).toHaveBeenCalledTimes(1)
    expect(vi.mocked(createXeroLiveIdentityTransport)).toHaveBeenCalledTimes(1)
  })

  it('prints exactly one structured STOP JSON receipt with no stderr on live failure', async () => {
    const read = vi.fn(async () => {
      throw new Error(STOP_ERROR)
    })
    vi.mocked(createXeroLiveIdentityTransport).mockReturnValue({read})

    const output = await runCommand(TargetVerify, [
      '--profile',
      LIVE_DEMO_PROFILE,
      '--resource',
      LIVE_DEMO_RESOURCE,
      '--live-demo',
      '--expect-demo-company',
    ])
    const receipt = parseSingleJson(output.stdout)

    expect(output.error).toBeUndefined()
    expect(output.stderr).toBe('')
    expect(receipt).toEqual({
      schemaVersion: 'ledgerops.identity.receipt.v1',
      status: 'STOP',
      outcome: 'STOP',
      terminal: 'STOP',
      stop: true,
      code: 'LIVE_IDENTITY_STOP',
      reasonCode: 'TRANSPORT_FAILED',
    })
    expect(output.stdout).not.toContain(STOP_ERROR)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it.each([
    [
      'payload',
      {
        payload: {accessToken: SECRET_PAYLOAD},
        expected: {label: 'synthetic'},
      },
    ],
    [
      'expected',
      {
        payload: {label: 'synthetic'},
        expected: {clientSecret: SECRET_EXPECTED},
      },
    ],
  ])('rejects secret-shaped %s input without echoing the sentinel', async (_label, source) => {
    const directory = mkdtempSync(join(tmpdir(), 'ledgerops-target-hygiene-'))
    try {
      const identityPath = join(directory, 'identity.json')
      const inputPath = join(directory, 'input.json')
      writeFileSync(
        identityPath,
        JSON.stringify({
          profileName: 'synthetic-plan-profile',
          tenantId: 'synthetic-plan-tenant',
          resource: 'synthetic-plan-resource',
          isDemoCompany: true,
          observedAt: Date.parse('2026-08-08T00:00:00.000Z'),
          capabilities: ['synthetic.write'],
          scopes: ['synthetic.scope'],
        }),
      )
      writeFileSync(
        inputPath,
        JSON.stringify({
          operation: 'create',
          requiredCapabilities: ['synthetic.write'],
          requiredScopes: ['synthetic.scope'],
          ...source,
        }),
      )

      const output = await runCommand(TargetPlan, [
        '--profile',
        'synthetic-plan-profile',
        '--resource',
        'synthetic-plan-resource',
        '--identity',
        identityPath,
        '--input',
        inputPath,
      ])

      expect(output.error?.message).toBe(
        'DATA_HYGIENE_REJECTED: Secret-shaped payload or expected input is not accepted',
      )
      expect(output.stdout).toBe('')
      expect(output.stderr).toBe('')
      expect(output.stdout).not.toContain(SECRET_PAYLOAD)
      expect(output.stdout).not.toContain(SECRET_EXPECTED)
      expect(output.error?.message).not.toContain(SECRET_PAYLOAD)
      expect(output.error?.message).not.toContain(SECRET_EXPECTED)
    } finally {
      rmSync(directory, {recursive: true, force: true})
    }
  })
})
