import {Flags} from '@oclif/core'
import {BaseCommand} from '../../base-command.js'
import {formatStatus, formatCurrency, formatDate} from '../../lib/formatters.js'

export default class InvoicesGet extends BaseCommand {
  static override description = 'Get a single invoice from Xero by ID or number'

  static override examples = [
    '<%= config.bin %> invoices get --invoice-id abc-123',
    '<%= config.bin %> invoices get --invoice-number INV-0001',
    '<%= config.bin %> invoices get --invoice-id abc-123 --json',
  ]

  static override flags = {
    ...BaseCommand.baseFlags,
    'invoice-id': Flags.string({description: 'Invoice ID (GUID)'}),
    'invoice-number': Flags.string({description: 'Invoice number'}),
  }

  private readonly invoiceColumns = [
    {key: 'invoiceID', header: 'ID'},
    {key: 'type', header: 'Type'},
    {key: 'status', header: 'Status', format: (v: unknown) => formatStatus(String(v ?? ''))},
    {key: 'reference', header: 'Reference'},
    {key: 'date', header: 'Date', format: (v: unknown) => formatDate(v)},
    {key: 'dueDate', header: 'Due Date', format: (v: unknown) => formatDate(v)},
    {key: 'total', header: 'Total', format: (v: unknown) => formatCurrency(v)},
    {key: 'amountDue', header: 'Due', format: (v: unknown) => formatCurrency(v)},
    {key: 'contact.name', header: 'Contact'},
    {
      key: 'lineItems',
      header: 'Line Items',
      format: (v: unknown) => String(Array.isArray(v) ? v.length : 0),
    },
  ]

  async run(): Promise<void> {
    const {flags} = await this.parse(InvoicesGet)

    const invoiceId = flags['invoice-id']
    const invoiceNumber = flags['invoice-number']

    if (!invoiceId && !invoiceNumber) {
      this.error('Provide exactly one of --invoice-id or --invoice-number.')
    }

    if (invoiceId && invoiceNumber) {
      this.error('Provide exactly one of --invoice-id or --invoice-number, not both.')
    }

    const selector = (invoiceId ?? invoiceNumber) as string

    const invoice = await this.xeroCall(flags, async (xero, tenantId) => {
      const response = await xero.accountingApi.getInvoice(tenantId, selector)
      return response.body.invoices?.[0]
    })

    if (!invoice) {
      this.error('Resource not found.')
    }

    if (flags.json || flags.csv || flags.toon) {
      this.log(JSON.stringify(invoice, null, 2))
    } else {
      this.outputFormatted([invoice as unknown as Record<string, unknown>], this.invoiceColumns, flags)
    }
  }
}
