import {decode} from '@toon-format/toon'
import {describe, expect, it, vi} from 'vitest'
import AgedPayables from '../../src/commands/reports/aged-payables.js'
import AgedReceivables from '../../src/commands/reports/aged-receivables.js'
import BalanceSheet from '../../src/commands/reports/balance-sheet.js'
import ProfitAndLoss from '../../src/commands/reports/profit-and-loss.js'
import TrialBalance from '../../src/commands/reports/trial-balance.js'

const report = {
  reportName: 'Synthetic report',
  reportDate: '2026-09-01',
  rows: [{rows: [{cells: ['Synthetic account', '10', '20', '30', '40'].map(value => ({value}))}]}],
}
const cases = [
  {
    command: AgedPayables,
    rows: [{date: 'Synthetic account', reference: '10', due: '20', paid: '30', credited: '40'}],
    header: 'Date,Reference,Due,Paid,Credited',
  },
  {
    command: AgedReceivables,
    rows: [{date: 'Synthetic account', reference: '10', due: '20', paid: '30', credited: '40'}],
    header: 'Date,Reference,Due,Paid,Credited',
  },
  {command: BalanceSheet, rows: [{account: 'Synthetic account', amount: '10'}], header: 'Account,Amount'},
  {command: ProfitAndLoss, rows: [{account: 'Synthetic account', amount: '10'}], header: 'Account,Amount'},
  {
    command: TrialBalance,
    rows: [{account: 'Synthetic account', debit: '10', credit: '20'}],
    header: 'Account,Debit,Credit',
  },
]

describe.each(cases)('$command.name output selection', ({command, rows, header}) => {
  async function render(flags: {toon?: boolean; csv?: boolean; json?: boolean}) {
    // Bypass only parsing and the live provider seam; exercise run, row extraction
    // and the inherited formatter unchanged. No credentials or network are used.
    const instance = Object.create(command.prototype)
    instance.parse = vi.fn().mockResolvedValue({flags})
    instance.xeroCall = vi.fn().mockResolvedValue(report)
    const output: string[] = []
    instance.log = (line: string) => output.push(line)
    await instance.run()
    expect(instance.xeroCall).toHaveBeenCalledTimes(1)
    return output
  }

  it('renders decodable TOON rows instead of a table', async () => {
    const output = await render({toon: true})
    expect(decode(output.at(-1) ?? '')).toEqual(rows)
    expect(output.at(-1)).not.toContain('│')
    expect(output[0]).toBe('\nSynthetic report')
  })

  it('preserves the default table', async () => {
    const output = await render({})
    expect(output.at(-1)).toContain('│')
  })

  it('preserves CSV presentation', async () => {
    const output = await render({csv: true})
    expect(output.at(-1)?.split('\n')[0]).toBe(header)
  })

  it('preserves the raw JSON report', async () => {
    const output = await render({json: true})
    expect(output).toHaveLength(1)
    expect(JSON.parse(output[0])).toEqual(report)
  })
})
