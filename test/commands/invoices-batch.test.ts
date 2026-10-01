import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {createDryRunTransport} from '../../src/lib/ledgerops/dry-run-transport.js'
import type {MutationTransport, TargetIdentity, TransportDispatchRequest} from '../../src/lib/ledgerops/types.js'
import {default as InvoicesBatch} from '../../src/commands/invoices/batch.js'

/**
 * Command-boundary coverage for `ledgerops invoices batch` (issue #63).
 *
 * Everything is offline and synthetic: the live DRAFT transport and the
 * durable receipt sink are replaced with injected fakes, so every assertion
 * about dispatch counts is exact rather than inferred.
 */

const NOW = Date.parse('2026-08-25T00:00:00.000Z')
const PROFILE = 'synthetic-batch-profile'
const CLIENT_ID = 'synthetic-batch-client-id'
const TENANT = 'synthetic-batch-tenant-must-not-echo'
const SOURCE_RECEIPT_ID = 'a'.repeat(64)
const SOURCE_MANIFEST_HASH = 'b'.repeat(64)

const BATCH_CSV = [
  'contact,reference,date,description,quantity,unitAmount',
  'Acme Ltd,REF-1,2026-08-01,Consulting,2,150.00',
  'Beta Pty,REF-2,2026-08-02,Support,1,99.50',
  'Gamma Co,REF-3,2026-08-03,Training,3,50.00',
  '',
].join('\n')

const clock = vi.hoisted(() => ({value: 0}))

const profileConfig = vi.hoisted(() => ({
  defaultProfile: '',
  clientId: '',
  resolves: 0,
}))

const transportControl = vi.hoisted(() => ({
  built: 0,
  dispatches: [] as string[],
  failAtDispatch: undefined as number | undefined,
  make: undefined as undefined | ((identity: unknown) => unknown),
}))

const sinkControl = vi.hoisted(() => ({
  built: 0,
  paths: [] as (string | undefined)[],
  manifests: 0,
  links: 0,
  receipts: 0,
  failBatchReceipt: false,
  onCreate: undefined as undefined | (() => void),
}))

const interactive = vi.hoisted(() => ({
  calls: [] as {options: {input?: unknown; output?: unknown}}[],
  queries: [] as string[],
  answer: 'no',
}))

vi.mock('../../src/lib/profiles.js', () => ({
  getDefaultProfile: () => {
    profileConfig.resolves += 1
    return profileConfig.defaultProfile
  },
  getProfileClientId: () => profileConfig.clientId,
}))

// Synthetic access observation for the new execute-only provenance seam.
const observation = vi.hoisted(() => ({calls: 0, refuse: false}))
vi.mock('../../src/lib/ledgerops/batch-live-provenance.js', () => ({
  observeBatchTarget: async () => {
    observation.calls += 1
    if (observation.refuse) throw new Error('BATCH_PROVENANCE_UNVERIFIED')
    return {}
  },
}))

vi.mock('../../src/lib/ledgerops/xero-live-draft.js', () => ({
  createXeroLiveDraftTransport: (identity: unknown) => {
    transportControl.built += 1
    return transportControl.make?.(identity)
  },
}))

vi.mock('../../src/lib/ledgerops/file-receipt-sink.js', () => ({
  defaultReceiptFilePath: () => join('/synthetic-never-written', 'receipts.jsonl'),
  createFileReceiptSink: (options: {path?: string} = {}) => {
    sinkControl.built += 1
    sinkControl.paths.push(options.path)
    sinkControl.onCreate?.()
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
        if (sinkControl.failBatchReceipt) throw new Error('synthetic batch receipt append failure')
      },
    }
  },
}))

vi.mock('node:readline/promises', () => ({
  createInterface: (options: {input?: unknown; output?: unknown}) => {
    interactive.calls.push({options})
    return {
      question: async (query?: string) => {
        interactive.queries.push(String(query))
        return interactive.answer
      },
      close: () => {},
    }
  },
}))

const CLI_ROOT = mkdtempSync(join(tmpdir(), 'ledgerops-invoices-batch-cli-'))
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
      if (transportControl.failAtDispatch === transportControl.dispatches.length) {
        throw new Error('synthetic dispatch failure')
      }
      return inner.dispatch(input)
    },
    async readBack(input) {
      return inner.readBack(input)
    },
  }
}

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'ledgerops-invoices-batch-'))
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
  observation.calls = 0
  observation.refuse = false
  clock.value = NOW
  vi.spyOn(Date, 'now').mockImplementation(() => clock.value)
  profileConfig.defaultProfile = PROFILE
  profileConfig.clientId = CLIENT_ID
  profileConfig.resolves = 0
  transportControl.built = 0
  transportControl.dispatches.length = 0
  transportControl.failAtDispatch = undefined
  transportControl.make = (identity: unknown) => countingTransport(identity as TargetIdentity)
  sinkControl.built = 0
  sinkControl.paths.length = 0
  sinkControl.manifests = 0
  sinkControl.links = 0
  sinkControl.receipts = 0
  sinkControl.failBatchReceipt = false
  sinkControl.onCreate = undefined
  interactive.calls.length = 0
  interactive.queries.length = 0
  interactive.answer = 'no'
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

function withDualTty<T>(run: () => Promise<T>): Promise<T> {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  Object.defineProperty(process.stdin, 'isTTY', {value: true, configurable: true})
  Object.defineProperty(process.stdout, 'isTTY', {value: true, configurable: true})
  const restore = () => {
    if (stdinDescriptor) {
      Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor)
    } else {
      delete (process.stdin as {isTTY?: boolean}).isTTY
    }
    if (stdoutDescriptor) {
      Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor)
    } else {
      delete (process.stdout as {isTTY?: boolean}).isTTY
    }
  }
  return run().then(
    value => {
      restore()
      return value
    },
    error => {
      restore()
      throw error
    },
  )
}

describe('invoices batch preview', () => {
  it('previews every member with zero API dispatches when --execute is absent', async () => {
    const output = await runCommand(baseArgs())

    expect(output.error).toBeUndefined()
    expect(transportControl.dispatches).toHaveLength(0)
    expect(transportControl.built).toBe(0)
    expect(sinkControl.built).toBe(0)
    expect(output.stdout).toContain('PREVIEW')
    expect(output.stdout).toContain('--execute')
    expect(output.stdout).toContain('3 draft invoice(s)')
    expect(output.stdout).toMatch(/digest:\s+[0-9a-f]{64}/)
    expect(output.stdout).toContain('Acme Ltd')
    expect(output.stdout).not.toContain(TENANT)
  })

  it('emits the versioned preview schema alone on stdout under --json', async () => {
    const output = await runCommand(baseArgs(['--json']))

    expect(output.error).toBeUndefined()
    expect(transportControl.dispatches).toHaveLength(0)
    const printed = JSON.parse(output.stdout) as Record<string, unknown>
    expect(Object.keys(printed)).toEqual([
      'schemaVersion',
      'operation',
      'resource',
      'profile',
      'payloadDigest',
      'payload',
      'willDispatch',
    ])
    expect(printed.schemaVersion).toBe('ledgerops.mutation-preview.v1')
    expect(printed.operation).toBe('batch-create')
    expect(printed.resource).toBe('invoices')
    expect(printed.profile).toBe(PROFILE)
    expect(String(printed.payloadDigest)).toMatch(/^[0-9a-f]{64}$/)
    expect(printed.willDispatch).toBe(false)
    const payload = printed.payload as Record<string, unknown>
    expect(payload.itemCount).toBe(3)
    expect(payload.manifestDigest).toBe(printed.payloadDigest)
  })

  it('never dispatches on --yes alone', async () => {
    const output = await runCommand(baseArgs(['--yes']))

    expect(output.error).toBeUndefined()
    expect(transportControl.dispatches).toHaveLength(0)
    expect(sinkControl.built).toBe(0)
    expect(output.stdout).toContain('PREVIEW')
  })
})

describe('invoices batch execute', () => {
  it('keeps previews and declines free of provenance lookup and sink creation', async () => {
    await runCommand(baseArgs(['--json']))
    await runCommand(baseArgs(['--yes']))
    await withDualTty(() => runCommand(baseArgs(['--execute'])))
    expect(observation.calls).toBe(0)
    expect(sinkControl.built).toBe(0)
    expect(transportControl.dispatches).toHaveLength(0)
  })

  it('refuses the whole batch before sink or transport on failed observation', async () => {
    observation.refuse = true
    const output = await runCommand(baseArgs(['--json', '--execute']))
    expect(output.error?.message).toContain('BATCH_PROVENANCE_UNVERIFIED')
    expect(observation.calls).toBe(1)
    expect(sinkControl.built).toBe(0)
    expect(transportControl.built).toBe(0)
    expect(transportControl.dispatches).toHaveLength(0)
  })
  it('dispatches exactly one mutation per member, unprompted, with JSON alone on stdout', async () => {
    const output = await runCommand(baseArgs(['--json', '--execute']))

    expect(output.error).toBeUndefined()
    expect(interactive.calls).toHaveLength(0)
    expect(transportControl.dispatches).toHaveLength(3)
    expect(new Set(transportControl.dispatches).size).toBe(3)
    expect(sinkControl.manifests).toBe(1)
    expect(sinkControl.links).toBe(3)
    expect(sinkControl.receipts).toBe(1)

    const printed = JSON.parse(output.stdout) as Record<string, unknown>
    expect(printed.schemaVersion).toBe('ledgerops.batch-result.v1')
    expect(printed.runState).toBe('CLOSED')
    expect(printed.halted).toBe(false)
    expect(printed.counts).toEqual({
      accepted: 3,
      stopped: 0,
      dispatchedUnverified: 0,
      uncertain: 0,
      notAttempted: 0,
    })
    expect(output.stdout).not.toContain('ledgerops.mutation-preview.v1')
  })

  it('binds the confirmation to the manifest digest shown in the preview', async () => {
    const preview = await runCommand(baseArgs(['--json']))
    const previewDigest = (JSON.parse(preview.stdout) as Record<string, unknown>).payloadDigest

    const executed = await runCommand(baseArgs(['--json', '--execute']))
    const result = JSON.parse(executed.stdout) as Record<string, unknown>

    expect(result.manifestDigest).toBe(previewDigest)
    expect(transportControl.dispatches).toHaveLength(3)
  })

  it('renders the snapshot-bound preview on stderr before the confirmation and aborts on anything but yes', async () => {
    const declined = await withDualTty(() => runCommand(baseArgs(['--execute'])))

    expect(interactive.calls).toHaveLength(1)
    expect(interactive.calls[0].options.output).toBe(process.stderr)
    expect(declined.stderr).toContain('PENDING MUTATION')
    expect(declined.stderr).toContain('batch-create invoices')
    expect(declined.stderr).toContain(`profile: ${PROFILE}`)
    expect(declined.stderr).toMatch(/digest:\s+[0-9a-f]{64}/)
    expect(declined.stderr).toContain('3 draft invoice(s)')
    expect(interactive.queries.at(-1)).toContain("Type 'yes' to confirm")
    expect(transportControl.dispatches).toHaveLength(0)
    expect(sinkControl.built).toBe(0)
    expect(declined.error?.message).toMatch(/declined/i)
    expect(declined.stdout).not.toContain('PENDING MUTATION')
  })

  it("rejects shorthand 'y' and accepts an exact trimmed yes", async () => {
    interactive.answer = 'y'
    const shorthand = await withDualTty(() => runCommand(baseArgs(['--execute'])))
    expect(transportControl.dispatches).toHaveLength(0)
    expect(shorthand.error?.message).toMatch(/declined/i)

    interactive.answer = ' YES '
    const accepted = await withDualTty(() => runCommand(baseArgs(['--execute'])))
    expect(accepted.error).toBeUndefined()
    expect(transportControl.dispatches).toHaveLength(3)
    expect(accepted.stdout).toContain('run closed')
  })

  it('answers a presented confirmation with --yes without a second dispatch', async () => {
    const output = await withDualTty(() => runCommand(baseArgs(['--execute', '--yes'])))

    expect(output.error).toBeUndefined()
    expect(interactive.calls).toHaveLength(0)
    expect(transportControl.dispatches).toHaveLength(3)
  })
})

describe('invoices batch partial and uncertain outcomes', () => {
  it('reports mixed outcomes without hiding a member behind another', async () => {
    transportControl.failAtDispatch = 2

    const output = await runCommand(baseArgs(['--json', '--execute']))

    expect(output.error).toBeUndefined()
    expect(transportControl.dispatches).toHaveLength(2)
    const result = JSON.parse(output.stdout) as Record<string, unknown>
    expect(result.halted).toBe(true)
    expect(result.haltedAtIndex).toBe(1)
    const counts = result.counts as Record<string, number>
    expect(counts.accepted).toBe(1)
    expect(counts.notAttempted).toBe(1)
    expect(
      counts.accepted + counts.stopped + counts.dispatchedUnverified + counts.uncertain + counts.notAttempted,
    ).toBe(3)
    expect(result.items as unknown[]).toHaveLength(3)
  })

  it('reports an UNCERTAIN run state even though the executor reports ok', async () => {
    sinkControl.failBatchReceipt = true

    const output = await runCommand(baseArgs(['--execute']))

    expect(output.error).toBeUndefined()
    expect(transportControl.dispatches).toHaveLength(3)
    expect(output.stdout).toContain('UNCERTAIN')
    expect(output.stdout).not.toContain('run closed')
  })
})

describe('invoices batch fails closed', () => {
  it('resolves the target before validating the payload', async () => {
    profileConfig.defaultProfile = ''
    const badCsv = join(directory, 'bad.csv')
    writeFileSync(badCsv, 'not,a,valid,header\n')

    const output = await runCommand([
      '--file',
      badCsv,
      '--identity',
      identityPath,
      '--account-code',
      '200',
      '--source-receipt-id',
      SOURCE_RECEIPT_ID,
      '--source-manifest-hash',
      SOURCE_MANIFEST_HASH,
      '--execute',
    ])

    expect(output.error?.message).toMatch(/No profile configured/)
    expect(output.stdout).not.toContain('PREVIEW')
    expect(transportControl.dispatches).toHaveLength(0)
    expect(profileConfig.resolves).toBe(1)
  })

  it('refuses a malformed batch CSV with nothing dispatched', async () => {
    const badCsv = join(directory, 'bad-rows.csv')
    writeFileSync(
      badCsv,
      [
        'contact,reference,date,description,quantity,unitAmount',
        'Acme Ltd,REF-1,2026-02-30,Consulting,2,150.00',
        '',
      ].join('\n'),
    )

    const output = await runCommand([
      '--file',
      badCsv,
      '--identity',
      identityPath,
      '--account-code',
      '200',
      '--source-receipt-id',
      SOURCE_RECEIPT_ID,
      '--source-manifest-hash',
      SOURCE_MANIFEST_HASH,
      '--execute',
    ])

    expect(output.error?.message).toMatch(/INVALID_BATCH_CSV/)
    expect(transportControl.dispatches).toHaveLength(0)
    expect(sinkControl.built).toBe(0)
  })

  it('refuses an identity that does not bind the resolved profile', async () => {
    profileConfig.defaultProfile = 'a-different-profile'

    const output = await runCommand(baseArgs(['--execute']))

    expect(output.error?.message).toMatch(/TARGET_MISMATCH/)
    expect(transportControl.dispatches).toHaveLength(0)
  })

  it('refuses a manifest that went stale before dispatch, with nothing dispatched', async () => {
    sinkControl.onCreate = () => {
      clock.value = NOW + 600_000
    }

    const output = await runCommand(baseArgs(['--execute', '--ttl-ms', '60000']))

    expect(output.error?.message).toMatch(/MANIFEST_EXPIRED|PREFLIGHT_FAILED/)
    expect(transportControl.dispatches).toHaveLength(0)
    expect(sinkControl.links).toBe(0)
    expect(sinkControl.receipts).toBe(0)
  })
})
