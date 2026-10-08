import {decode} from '@toon-format/toon'
import {describe, expect, it, vi} from 'vitest'
import AgedPayables from '../../src/commands/reports/aged-payables.js'
import AgedReceivables from '../../src/commands/reports/aged-receivables.js'
import BalanceSheet from '../../src/commands/reports/balance-sheet.js'
import ProfitAndLoss from '../../src/commands/reports/profit-and-loss.js'
import TrialBalance from '../../src/commands/reports/trial-balance.js'

const cases = [AgedPayables, AgedReceivables, BalanceSheet, ProfitAndLoss, TrialBalance].map(command => ({
  command,
  name: command.name,
}))
const cells = (...values: unknown[]) => values.map(value => ({value}))
const columns = ['', 'Current period', 'Prior period', 'Prior period', 'Other', 'Additional', 'Final']
const report = {
  reportName: 'Synthetic report',
  reportDate: '2026-09-01',
  rows: [
    {rowType: 'Header', cells: cells(...columns)},
    {
      rowType: 'Section',
      title: 'Synthetic section',
      rows: [
        {rowType: 'Row', cells: cells('Synthetic sales, "quoted"\nsecond line', '100', '200', 0, '0', '-10', '700')},
        {
          rowType: 'Section',
          title: 'Nested section',
          rows: [
            {rowType: 'Row', cells: cells('Short row', 0)},
            {rowType: 'SummaryRow', cells: cells('Nested total', '100', '200', 0, '0', '-10', '700')},
          ],
        },
        {rowType: 'SummaryRow', cells: cells('Synthetic total', '100', '200', 0, '0', '-10', '700')},
      ],
    },
    {rowType: 'Row', cells: cells('Top-level row', 0, '0')},
    {rowType: 'Header', cells: cells('Repeated header', '2026', '2025')},
  ],
}
const rows = [
  ['--- Synthetic section ---', '', '', '', '', '', ''],
  ['Synthetic sales, "quoted"\nsecond line', '100', '200', 0, '0', '-10', '700'],
  ['--- Nested section ---', '', '', '', '', '', ''],
  ['Short row', 0, '', '', '', '', ''],
  ['Nested total', '100', '200', 0, '0', '-10', '700'],
  ['Synthetic total', '100', '200', 0, '0', '-10', '700'],
  ['Top-level row', 0, '0', '', '', '', ''],
  ['Repeated header', '2026', '2025', '', '', '', ''],
]

// Parse the complete CSV stream, including quoted commas, quotes and newlines.
// Reject ragged records so any human headings on stdout fail the assertion.
function parseCsv(document: string): string[][] {
  const records: string[][] = []
  let record: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < document.length; index++) {
    const char = document[index]
    if (char === '"') {
      if (quoted && document[index + 1] === '"') {
        field += '"'
        index++
      } else {
        quoted = !quoted
      }
    } else if (!quoted && (char === ',' || char === '\n')) {
      record.push(field)
      field = ''
      if (char === '\n') {
        records.push(record)
        record = []
      }
    } else {
      field += char
    }
  }
  expect(quoted).toBe(false)
  if (field || record.length) records.push([...record, field])
  for (const row of records) expect(row).toHaveLength(records[0].length)
  return records
}

describe.each(cases)('$name report output', ({command}) => {
  function renderer(flags: {toon?: boolean; csv?: boolean; json?: boolean; periods?: number}, data: unknown = report) {
    // Bypass only parsing and the live provider seam; exercise the actual run.
    const instance = Object.create(command.prototype)
    instance.parse = vi.fn().mockResolvedValue({flags})
    instance.xeroCall = vi.fn().mockResolvedValue(data)
    const output: string[] = []
    instance.log = (line: string) => output.push(line)
    instance.error = (message: string) => {
      throw new Error(message)
    }
    return {instance, output, stdout: () => output.map(line => `${line}\n`).join('')}
  }

  it('exports every provider column and row as one complete TOON document', async () => {
    const {instance, output, stdout} = renderer({toon: true, periods: 2})
    await instance.run()
    expect(decode(stdout())).toEqual({columns, rows})
    expect(output).toHaveLength(1)
    expect(instance.xeroCall).toHaveBeenCalledTimes(1)
  })

  it('exports every provider column and row as one complete CSV document', async () => {
    const {instance, output, stdout} = renderer({csv: true, periods: 2})
    await instance.run()
    expect(parseCsv(stdout())).toEqual([columns, ...rows].map(row => row.map(String)))
    expect(output).toHaveLength(1)
  })

  it('renders all periods, sections, summaries and numeric zero in the default table', async () => {
    const {instance, stdout} = renderer({})
    await instance.run()
    expect(stdout()).toContain('Synthetic report')
    expect(stdout()).toContain('│')
    expect(stdout()).not.toContain('2,025.00')
    for (const label of [
      'Current period',
      'Prior period',
      '700.00',
      '200.00',
      '0.00',
      'Nested total',
      'Synthetic total',
    ]) {
      expect(stdout()).toContain(label)
    }
  })

  it('preserves the raw JSON report', async () => {
    const {instance, output, stdout} = renderer({json: true})
    await instance.run()
    expect(output).toHaveLength(1)
    expect(JSON.parse(stdout())).toEqual(report)
  })

  it.each([{json: true}, {csv: true}, {toon: true}, {}])(
    'refuses a missing report with no stdout (%j)',
    async flags => {
      const {instance, output} = renderer(flags, null)
      await expect(instance.run()).rejects.toThrow('No report data returned.')
      expect(output).toEqual([])
      const missing = renderer(flags, {})
      missing.instance.xeroCall.mockResolvedValue(undefined)
      await expect(missing.instance.run()).rejects.toThrow('No report data returned.')
      expect(missing.output).toEqual([])
    },
  )

  it('retains every cell without provider headers, using fallback column names', async () => {
    const data = {rows: [{rows: [{cells: cells('Synthetic account', '10', '20', '30', '40', '50', 0)}]}]}
    const csv = renderer({csv: true}, data)
    const toon = renderer({toon: true}, data)
    await csv.instance.run()
    await toon.instance.run()
    const parsed = parseCsv(csv.stdout())
    expect(parsed[0]).toHaveLength(7)
    expect(parsed[1]).toEqual(['Synthetic account', '10', '20', '30', '40', '50', '0'])
    expect(decode(toon.stdout())).toEqual({
      columns: parsed[0],
      rows: [['Synthetic account', '10', '20', '30', '40', '50', 0]],
    })
  })

  it('emits a parseable empty report with its provider headers', async () => {
    const data = {rows: [{rowType: 'Header', cells: cells(...columns)}]}
    const csv = renderer({csv: true}, data)
    const toon = renderer({toon: true}, data)
    await csv.instance.run()
    await toon.instance.run()
    expect(parseCsv(csv.stdout())).toEqual([columns])
    expect(decode(toon.stdout())).toEqual({columns, rows: []})
  })
})
