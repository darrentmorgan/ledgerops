import {Flags} from '@oclif/core'
import {BaseCommand} from '../../base-command.js'
import {checkDirectMutationResult} from '../../lib/ledgerops/direct-result.js'
import {quoteUpdateSchema, quoteFileUpdateSchema, formatZodError} from '../../lib/validators.js'
import type {Quote, LineItem} from 'xero-node'

export default class QuotesUpdate extends BaseCommand {
  static override description = 'Update a draft quote in Xero (preview by default; pass --execute to dispatch)'

  static override examples = ['<%= config.bin %> quotes update --file quote-update.json']

  static override flags = {
    ...BaseCommand.baseFlags,
    ...BaseCommand.mutationFlags,
    file: Flags.string({description: 'JSON file with quote update data'}),
    'quote-id': Flags.string({description: 'Quote ID'}),
    'contact-id': Flags.string({description: 'Contact ID'}),
    title: Flags.string({description: 'Quote title'}),
    summary: Flags.string({description: 'Quote summary'}),
    terms: Flags.string({description: 'Quote terms'}),
    reference: Flags.string({description: 'Quote reference'}),
    date: Flags.string({description: 'Quote date (YYYY-MM-DD)'}),
    'expiry-date': Flags.string({description: 'Expiry date (YYYY-MM-DD)'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(QuotesUpdate)

    const target = this.resolveCredentials(flags)
    let quote: Quote
    if (flags.file) {
      const fileData = this.readJsonFile(flags.file) as Record<string, unknown>
      const parsed = quoteFileUpdateSchema.safeParse(fileData)
      if (!parsed.success) {
        this.error(`Validation errors:\n${formatZodError(parsed.error)}`)
      }

      quote = fileData as Quote
    } else {
      const data = {
        quoteId: flags['quote-id'],
        contactId: flags['contact-id'],
        title: flags.title,
        summary: flags.summary,
        terms: flags.terms,
        reference: flags.reference,
        date: flags.date,
        expiryDate: flags['expiry-date'],
      }

      const parsed = quoteUpdateSchema.safeParse(data)
      if (!parsed.success) {
        this.error(`Validation errors:\n${formatZodError(parsed.error)}`)
      }

      quote = {
        quoteID: parsed.data.quoteId,
        contact: parsed.data.contactId ? {contactID: parsed.data.contactId} : undefined,
        title: parsed.data.title,
        summary: parsed.data.summary,
        terms: parsed.data.terms,
        reference: parsed.data.reference,
        date: parsed.data.date,
        expiryDate: parsed.data.expiryDate,
        quoteNumber: parsed.data.quoteNumber,
      }

      if (parsed.data.lineItems) {
        quote.lineItems = parsed.data.lineItems.map(li => ({
          description: li.description,
          quantity: li.quantity,
          unitAmount: li.unitAmount,
          accountCode: li.accountCode,
          taxType: li.taxType,
        })) as LineItem[]
      }
    }

    const changedFields = Object.keys(quote).filter(key => key !== 'quoteID' && quote[key as keyof Quote] !== undefined)
    await this.runGatedMutation(
      flags,
      {
        operation: 'update',
        resource: 'quotes',
        target,
        summary: [
          `quote ${quote.quoteID}`,
          `changed fields: ${changedFields.join(', ') || '(none)'}`,
          ...(quote.status ? [`status ${quote.status}`] : []),
        ],
        payload: quote as unknown as Record<string, unknown>,
      },
      async (xero, tenantId, snapshot) => {
        const sealedQuote = snapshot.payload as unknown as Quote & {quoteID: string}
        const response = await xero.accountingApi.updateQuote(tenantId, sealedQuote.quoteID, {
          quotes: [sealedQuote],
        })
        const resource = checkDirectMutationResult(response, 'quotes', sealedQuote.quoteID)
        return {resource, resultLine: `Quote updated: ${resource?.quoteNumber} (${resource?.quoteID})`}
      },
    )
  }
}
