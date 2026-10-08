import {Flags} from '@oclif/core'
import {BaseCommand} from '../../base-command.js'
import {formatReport, type FinancialReport} from '../../lib/report-rows.js'

export default class ReportsBalanceSheet extends BaseCommand {
  static override description = 'Generate a balance sheet report from Xero'

  static override examples = [
    '<%= config.bin %> reports balance-sheet',
    '<%= config.bin %> reports balance-sheet --date 2025-12-31',
    '<%= config.bin %> reports balance-sheet --timeframe QUARTER --periods 4',
  ]

  static override flags = {
    ...BaseCommand.baseFlags,
    date: Flags.string({description: 'Report date (YYYY-MM-DD)'}),
    periods: Flags.integer({description: 'Number of periods to compare'}),
    timeframe: Flags.string({description: 'Timeframe', options: ['MONTH', 'QUARTER', 'YEAR']}),
    'payments-only': Flags.boolean({description: 'Include only accounts with payments', default: false}),
    'standard-layout': Flags.boolean({description: 'Use standard layout', default: false}),
    'tracking-option-id-1': Flags.string({description: 'Tracking option ID 1'}),
    'tracking-option-id-2': Flags.string({description: 'Tracking option ID 2'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(ReportsBalanceSheet)

    const result = await this.xeroCall(flags, async (xero, tenantId) => {
      const response = await xero.accountingApi.getReportBalanceSheet(
        tenantId,
        flags.date,
        flags.periods,
        flags.timeframe as 'MONTH' | 'QUARTER' | 'YEAR' | undefined,
        flags['tracking-option-id-1'],
        flags['tracking-option-id-2'],
        flags['payments-only'] || undefined,
        flags['standard-layout'] || undefined,
      )
      return response.body.reports?.[0]
    })

    if (!result) this.error('No report data returned.')

    if (flags.json) {
      this.log(JSON.stringify(result, null, 2))
      return
    }

    const report = result as FinancialReport
    const format = this.getOutputFormat(flags)
    if (format === 'table') {
      if (report.reportName) this.log(`\n${report.reportName}`)
      if (report.reportDate) this.log(report.reportDate)
      this.log('')
    }
    this.log(formatReport(report, ['Account', 'Amount'], format))
  }
}
