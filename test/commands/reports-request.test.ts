import {createRequire} from 'node:module'
import {Parser} from '@oclif/core'
import type {AxiosStatic, InternalAxiosRequestConfig} from 'axios'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {AccountingApi} from 'xero-node'
import BalanceSheet from '../../src/commands/reports/balance-sheet.js'
import ProfitAndLoss from '../../src/commands/reports/profit-and-loss.js'
import TrialBalance from '../../src/commands/reports/trial-balance.js'

// Resolve the SDK's own CommonJS Axios instance; an ESM mock would not intercept it.
const require = createRequire(import.meta.url)
const sdkRequire = createRequire(require.resolve('xero-node'))
const axios = sdkRequire('axios') as AxiosStatic
const originalAdapter = axios.defaults.adapter
afterEach(() => {
  axios.defaults.adapter = originalAdapter
})

const cases = [
  {
    command: ProfitAndLoss,
    name: 'profit-and-loss',
    path: '/api.xro/2.0/Reports/ProfitAndLoss',
    args: ['--from', '2026-01-01', '--to', '2026-09-30', '--periods', '2', '--timeframe', 'QUARTER'],
    query: {fromDate: '2026-01-01', toDate: '2026-09-30', periods: '2', timeframe: 'QUARTER'},
  },
  {
    command: BalanceSheet,
    name: 'balance-sheet',
    path: '/api.xro/2.0/Reports/BalanceSheet',
    args: [
      '--date',
      '2026-09-30',
      '--periods',
      '2',
      '--timeframe',
      'QUARTER',
      '--tracking-option-id-1',
      'synthetic-option-1',
      '--tracking-option-id-2',
      'synthetic-option-2',
    ],
    query: {
      date: '2026-09-30',
      periods: '2',
      timeframe: 'QUARTER',
      trackingOptionID1: 'synthetic-option-1',
      trackingOptionID2: 'synthetic-option-2',
    },
  },
]
const combinations = [
  {args: [], query: {}},
  {args: ['--payments-only'], query: {paymentsOnly: 'true'}},
  {args: ['--standard-layout'], query: {standardLayout: 'true'}},
  {args: ['--payments-only', '--standard-layout'], query: {paymentsOnly: 'true', standardLayout: 'true'}},
]

describe.each(cases)('$name SDK request contract', ({command, path, args, query}) => {
  it.each(combinations)('serializes the correct query names for $args', async combination => {
    // Replace only the HTTP boundary, keeping SDK argument handling and URL serialization real.
    const transport = vi.fn(async (config: InternalAxiosRequestConfig) => {
      return {
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
        data: {Reports: [{ReportName: 'Synthetic report', Rows: []}]},
      }
    })
    axios.defaults.adapter = transport
    const api = new AccountingApi()
    // Parse the real flag definitions without loading unrelated commands or user config.
    const flags = (await Parser.parse([...args, ...combination.args, '--json'], {flags: command.flags})).flags
    const instance = Object.create(command.prototype)
    const output: string[] = []
    Object.assign(instance, {
      parse: async () => ({flags}),
      xeroCall: async (
        _flags: unknown,
        call: (xero: {accountingApi: AccountingApi}, tenant: string) => Promise<unknown>,
      ) => call({accountingApi: api}, 'synthetic-tenant'),
      log: (line: string) => output.push(line),
    })
    await instance.run()
    expect(transport).toHaveBeenCalledTimes(1)
    const request = transport.mock.calls[0][0]
    const url = new URL(axios.getUri(request))
    expect(request.method).toBe('get')
    expect(request.headers['xero-tenant-id']).toBe('synthetic-tenant')
    expect(url.pathname).toBe(path)
    expect(Object.fromEntries(url.searchParams)).toEqual({...query, ...combination.query})
    expect(JSON.parse(output.join('\n'))).toMatchObject({reportName: 'Synthetic report', rows: []})
  })
})

it.each([ProfitAndLoss, BalanceSheet, TrialBalance].map(command => ({command, name: command.name})))(
  '$name describes payments-only as cash-basis reporting',
  ({command}) => {
    expect(command.flags['payments-only'].description).toBe('Use cash-basis reporting')
  },
)
