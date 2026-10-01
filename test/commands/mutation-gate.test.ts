import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {default as InvoicesCreate} from '../../src/commands/invoices/create.js'
import {default as PaymentsCreate} from '../../src/commands/payments/create.js'

const TENANT = 'synthetic-gate-tenant-must-not-echo'

const api = vi.hoisted(() => ({
  createInvoices: vi.fn(),
  createPayment: vi.fn(),
  getOrganisations: vi.fn(),
}))

const profileConfig = vi.hoisted(() => ({
  defaultProfile: 'synthetic-gate-profile',
  clientId: 'synthetic-gate-client-id',
  resolves: 0,
}))

const seenTargets = vi.hoisted(() => [] as {profileName: string; clientId: string}[])

const interactive = vi.hoisted(() => ({
  calls: [] as {options: {input?: unknown; output?: unknown}}[],
  queries: [] as string[],
  answer: 'y',
  onQuestion: undefined as undefined | (() => void),
}))

vi.mock('../../src/lib/profiles.js', () => ({
  getDefaultProfile: () => {
    profileConfig.resolves += 1
    return profileConfig.defaultProfile
  },
  getProfileClientId: () => profileConfig.clientId,
}))

vi.mock('../../src/lib/xero-client.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/lib/xero-client.js')>()
  const fakeCreateClient = async (profileName: string, clientId: string) => {
    seenTargets.push({profileName, clientId})
    return {
      xero: {
        accountingApi: {
          createInvoices: api.createInvoices,
          createPayment: api.createPayment,
          getOrganisations: api.getOrganisations,
        },
      },
      tenantId: TENANT,
    }
  }
  return {
    ...actual,
    createXeroClient: fakeCreateClient,
    withRetry: (
      profileName: string,
      clientId: string,
      operation: (client: unknown, tenantId: string) => Promise<unknown>,
    ) => actual.withRetry(profileName, clientId, operation, 2, {createClient: fakeCreateClient}),
    withSingleAttempt: (
      profileName: string,
      clientId: string,
      operation: (client: unknown, tenantId: string) => Promise<unknown>,
    ) => actual.withSingleAttempt(profileName, clientId, operation, {createClient: fakeCreateClient}),
  }
})

vi.mock('node:readline/promises', () => ({
  createInterface: (options: {input?: unknown; output?: unknown}) => {
    interactive.calls.push({options})
    return {
      question: async (query?: string) => {
        interactive.queries.push(String(query))
        interactive.onQuestion?.()
        return interactive.answer
      },
      close: () => {},
    }
  },
}))

const CLI_ROOT = mkdtempSync(join(tmpdir(), 'ledgerops-mutation-gate-cli-'))
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

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'ledgerops-mutation-gate-'))
})

afterAll(() => {
  rmSync(directory, {recursive: true, force: true})
  rmSync(CLI_ROOT, {recursive: true, force: true})
})

beforeEach(() => {
  api.createInvoices.mockReset()
  api.createPayment.mockReset()
  api.getOrganisations.mockReset()
  profileConfig.defaultProfile = 'synthetic-gate-profile'
  profileConfig.clientId = 'synthetic-gate-client-id'
  profileConfig.resolves = 0
  seenTargets.length = 0
  interactive.calls.length = 0
  interactive.queries.length = 0
  interactive.answer = 'y'
  interactive.onQuestion = undefined
})

function writeFixture(name: string, data: unknown): string {
  const path = join(directory, name)
  writeFileSync(path, JSON.stringify(data))
  return path
}

async function runCommand(
  command: {run(args?: string[], config?: {root: string}): Promise<unknown>},
  args: readonly string[],
) {
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
    await command.run([...args], {root: CLI_ROOT})
  } catch (caught) {
    error = caught instanceof Error ? caught : new Error(String(caught))
  } finally {
    consoleLog.mockRestore()
    consoleError.mockRestore()
    process.exitCode = previousExitCode
  }
  return {error, stdout: stdout.join(''), stderr: stderr.join('')}
}

const invoiceFile = {
  type: 'ACCREC',
  contactId: '00000000-0000-0000-0000-00000000aaa1',
  lineItems: [{description: 'Consulting', quantity: 2, unitAmount: 150, accountCode: '200'}],
}

const paymentFile = {
  invoiceId: '00000000-0000-0000-0000-00000000bbb1',
  accountId: '00000000-0000-0000-0000-00000000bbb2',
  amount: 500,
}

const PREVIEW_KEYS = ['schemaVersion', 'operation', 'resource', 'profile', 'payloadDigest', 'payload', 'willDispatch']

describe('invoice create execution gate boundary', () => {
  it('previews with zero API dispatches when --execute is absent', async () => {
    const output = await runCommand(InvoicesCreate, ['--file', writeFixture('invoice.json', invoiceFile)])

    expect(output.error).toBeUndefined()
    expect(api.createInvoices).not.toHaveBeenCalled()
    expect(api.createPayment).not.toHaveBeenCalled()
    expect(api.getOrganisations).not.toHaveBeenCalled()
    expect(output.stdout).toContain('PREVIEW')
    expect(output.stdout).toContain('--execute')
    expect(output.stdout).toMatch(/sha256:[0-9a-f]{64}/)
    expect(output.stdout).toContain(invoiceFile.type)
    expect(output.stdout).not.toContain(TENANT)
  })

  it('emits a stable versioned preview schema under --json', async () => {
    const output = await runCommand(InvoicesCreate, [
      '--json',
      '--file',
      writeFixture('invoice-json.json', invoiceFile),
    ])

    expect(output.error).toBeUndefined()
    const printed = JSON.parse(output.stdout) as Record<string, unknown>
    expect(Object.keys(printed)).toEqual(PREVIEW_KEYS)
    expect(printed.schemaVersion).toBe('ledgerops.mutation-preview.v1')
    expect(printed.operation).toBe('create')
    expect(printed.resource).toBe('invoices')
    expect(printed.profile).toBe('synthetic-gate-profile')
    expect(String(printed.payloadDigest)).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(printed.willDispatch).toBe(false)
  })

  it('emits deterministic CSV and TOON previews', async () => {
    const csv = await runCommand(InvoicesCreate, ['--csv', '--file', writeFixture('invoice-csv.json', invoiceFile)])
    expect(csv.error).toBeUndefined()
    const csvLines = csv.stdout.trim().split('\n')
    expect(csvLines[0]).toBe('schemaVersion,operation,resource,profile,payloadDigest,payload,willDispatch')
    expect(csv.stdout).toContain('ledgerops.mutation-preview.v1')
    expect(csv.stdout).toContain(',invoices,')

    const toon = await runCommand(InvoicesCreate, ['--toon', '--file', writeFixture('invoice-toon.json', invoiceFile)])
    expect(toon.error).toBeUndefined()
    expect(toon.stdout).toContain('ledgerops.mutation-preview.v1')
    expect(toon.stdout).toContain('willDispatch')

    const toonAgain = await runCommand(InvoicesCreate, [
      '--toon',
      '--file',
      writeFixture('invoice-toon-again.json', invoiceFile),
    ])
    expect(toonAgain.stdout).toBe(toon.stdout)
  })

  it('dispatches exactly one create with --execute', async () => {
    api.createInvoices.mockResolvedValue({body: {invoices: [{invoiceID: 'inv-1', invoiceNumber: 'INV-400'}]}})
    api.getOrganisations.mockResolvedValue({body: {organisations: [{shortCode: 'sc1'}]}})

    const output = await runCommand(InvoicesCreate, [
      '--file',
      writeFixture('invoice-execute.json', invoiceFile),
      '--execute',
    ])

    expect(output.error).toBeUndefined()
    expect(api.createInvoices).toHaveBeenCalledTimes(1)
    expect(api.createPayment).not.toHaveBeenCalled()
    expect(output.stdout).toContain('INV-400')
    expect(output.stdout).not.toContain('ledgerops.mutation-preview.v1')
  })

  it('accepts --yes alongside --execute without changing the single dispatch', async () => {
    api.createInvoices.mockResolvedValue({body: {invoices: [{invoiceID: 'inv-2', invoiceNumber: 'INV-401'}]}})

    const output = await runCommand(InvoicesCreate, [
      '--file',
      writeFixture('invoice-execute-yes.json', invoiceFile),
      '--execute',
      '--yes',
    ])

    expect(output.error).toBeUndefined()
    expect(api.createInvoices).toHaveBeenCalledTimes(1)
    expect(output.stdout).toContain('INV-401')
  })

  it('never replays the mutation after a 401 authentication failure', async () => {
    api.createInvoices.mockRejectedValue(new Error(JSON.stringify({response: {statusCode: 401}})))

    const output = await runCommand(InvoicesCreate, [
      '--file',
      writeFixture('invoice-401.json', invoiceFile),
      '--execute',
    ])

    expect(api.createInvoices).toHaveBeenCalledTimes(1)
    expect(output.error?.message).toMatch(/session expired|re-authenticate/i)
    expect(api.getOrganisations).not.toHaveBeenCalled()
  })

  it('dispatches piped --execute --json without --yes, unprompted, JSON alone on stdout', async () => {
    api.createInvoices.mockResolvedValue({body: {invoices: [{invoiceID: 'inv-pipe', invoiceNumber: 'INV-403'}]}})
    api.getOrganisations.mockResolvedValue({body: {organisations: [{shortCode: 'sc1'}]}})

    const output = await runCommand(InvoicesCreate, [
      '--json',
      '--file',
      writeFixture('invoice-json-noconfirm.json', invoiceFile),
      '--execute',
    ])

    expect(output.error).toBeUndefined()
    expect(api.createInvoices).toHaveBeenCalledTimes(1)
    expect(profileConfig.resolves).toBe(1)
    const printed = JSON.parse(output.stdout) as Record<string, unknown>
    expect(printed).toEqual(expect.objectContaining({invoiceID: 'inv-pipe'}))
    expect(output.stdout).not.toContain('ledgerops.mutation-preview.v1')
    expect(interactive.calls).toHaveLength(0)
  })

  it('dispatches human-readable output over a pipe without prompting', async () => {
    api.createInvoices.mockResolvedValue({body: {invoices: [{invoiceID: 'inv-text', invoiceNumber: 'INV-406'}]}})
    api.getOrganisations.mockResolvedValue({body: {organisations: [{shortCode: 'sc1'}]}})

    const output = await runCommand(InvoicesCreate, [
      '--file',
      writeFixture('invoice-text-pipe.json', invoiceFile),
      '--execute',
    ])

    expect(output.error).toBeUndefined()
    expect(api.createInvoices).toHaveBeenCalledTimes(1)
    expect(output.stdout).toContain('Invoice created:')
    expect(interactive.calls).toHaveLength(0)
  })

  it('never prompts when stdin is a TTY but stdout is a pipe', async () => {
    api.createInvoices.mockResolvedValue({body: {invoices: [{invoiceID: 'inv-tty', invoiceNumber: 'INV-404'}]}})
    api.getOrganisations.mockResolvedValue({body: {organisations: [{shortCode: 'sc1'}]}})

    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
    Object.defineProperty(process.stdin, 'isTTY', {value: true, configurable: true})
    try {
      const output = await runCommand(InvoicesCreate, [
        '--json',
        '--file',
        writeFixture('invoice-tty-stdin.json', invoiceFile),
        '--execute',
      ])
      expect(output.error).toBeUndefined()
      expect(api.createInvoices).toHaveBeenCalledTimes(1)
      const printed = JSON.parse(output.stdout) as Record<string, unknown>
      expect(printed).toEqual(expect.objectContaining({invoiceID: 'inv-tty'}))
      expect(interactive.calls).toHaveLength(0)
    } finally {
      if (stdinDescriptor) {
        Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor)
      } else {
        delete (process.stdin as {isTTY?: boolean}).isTTY
      }
    }
  })

  it('confirms on stderr over dual TTYs, declines without dispatching, or accepts into one dispatch', async () => {
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
    Object.defineProperty(process.stdin, 'isTTY', {value: true, configurable: true})
    Object.defineProperty(process.stdout, 'isTTY', {value: true, configurable: true})

    try {
      interactive.answer = 'n'
      api.createInvoices.mockResolvedValue({body: {invoices: [{invoiceID: 'inv-no'}]}})
      const declined = await runCommand(InvoicesCreate, [
        '--file',
        writeFixture('invoice-decline.json', invoiceFile),
        '--execute',
      ])
      expect(interactive.calls).toHaveLength(1)
      expect(interactive.calls[0].options.input).toBe(process.stdin)
      expect(interactive.calls[0].options.output).toBe(process.stderr)
      expect(api.createInvoices).not.toHaveBeenCalled()
      expect(declined.error?.message).toMatch(/declined/i)
      expect(declined.stdout).not.toContain('Invoice created')

      interactive.answer = 'yes'
      interactive.onQuestion = () => {
        profileConfig.defaultProfile = 'rotated-profile'
        profileConfig.clientId = 'rotated-client-id'
      }
      const callsBeforeAccept = interactive.calls.length
      profileConfig.resolves = 0
      api.createInvoices.mockClear()
      api.createInvoices.mockResolvedValue({body: {invoices: [{invoiceID: 'inv-yes', invoiceNumber: 'INV-405'}]}})
      const accepted = await runCommand(InvoicesCreate, [
        '--file',
        writeFixture('invoice-accept.json', invoiceFile),
        '--execute',
      ])
      expect(interactive.calls.length).toBe(callsBeforeAccept + 1)
      expect(profileConfig.resolves).toBe(1)
      expect(accepted.error).toBeUndefined()
      expect(api.createInvoices).toHaveBeenCalledTimes(1)
      expect(accepted.stdout).toContain('INV-405')
      expect(seenTargets).toEqual([{profileName: 'synthetic-gate-profile', clientId: 'synthetic-gate-client-id'}])
      expect(JSON.stringify(seenTargets)).not.toContain('rotated')
      expect(profileConfig.resolves).toBe(1)
    } finally {
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
  })

  it('never dispatches on --yes alone', async () => {
    const output = await runCommand(InvoicesCreate, [
      '--file',
      writeFixture('invoice-yes-only.json', invoiceFile),
      '--yes',
    ])

    expect(output.error).toBeUndefined()
    expect(api.createInvoices).not.toHaveBeenCalled()
    expect(output.stdout).toContain('PREVIEW')
  })

  it('never prompts for human-readable --execute when only stdin is a TTY and stdout is a pipe', async () => {
    api.createInvoices.mockResolvedValue({body: {invoices: [{invoiceID: 'inv-text-tty', invoiceNumber: 'INV-407'}]}})
    api.getOrganisations.mockResolvedValue({body: {organisations: [{shortCode: 'sc1'}]}})

    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
    Object.defineProperty(process.stdin, 'isTTY', {value: true, configurable: true})
    try {
      const output = await runCommand(InvoicesCreate, [
        '--file',
        writeFixture('invoice-text-tty.json', invoiceFile),
        '--execute',
      ])

      expect(output.error).toBeUndefined()
      expect(api.createInvoices).toHaveBeenCalledTimes(1)
      expect(interactive.calls).toHaveLength(0)
      expect(interactive.queries).toHaveLength(0)
      expect(output.stdout).toContain('Invoice created:')
      expect(output.stdout).toContain('INV-407')
      expect(output.stdout).not.toContain('PENDING MUTATION')
      expect(output.stdout).not.toMatch(/sha256:[0-9a-f]{64}/)
    } finally {
      if (stdinDescriptor) {
        Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor)
      } else {
        delete (process.stdin as {isTTY?: boolean}).isTTY
      }
    }
  })

  it('honors --csv and --toon for the dispatch result over dual TTYs with one dispatch', async () => {
    api.createInvoices.mockResolvedValue({
      body: {invoices: [{invoiceID: 'inv-csv-1', invoiceNumber: 'INV-408', status: 'DRAFT'}]},
    })
    api.getOrganisations.mockResolvedValue({body: {organisations: [{shortCode: 'sc1'}]}})

    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
    Object.defineProperty(process.stdin, 'isTTY', {value: true, configurable: true})
    Object.defineProperty(process.stdout, 'isTTY', {value: true, configurable: true})

    try {
      const csv = await runCommand(InvoicesCreate, [
        '--csv',
        '--file',
        writeFixture('invoice-csv-execute.json', invoiceFile),
        '--execute',
      ])
      expect(csv.error).toBeUndefined()
      expect(interactive.calls).toHaveLength(0)
      expect(api.createInvoices).toHaveBeenCalledTimes(1)
      const csvLines = csv.stdout.trim().split('\n')
      expect(csvLines[0]).toBe('invoiceID,invoiceNumber,status')
      expect(csvLines[1]).toBe('inv-csv-1,INV-408,DRAFT')
      expect(csv.stdout).not.toContain('Invoice created:')
      expect(csv.stdout).not.toContain('ledgerops.mutation-preview.v1')

      interactive.calls.length = 0
      api.createInvoices.mockClear()
      api.createInvoices.mockResolvedValue({
        body: {invoices: [{invoiceID: 'inv-toon-1', invoiceNumber: 'INV-409', status: 'DRAFT'}]},
      })
      const toon = await runCommand(InvoicesCreate, [
        '--toon',
        '--file',
        writeFixture('invoice-toon-execute.json', invoiceFile),
        '--execute',
      ])
      expect(toon.error).toBeUndefined()
      expect(interactive.calls).toHaveLength(0)
      expect(api.createInvoices).toHaveBeenCalledTimes(1)
      expect(toon.stdout).toContain('invoiceNumber')
      expect(toon.stdout).toContain('INV-409')

      api.createInvoices.mockClear()
      api.createInvoices.mockResolvedValue({
        body: {invoices: [{invoiceID: 'inv-toon-1', invoiceNumber: 'INV-409', status: 'DRAFT'}]},
      })
      const toonAgain = await runCommand(InvoicesCreate, [
        '--toon',
        '--file',
        writeFixture('invoice-toon-execute-again.json', invoiceFile),
        '--execute',
      ])
      expect(toonAgain.stdout).toBe(toon.stdout)
    } finally {
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
  })

  it('shows the pending-mutation preview and prompt on stderr before confirmation over dual TTYs', async () => {
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
    Object.defineProperty(process.stdin, 'isTTY', {value: true, configurable: true})
    Object.defineProperty(process.stdout, 'isTTY', {value: true, configurable: true})

    try {
      interactive.answer = 'n'
      const output = await runCommand(InvoicesCreate, [
        '--file',
        writeFixture('invoice-boundary.json', invoiceFile),
        '--execute',
      ])

      expect(interactive.calls).toHaveLength(1)
      const onStderr = output.stderr
      expect(onStderr).toContain('PENDING MUTATION')
      expect(onStderr).toContain('create invoices')
      expect(onStderr).toContain('profile: synthetic-gate-profile')
      expect(onStderr).toMatch(/digest:\s+sha256:[0-9a-f]{64}/)
      expect(onStderr).toContain('- type ACCREC')
      expect(onStderr).not.toContain(profileConfig.clientId)
      expect(interactive.calls[0].options.output).toBe(process.stderr)
      expect(interactive.queries.at(-1)).toContain("Type 'yes' to confirm")
      expect(output.stdout).not.toContain('PENDING MUTATION')
      expect(output.stdout).not.toMatch(/sha256:[0-9a-f]{64}/)
      expect(api.createInvoices).not.toHaveBeenCalled()
      expect(output.error?.message).toMatch(/declined/i)
    } finally {
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
  })

  it("rejects shorthand 'y' at the confirmation prompt and accepts exact yes variants", async () => {
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
    Object.defineProperty(process.stdin, 'isTTY', {value: true, configurable: true})
    Object.defineProperty(process.stdout, 'isTTY', {value: true, configurable: true})

    try {
      api.createInvoices.mockResolvedValue({body: {invoices: [{invoiceID: 'inv-shorthand'}]}})
      interactive.answer = 'y'
      const shorthand = await runCommand(InvoicesCreate, [
        '--file',
        writeFixture('invoice-y.json', invoiceFile),
        '--execute',
      ])
      expect(api.createInvoices).not.toHaveBeenCalled()
      expect(shorthand.error?.message).toMatch(/declined/i)

      interactive.answer = ' YES '
      api.createInvoices.mockClear()
      api.createInvoices.mockResolvedValue({body: {invoices: [{invoiceID: 'inv-exact'}]}})
      const accepted = await runCommand(InvoicesCreate, [
        '--file',
        writeFixture('invoice-yes-variant.json', invoiceFile),
        '--execute',
      ])
      expect(accepted.error).toBeUndefined()
      expect(api.createInvoices).toHaveBeenCalledTimes(1)
      expect(accepted.stdout).toContain('Invoice created:')
    } finally {
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
  })
})

describe('target resolution precedes payload validation', () => {
  it('errors without any preview when the profile does not resolve', async () => {
    profileConfig.defaultProfile = ''
    const output = await runCommand(InvoicesCreate, ['--file', writeFixture('invoice-noprofile.json', invoiceFile)])

    expect(output.error?.message).toMatch(/No profile configured/)
    expect(output.stdout).not.toContain('PREVIEW')
    expect(api.createInvoices).not.toHaveBeenCalled()
    expect(api.createPayment).not.toHaveBeenCalled()
    expect(profileConfig.resolves).toBe(1)
  })

  it('resolves the target first, then fails closed on a malformed payload', async () => {
    const malformed = {type: 'NOT-A-TYPE', lineItems: []}
    const output = await runCommand(InvoicesCreate, ['--file', writeFixture('invoice-bad.json', malformed)])

    expect(output.error?.message).toMatch(/Validation errors/)
    expect(profileConfig.resolves).toBe(1)
    expect(api.createInvoices).not.toHaveBeenCalled()
    expect(api.getOrganisations).not.toHaveBeenCalled()
  })

  it('fails closed on syntactically invalid JSON before any dispatch', async () => {
    const path = join(directory, 'invoice-syntax.json')
    writeFileSync(path, '{not valid json')
    const output = await runCommand(InvoicesCreate, ['--file', path])

    expect(output.error?.message).toMatch(/Invalid JSON in file/)
    expect(api.createInvoices).not.toHaveBeenCalled()
    expect(api.getOrganisations).not.toHaveBeenCalled()
  })

  it('reports the unresolvable target before payload problems when both are broken', async () => {
    profileConfig.defaultProfile = ''
    const malformed = {type: 'NOT-A-TYPE', lineItems: []}
    const output = await runCommand(InvoicesCreate, ['--file', writeFixture('invoice-both.json', malformed)])

    expect(output.error?.message).toMatch(/No profile configured/)
    expect(output.stdout).not.toContain('PREVIEW')
    expect(api.createInvoices).not.toHaveBeenCalled()
  })

  it('mirrors fail-closed target resolution for payments create', async () => {
    profileConfig.defaultProfile = ''
    const output = await runCommand(PaymentsCreate, ['--file', writeFixture('payment-noprofile.json', paymentFile)])

    expect(output.error?.message).toMatch(/No profile configured/)
    expect(output.stdout).not.toContain('PREVIEW')
    expect(api.createPayment).not.toHaveBeenCalled()
  })
})

describe('payment create execution gate boundary', () => {
  it('previews with zero API dispatches when --execute is absent', async () => {
    const output = await runCommand(PaymentsCreate, ['--file', writeFixture('payment.json', paymentFile)])

    expect(output.error).toBeUndefined()
    expect(api.createPayment).not.toHaveBeenCalled()
    expect(api.getOrganisations).not.toHaveBeenCalled()
    expect(output.stdout).toContain('PREVIEW')
    expect(output.stdout).toContain('create payments')
    expect(output.stdout).not.toContain(TENANT)
  })

  it('dispatches exactly one create with --execute', async () => {
    api.createPayment.mockResolvedValue({body: {payments: [{paymentID: 'pay-1'}]}})
    api.getOrganisations.mockResolvedValue({body: {organisations: [{shortCode: 'sc1'}]}})

    const output = await runCommand(PaymentsCreate, [
      '--file',
      writeFixture('payment-execute.json', paymentFile),
      '--execute',
    ])

    expect(output.error).toBeUndefined()
    expect(api.createPayment).toHaveBeenCalledTimes(1)
    expect(api.createInvoices).not.toHaveBeenCalled()
    expect(output.stdout).toContain('pay-1')
    expect(output.stdout).not.toContain('ledgerops.mutation-preview.v1')
  })

  it('never replays the mutation after a 401 authentication failure', async () => {
    api.createPayment.mockRejectedValue(new Error(JSON.stringify({response: {statusCode: 401}})))

    const output = await runCommand(PaymentsCreate, [
      '--file',
      writeFixture('payment-401.json', paymentFile),
      '--execute',
    ])

    expect(api.createPayment).toHaveBeenCalledTimes(1)
    expect(output.error?.message).toMatch(/session expired|re-authenticate/i)
    expect(api.getOrganisations).not.toHaveBeenCalled()
  })

  it('emits a stable versioned preview schema under --json', async () => {
    const output = await runCommand(PaymentsCreate, [
      '--json',
      '--file',
      writeFixture('payment-json.json', paymentFile),
    ])

    expect(output.error).toBeUndefined()
    const printed = JSON.parse(output.stdout) as Record<string, unknown>
    expect(Object.keys(printed)).toEqual(PREVIEW_KEYS)
    expect(printed.operation).toBe('create')
    expect(printed.resource).toBe('payments')
  })

  it('honors --csv and --toon for the dispatch result with one dispatch', async () => {
    api.createPayment.mockResolvedValue({
      body: {payments: [{paymentID: 'pay-csv-1', amount: 500, status: 'AUTHORISED'}]},
    })
    api.getOrganisations.mockResolvedValue({body: {organisations: [{shortCode: 'sc1'}]}})

    const csv = await runCommand(PaymentsCreate, [
      '--csv',
      '--file',
      writeFixture('payment-csv-execute.json', paymentFile),
      '--execute',
    ])
    expect(csv.error).toBeUndefined()
    expect(interactive.calls).toHaveLength(0)
    expect(api.createPayment).toHaveBeenCalledTimes(1)
    const csvLines = csv.stdout.trim().split('\n')
    expect(csvLines[0]).toBe('paymentID,amount,status')
    expect(csvLines[1]).toBe('pay-csv-1,500,AUTHORISED')
    expect(csv.stdout).not.toContain('Payment created:')
    expect(csv.stdout).not.toContain('ledgerops.mutation-preview.v1')

    api.createPayment.mockClear()
    api.createPayment.mockResolvedValue({
      body: {payments: [{paymentID: 'pay-toon-1', amount: 500, status: 'AUTHORISED'}]},
    })
    const toon = await runCommand(PaymentsCreate, [
      '--toon',
      '--file',
      writeFixture('payment-toon-execute.json', paymentFile),
      '--execute',
    ])
    expect(toon.error).toBeUndefined()
    expect(api.createPayment).toHaveBeenCalledTimes(1)
    expect(toon.stdout).toContain('paymentID')
    expect(toon.stdout).toContain('pay-toon-1')
  })
})
