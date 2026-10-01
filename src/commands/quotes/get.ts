import {Flags} from '@oclif/core'
import {BaseCommand} from '../../base-command.js'
import {formatStatus, formatCurrency, formatDate} from '../../lib/formatters.js'

export default class QuotesGet extends BaseCommand {
  static override description = 'Get a single quote from Xero by ID'

  static override examples = [
    '<%= config.bin %> quotes get --quote-id abc-123',
    '<%= config.bin %> quotes get --quote-id abc-123 --json',
  ]

  static override flags = {
    ...BaseCommand.baseFlags,
    'quote-id': Flags.string({description: 'Quote ID (GUID)'}),
  }

  private readonly quoteColumns = [
    {key: 'quoteID', header: 'ID'},
    {key: 'quoteNumber', header: 'Number'},
    {key: 'status', header: 'Status', format: (v: unknown) => formatStatus(String(v ?? ''))},
    {key: 'reference', header: 'Reference'},
    {key: 'date', header: 'Date', format: (v: unknown) => formatDate(v)},
    {key: 'expiryDate', header: 'Expiry Date', format: (v: unknown) => formatDate(v)},
    {key: 'total', header: 'Total', format: (v: unknown) => formatCurrency(v)},
    {key: 'contact.name', header: 'Contact'},
    {
      key: 'lineItems',
      header: 'Line Items',
      format: (v: unknown) => String(Array.isArray(v) ? v.length : 0),
    },
  ]

  async run(): Promise<void> {
    const {flags} = await this.parse(QuotesGet)

    const quoteId = flags['quote-id']

    if (!quoteId) {
      this.error('--quote-id is required.')
    }

    const quote = await this.xeroCall(flags, async (xero, tenantId) => {
      const response = await xero.accountingApi.getQuote(tenantId, quoteId)
      return response.body.quotes?.[0]
    })

    if (!quote) {
      this.error('Resource not found.')
    }

    if (flags.json || flags.csv || flags.toon) {
      this.log(JSON.stringify(quote, null, 2))
    } else {
      this.outputFormatted([quote as unknown as Record<string, unknown>], this.quoteColumns, flags)
    }
  }
}
