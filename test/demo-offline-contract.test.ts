import {spawnSync} from 'node:child_process'
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterAll, beforeAll, describe, expect, it} from 'vitest'

/**
 * Public entrypoint contract for the credential-free offline demo (issue #136).
 *
 * This deliberately runs the package script in a fresh process. Poison values
 * prove the demo does not depend on inherited Xero credentials, while the
 * preload turns any attempted network access into a deterministic failure.
 */

const POISON = {
  clientId: 'client-id-must-never-appear-in-offline-demo',
  profile: 'inherited-profile-must-never-be-selected',
  tenantId: 'tenant-id-must-never-appear-in-offline-demo',
  token: 'token-passphrase-must-never-appear-in-offline-demo',
}

let directory: string
let networkBlocker: string

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'ledgerops-offline-demo-contract-'))
  networkBlocker = join(directory, 'forbid-network.cjs')
  writeFileSync(
    networkBlocker,
    `
const forbidden = (kind) => () => {
  throw new Error('OFFLINE_DEMO_NETWORK_FORBIDDEN:' + kind)
}

for (const [moduleName, methods] of Object.entries({
  'node:http': ['get', 'request'],
  'node:https': ['get', 'request'],
  'node:tls': ['connect'],
  'node:dgram': ['createSocket'],
  'node:dns': ['lookup', 'resolve', 'resolve4', 'resolve6'],
})) {
  const module = require(moduleName)
  for (const method of methods) module[method] = forbidden(moduleName + '.' + method)
}

const net = require('node:net')
for (const method of ['connect', 'createConnection']) {
  const original = net[method]
  net[method] = (...args) => {
    const destination = args[0]
    if (typeof destination === 'string' || destination?.path) return original(...args)
    return forbidden('node:net.' + method)()
  }
}

globalThis.fetch = forbidden('fetch')
`,
  )
})

afterAll(() => rmSync(directory, {recursive: true, force: true}))

describe('npm run demo:offline', () => {
  it('prints a target-bound zero-dispatch preview without credentials or network', () => {
    const run = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'demo:offline'], {
      shell: process.platform === 'win32',
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_OPTIONS: `--require=${networkBlocker}`,
        XERO_CLIENT_ID: POISON.clientId,
        XERO_PROFILE: POISON.profile,
        XERO_TENANT_ID: POISON.tenantId,
        XERO_TOKEN_PASSPHRASE: POISON.token,
      },
      timeout: 30_000,
    })

    const stdout = run.stdout ?? ''
    const stderr = run.stderr ?? ''
    const output = `${stdout}\n${stderr}`
    expect(run.error, output).toBeUndefined()
    expect(run.status, output).toBe(0)

    const previewStart = stdout.indexOf('{')
    expect(previewStart, output).toBeGreaterThanOrEqual(0)
    const preview = JSON.parse(stdout.slice(previewStart)) as {
      schemaVersion?: unknown
      profile?: unknown
      payloadDigest?: unknown
      payload?: {manifestDigest?: unknown}
      willDispatch?: unknown
    }
    expect(preview.schemaVersion).toBe('ledgerops.mutation-preview.v1')
    expect(preview.profile).toBe('synthetic-offline-demo')
    expect(preview.payloadDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(preview.payload?.manifestDigest).toBe(preview.payloadDigest)
    expect(preview.willDispatch).toBe(false)
    expect(stderr).toMatch(/Synthetic offline demo complete: 0 dispatches; no Xero connection\./)

    const fixtureIdentity = JSON.parse(
      readFileSync(join(process.cwd(), 'fixtures/offline-demo/identity.json'), 'utf8'),
    ) as {
      tenantId?: unknown
    }
    expect(typeof fixtureIdentity.tenantId).toBe('string')
    expect(output).not.toContain(String(fixtureIdentity.tenantId))
    expect(output).not.toContain('OFFLINE_DEMO_NETWORK_FORBIDDEN')
    expect(output).not.toMatch(/tenant\s*(?:id|identifier)\s*:/i)
    expect(output).not.toMatch(/client\s*id\s*:/i)
    for (const secret of Object.values(POISON)) expect(output).not.toContain(secret)
  }, 40_000)
})
