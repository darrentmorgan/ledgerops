import {Flags} from '@oclif/core'
import {BaseCommand} from '../../base-command.js'
import {formatReport, type FinancialReport} from '../../lib/report-rows.js'

export default class ReportsTrialBalance extends BaseCommand {
  static override description = 'Generate a trial balance report from Xero'

  static override examples = [
    '<%= config.bin %> reports trial-balance',
    '<%= config.bin %> reports trial-balance --date 2025-12-31',
    '<%= config.bin %> reports trial-balance --payments-only --json',
  ]

  static override flags = {
    ...BaseCommand.baseFlags,
    date: Flags.string({description: 'Report date (YYYY-MM-DD)'}),
    'payments-only': Flags.boolean({description: 'Include only accounts with payments', default: false}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(ReportsTrialBalance)

    const result = await this.xeroCall(flags, async (xero, tenantId) => {
      const response = await xero.accountingApi.getReportTrialBalance(
        tenantId,
        flags.date,
        flags['payments-only'] || undefined,
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
    this.log(formatReport(report, ['Account', 'Debit', 'Credit'], format))
  }
}
