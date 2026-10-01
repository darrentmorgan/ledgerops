import {fileURLToPath} from 'node:url'
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFileSync} from 'node:child_process'
import {afterAll, beforeAll, describe, expect, it} from 'vitest'
import {isolatedEnvironment} from '../../scripts/release-check/checks.mjs'

const PROFILE = 'synthetic-demo-profile'
const RESOURCE = 'synthetic-resource'
let directory: string
let identityPath: string
let inputPath: string
let childEnvironment: NodeJS.ProcessEnv
let childInvocation = 0

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'ledgerops-target-'))
  childEnvironment = isolatedEnvironment(process.env, directory, directory)
  for (const path of [childEnvironment.HOME, childEnvironment.XDG_CONFIG_HOME, childEnvironment.LOCALAPPDATA]) {
    if (!path) throw new Error('Missing isolated child directory')
    mkdirSync(path)
  }
  identityPath = join(directory, 'identity.json')
  inputPath = join(directory, 'input.json')
  const observedAt = Date.now()
  writeFileSync(
    identityPath,
    JSON.stringify({
      profileName: PROFILE,
      tenantId: 'synthetic-tenant-id',
      resource: RESOURCE,
      isDemoCompany: true,
      observedAt,
      freshUntil: observedAt + 60_000,
      capabilities: ['ledger.synthetic.write'],
      scopes: ['ledger.synthetic.scope'],
    }),
  )
  writeFileSync(
    inputPath,
    JSON.stringify({
      planId: 'synthetic-plan',
      operation: 'create',
      payload: {amount: '10.01', label: 'synthetic'},
      requiredCapabilities: ['ledger.synthetic.write'],
      requiredScopes: ['ledger.synthetic.scope'],
    }),
  )
})

afterAll(() => rmSync(directory, {recursive: true, force: true}))

describe('offline target command tracer', () => {
  it('redacts the raw tenant identifier during target verification', async () => {
    const stdout = cli(['target', 'verify', '--profile', PROFILE, '--resource', RESOURCE, '--input', identityPath])

    expect(stdout).not.toContain('synthetic-tenant-id')
    expect(JSON.parse(stdout)).toEqual(expect.objectContaining({isDemoCompany: true}))
  })

  it('plans, exactly confirms, applies once in memory, reads back, and receipts', async () => {
    const planned = cli([
      'target',
      'plan',
      '--profile',
      PROFILE,
      '--resource',
      RESOURCE,
      '--identity',
      identityPath,
      '--input',
      inputPath,
    ])
    const preview = JSON.parse(planned)
    const planPath = join(directory, 'plan.json')
    writeFileSync(planPath, JSON.stringify(preview.plan))

    const applied = cli([
      'target',
      'apply',
      '--profile',
      PROFILE,
      '--resource',
      RESOURCE,
      '--identity',
      identityPath,
      '--plan',
      planPath,
      '--confirm',
      preview.exactConfirmation,
    ])
    const receipt = JSON.parse(applied)
    expect(receipt.result).toEqual(
      expect.objectContaining({
        outcome: 'VERIFIED',
        dispatchState: 'accepted',
      }),
    )
    expect(receipt.receipts).toHaveLength(1)
    expect(applied).not.toContain('synthetic-tenant-id')
  })
})

function cli(args: readonly string[]): string {
  const report = join(directory, `network-${childInvocation++}.json`)
  const stdout = execFileSync(
    process.execPath,
    [
      '--require',
      fileURLToPath(new URL('../../scripts/release-check/network-forbidden.cjs', import.meta.url)),
      fileURLToPath(new URL('../../bin/run.js', import.meta.url)),
      ...args,
    ],
    {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      encoding: 'utf8',
      env: {...childEnvironment, NODE_ENV: 'production', RELEASE_NETWORK_REPORT: report},
    },
  )
  expect(JSON.parse(readFileSync(report, 'utf8'))).toEqual({attempts: 0})
  return stdout
}
