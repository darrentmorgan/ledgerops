import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {createDryRunTransport} from '../../src/lib/ledgerops/dry-run-transport.js'
import type {MutationTransport, TargetIdentity, TransportDispatchRequest} from '../../src/lib/ledgerops/types.js'
import {default as InvoicesBatch} from '../../src/commands/invoices/batch.js'

/**
 * ADR-0013 snapshot binding for `ledgerops invoices batch` (issue #88).
 *
 * The command builds its dispatch from the gate's snapshot, not from the
 * closure it planned in. Proving that needs the two to disagree, which the
 * command can never do to itself — so the gate is wrapped here and hands the
 * command a snapshot sealed over a different manifest. Everything else is the
 * real gate, offline and synthetic.
 */

const NOW = Date.parse('2026-08-25T00:00:00.000Z')
const PROFILE = 'synthetic-batch-profile'
const CLIENT_ID = 'synthetic-batch-client-id'
const TENANT = 'synthetic-batch-tenant-must-not-echo'
const SOURCE_RECEIPT_ID = 'a'.repeat(64)
const SOURCE_MANIFEST_HASH = 'b'.repeat(64)
const FOREIGN_DIGEST = 'c'.repeat(64)

const BATCH_CSV = [
  'contact,reference,date,description,quantity,unitAmount',
  'Acme Ltd,REF-1,2026-08-01,Consulting,2,150.00',
  'Beta Pty,REF-2,2026-08-02,Support,1,99.50',
  '',
].join('\n')

const clock = vi.hoisted(() => ({value: 0}))

const profileConfig = vi.hoisted(() => ({defaultProfile: '', clientId: ''}))

const transportControl = vi.hoisted(() => ({
  dispatches: [] as string[],
  make: undefined as undefined | ((identity: unknown) => unknown),
}))

const sinkControl = vi.hoisted(() => ({built: 0, manifests: 0, links: 0, receipts: 0}))

/** When set, the snapshot the command dispatches from is sealed over another manifest. */
const gateControl = vi.hoisted(() => ({reseal: undefined as string | undefined}))

vi.mock('../../src/lib/profiles.js', () => ({
  getDefaultProfile: () => profileConfig.defaultProfile,
  getProfileClientId: () => profileConfig.clientId,
}))

// Synthetic access observation for the new execute-only provenance seam.
vi.mock('../../src/lib/ledgerops/batch-live-provenance.js', () => ({
  observeBatchTarget: async () => ({}),
}))

vi.mock('../../src/lib/ledgerops/xero-live-draft.js', () => ({
  createXeroLiveDraftTransport: (identity: unknown) => transportControl.make?.(identity),
}))

vi.mock('../../src/lib/ledgerops/file-receipt-sink.js', () => ({
  defaultReceiptFilePath: () => join('/synthetic-never-written', 'receipts.jsonl'),
  createFileReceiptSink: () => {
    sinkControl.built += 1
    return {
      writeAhead: () => {},
      write: () => {},
      writeBatchManifest: () => {
        sinkControl.manifests += 1
      },
      writeBatchLink: () => {
        sinkControl.links += 1
      },
      writeBatchReceipt: () => {
        sinkControl.receipts += 1
      },
    }
  },
}))

vi.mock('../../src/lib/ledgerops/mutation-gate.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/lib/ledgerops/mutation-gate.js')>()
  return {
    ...actual,
    runMutationGate: async (
      descriptor: Parameters<typeof actual.runMutationGate>[0],
      request: Parameters<typeof actual.runMutationGate>[1],
      deps: Parameters<typeof actual.runMutationGate>[2],
    ) => {
      if (gateControl.reseal === undefined) {
        return actual.runMutationGate(descriptor, request, deps)
      }
      // Sealed digest and the payload that carries it move together, so the
      // gate's own binding check still passes and the command is the only
      // thing left that can notice the manifest underneath changed.
      return actual.runMutationGate(
        {
          ...descriptor,
          payload: {...descriptor.payload, manifestDigest: gateControl.reseal},
          sealedDigest: gateControl.reseal,
        },
        request,
        deps,
      )
    },
  }
})

const CLI_ROOT = mkdtempSync(join(tmpdir(), 'ledgerops-invoices-batch-snapshot-cli-'))
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

let directory: string
let csvPath: string
let identityPath: string

function countingTransport(identity: TargetIdentity): MutationTransport {
  const inner = createDryRunTransport(identity)
  return {
    binding: inner.binding,
    async dispatch(input: TransportDispatchRequest) {
      transportControl.dispatches.push(input.planDigest)
      return inner.dispatch(input)
    },
    async readBack(input) {
      return inner.readBack(input)
    },
  }
}

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'ledgerops-invoices-batch-snapshot-'))
  csvPath = join(directory, 'batch.csv')
  writeFileSync(csvPath, BATCH_CSV)
  identityPath = join(directory, 'identity.json')
  writeFileSync(
    identityPath,
    JSON.stringify({
      profileName: PROFILE,
      tenantId: TENANT,
      resource: 'invoices',
      isDemoCompany: true,
      observedAt: NOW,
      freshUntil: NOW + 3_600_000,
      capabilities: ['draft.create'],
      scopes: ['accounting.invoices'],
    }),
  )
})

afterAll(() => {
  rmSync(directory, {recursive: true, force: true})
  rmSync(CLI_ROOT, {recursive: true, force: true})
})

beforeEach(() => {
  clock.value = NOW
  vi.spyOn(Date, 'now').mockImplementation(() => clock.value)
  profileConfig.defaultProfile = PROFILE
  profileConfig.clientId = CLIENT_ID
  transportControl.dispatches.length = 0
  transportControl.make = (identity: unknown) => countingTransport(identity as TargetIdentity)
  sinkControl.built = 0
  sinkControl.manifests = 0
  sinkControl.links = 0
  sinkControl.receipts = 0
  gateControl.reseal = undefined
})

afterEach(() => {
  vi.restoreAllMocks()
})

async function runCommand(args: readonly string[]) {
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
    await InvoicesBatch.run([...args], {root: CLI_ROOT})
  } catch (caught) {
    error = caught instanceof Error ? caught : new Error(String(caught))
  } finally {
    consoleLog.mockRestore()
    consoleError.mockRestore()
    process.exitCode = previousExitCode
  }
  return {error, stdout: stdout.join(''), stderr: stderr.join('')}
}

function baseArgs(extra: readonly string[] = []): string[] {
  return [
    '--file',
    csvPath,
    '--identity',
    identityPath,
    '--account-code',
    '200',
    '--source-receipt-id',
    SOURCE_RECEIPT_ID,
    '--source-manifest-hash',
    SOURCE_MANIFEST_HASH,
    ...extra,
  ]
}

describe('invoices batch snapshot-bound dispatch', () => {
  it('dispatches every member when the snapshot still seals the planned manifest', async () => {
    const output = await runCommand(baseArgs(['--json', '--execute']))

    expect(output.error).toBeUndefined()
    expect(transportControl.dispatches).toHaveLength(2)
    expect(sinkControl.manifests).toBe(1)
  })

  it('dispatches nothing when the snapshot seals a manifest the command did not plan', async () => {
    gateControl.reseal = FOREIGN_DIGEST

    const output = await runCommand(baseArgs(['--json', '--execute']))

    expect(output.error?.message).toContain('BATCH_SNAPSHOT_DIGEST_MISMATCH')
    expect(transportControl.dispatches).toHaveLength(0)
    expect(sinkControl.built).toBe(0)
    expect(sinkControl.manifests).toBe(0)
    expect(sinkControl.links).toBe(0)
    expect(sinkControl.receipts).toBe(0)
    expect(output.stdout).not.toContain('ledgerops.batch-result.v1')
  })

  it('takes the dispatched profile from the snapshot target, not the closure', async () => {
    const output = await runCommand(baseArgs(['--json', '--execute']))

    expect(output.error).toBeUndefined()
    const printed = JSON.parse(output.stdout) as Record<string, unknown>
    expect(printed.runState).toBe('CLOSED')
    expect(output.stdout).not.toContain(TENANT)
  })
})
