import {Flags} from '@oclif/core'
import {BaseCommand} from '../../base-command.js'
import {formatStatus, formatCurrency, formatDate} from '../../lib/formatters.js'

export default class BankTransactionsGet extends BaseCommand {
  static override description = 'Get a single bank transaction from Xero'

  static override examples = [
    '<%= config.bin %> bank-transactions get --bank-transaction-id abc-123',
    '<%= config.bin %> bank-transactions get --bank-transaction-id abc-123 --json',
  ]

  static override flags = {
    ...BaseCommand.baseFlags,
    'bank-transaction-id': Flags.string({
      description: 'Bank transaction ID',
      required: true,
    }),
  }

  private readonly transactionColumns = [
    {key: 'bankTransactionID', header: 'ID'},
    {key: 'type', header: 'Type'},
    {key: 'contact.name', header: 'Contact'},
    {key: 'date', header: 'Date', format: (v: unknown) => formatDate(v)},
    {key: 'total', header: 'Total', format: (v: unknown) => formatCurrency(v)},
    {key: 'status', header: 'Status', format: (v: unknown) => formatStatus(String(v ?? ''))},
  ]

  async run(): Promise<void> {
    const {flags} = await this.parse(BankTransactionsGet)

    const result = await this.xeroCall(flags, async (xero, tenantId) => {
      const response = await xero.accountingApi.getBankTransaction(tenantId, flags['bank-transaction-id'])
      return response.body.bankTransactions?.[0]
    })

    const transaction = result as unknown as Record<string, unknown> | undefined
    if (!transaction) {
      this.error('Resource not found.')
    }

    if (flags.json) {
      this.log(JSON.stringify(transaction, null, 2))
    } else {
      this.outputFormatted([transaction], this.transactionColumns, flags)
    }
  }
}
