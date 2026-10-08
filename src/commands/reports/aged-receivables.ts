import {Flags} from '@oclif/core'
import {BaseCommand} from '../../base-command.js'
import {formatReport, type FinancialReport} from '../../lib/report-rows.js'

export default class ReportsAgedReceivables extends BaseCommand {
  static override description = 'Generate aged receivables report for a contact'

  static override examples = [
    '<%= config.bin %> reports aged-receivables --contact-id abc-123',
    '<%= config.bin %> reports aged-receivables --contact-id abc-123 --report-date 2025-12-31',
  ]

  static override flags = {
    ...BaseCommand.baseFlags,
    'contact-id': Flags.string({description: 'Contact ID', required: true}),
    'report-date': Flags.string({description: 'Report date (YYYY-MM-DD)'}),
    'from-date': Flags.string({description: 'Only show invoices after this date (YYYY-MM-DD)'}),
    'to-date': Flags.string({description: 'Only show invoices before this date (YYYY-MM-DD)'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(ReportsAgedReceivables)

    const result = await this.xeroCall(flags, async (xero, tenantId) => {
      const response = await xero.accountingApi.getReportAgedReceivablesByContact(
        tenantId,
        flags['contact-id'],
        flags['report-date'],
        flags['from-date'],
        flags['to-date'],
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
    this.log(formatReport(report, ['Date', 'Reference', 'Due', 'Paid', 'Credited'], format))
  }
}
