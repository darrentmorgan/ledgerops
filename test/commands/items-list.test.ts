import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterAll, afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {XeroClient} from 'xero-node'
import ItemsList from '../../src/commands/items/list.js'

const TENANT = 'synthetic-items-tenant'
const boundary = vi.hoisted(() => ({createClient: vi.fn()}))

vi.mock('../../src/lib/profiles.js', () => ({
  getDefaultProfile: () => 'synthetic-items-profile',
  getProfileClientId: () => 'synthetic-items-client-id',
}))

vi.mock('../../src/lib/xero-client.js', () => ({
  withRetry: async (
    _profile: string,
    _clientId: string,
    operation: (client: XeroClient, tenantId: string) => Promise<unknown>,
  ) => operation(boundary.createClient(), TENANT),
}))

// Use the SDK's own Axios instance and an offline adapter: getItems still builds
// the real request and deserializes the synthetic API response, without sockets.
const require = createRequire(import.meta.url)
const sdkRequire = createRequire(require.resolve('xero-node'))
const axios = sdkRequire('axios') as typeof import('axios').default
const originalAdapter = axios.defaults.adapter
const request = vi.fn()
const ITEMS = [
  {
    itemID: '00000000-0000-0000-0000-000000000001',
    code: 'SYNTHETIC-ITEM',
    name: 'Synthetic item',
    description: 'Synthetic description',
    salesDetails: {unitPrice: 12.3456},
    purchaseDetails: {unitPrice: 5.4321},
  },
]
let responseItems: typeof ITEMS | undefined
let getItems: ReturnType<typeof vi.spyOn>

const CLI_ROOT = mkdtempSync(join(tmpdir(), 'ledgerops-items-list-cli-'))
writeFileSync(
  join(CLI_ROOT, 'package.json'),
  JSON.stringify({
    name: 'synthetic-test-profile',
    version: '1.0.0',
    type: 'module',
    oclif: {bin: 'synthetic-test-profile', commands: join(process.cwd(), 'dist', 'commands')},
  }),
)

beforeEach(() => {
  request.mockClear()
  boundary.createClient.mockReset()
  const xero = new XeroClient()
  getItems = vi.spyOn(xero.accountingApi, 'getItems')
  boundary.createClient.mockReturnValue(xero)
  responseItems = ITEMS
  axios.defaults.adapter = async config => {
    request(config)
    return {
      config,
      status: 200,
      statusText: 'OK',
      headers: {},
      data: {
        Items: responseItems?.map(item => ({
          ItemID: item.itemID,
          Code: item.code,
          Name: item.name,
          Description: item.description,
          SalesDetails: {UnitPrice: item.salesDetails.unitPrice},
          PurchaseDetails: {UnitPrice: item.purchaseDetails.unitPrice},
        })),
      },
    }
  }
})

afterEach(() => {
  axios.defaults.adapter = originalAdapter
  vi.restoreAllMocks()
})
afterAll(() => rmSync(CLI_ROOT, {recursive: true, force: true}))

async function runCommand(args: string[]) {
  const stdout: string[] = []
  const stderr: string[] = []
  const previousExitCode = process.exitCode
  const log = vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
    stdout.push(`${values.map(String).join(' ')}\n`)
  })
  const errorLog = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
    stderr.push(`${values.map(String).join(' ')}\n`)
  })
  let error: Error | undefined
  process.exitCode = undefined
  try {
    await ItemsList.run(args, {root: CLI_ROOT})
  } catch (caught) {
    error = caught instanceof Error ? caught : new Error(String(caught))
  } finally {
    log.mockRestore()
    errorLog.mockRestore()
    process.exitCode = previousExitCode
  }
  return {error, stdout: stdout.join(''), stderr: stderr.join('')}
}

function expectSingleUnpagedRequest() {
  expect(getItems).toHaveBeenCalledExactlyOnceWith(TENANT)
  expect(request).toHaveBeenCalledTimes(1)
  const config = request.mock.calls[0][0]
  expect(config.method).toBe('get')
  expect(config.headers['xero-tenant-id']).toBe(TENANT)
  expect(config.params).toEqual({})
  const url = new URL(axios.getUri(config))
  expect(url.pathname).toBe('/api.xro/2.0/Items')
  expect(url.searchParams.has('page')).toBe(false)
  expect(url.searchParams.has('unitdp')).toBe(false)
}

describe('items list request and output', () => {
  it('calls the SDK once without pagination or decimal precision and preserves the JSON array', async () => {
    const output = await runCommand(['--json'])
    expect(output.error).toBeUndefined()
    expectSingleUnpagedRequest()
    expect(JSON.parse(output.stdout)).toEqual(ITEMS)
    expect(output.stderr).toBe('')
  })

  it('preserves the table columns and formatted prices', async () => {
    const output = await runCommand([])
    expect(output.error).toBeUndefined()
    expectSingleUnpagedRequest()
    for (const text of [
      'ID',
      'Code',
      'Name',
      'Description',
      'Sale Price',
      'Purchase Price',
      'SYNTHETIC-ITEM',
      'Synthetic item',
      'Synthetic description',
      '12.35',
      '5.43',
    ]) {
      expect(output.stdout).toContain(text)
    }
  })

  it('preserves CSV presentation', async () => {
    const output = await runCommand(['--csv'])
    expect(output.error).toBeUndefined()
    expectSingleUnpagedRequest()
    expect(output.stdout.split('\n').slice(0, 2)).toEqual([
      'ID,Code,Name,Description,Sale Price,Purchase Price',
      `${ITEMS[0].itemID},SYNTHETIC-ITEM,Synthetic item,Synthetic description,12.3456,5.4321`,
    ])
  })

  it.each([{items: []}, {items: undefined}])('returns an empty JSON array for collection $items', async ({items}) => {
    responseItems = items
    const output = await runCommand(['--json'])
    expect(output.error).toBeUndefined()
    expectSingleUnpagedRequest()
    expect(JSON.parse(output.stdout)).toEqual([])
  })

  it.each([['--page', '2'], ['--page=2'], ['--page', '1', '--json']])(
    'rejects retired page syntax %j before client creation or API dispatch',
    async (...args) => {
      const output = await runCommand(args)
      expect(output.error?.message).toContain('Nonexistent flag: --page')
      expect(output.stdout).toBe('')
      expect(boundary.createClient).not.toHaveBeenCalled()
      expect(getItems).not.toHaveBeenCalled()
      expect(request).not.toHaveBeenCalled()
    },
  )
})
