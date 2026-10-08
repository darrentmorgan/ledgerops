import {Flags} from '@oclif/core'
import {BaseCommand} from '../../base-command.js'
import {checkDirectMutationResult} from '../../lib/ledgerops/direct-result.js'
import {quoteCreateSchema, quoteFileCreateSchema, formatZodError} from '../../lib/validators.js'
import {quoteDeepLink} from '../../lib/deeplinks.js'
import {ensureContactNested} from '../../lib/file-data.js'
import type {Quote, LineItem} from 'xero-node'

export default class QuotesCreate extends BaseCommand {
  static override description = 'Create a quote in Xero (preview by default; pass --execute to dispatch)'

  static override examples = ['<%= config.bin %> quotes create --file quote.json']

  static override flags = {
    ...BaseCommand.baseFlags,
    ...BaseCommand.mutationFlags,
    file: Flags.string({description: 'JSON file with quote data'}),
    'contact-id': Flags.string({description: 'Contact ID'}),
    title: Flags.string({description: 'Quote title'}),
    summary: Flags.string({description: 'Quote summary'}),
    terms: Flags.string({description: 'Quote terms'}),
    reference: Flags.string({description: 'Quote reference'}),
    date: Flags.string({description: 'Quote date (YYYY-MM-DD)'}),
    description: Flags.string({description: 'Line item description'}),
    quantity: Flags.string({description: 'Line item quantity'}),
    'unit-amount': Flags.string({description: 'Line item unit amount'}),
    'account-code': Flags.string({description: 'Line item account code'}),
    'tax-type': Flags.string({description: 'Line item tax type'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(QuotesCreate)

    const target = this.resolveCredentials(flags)
    let quote: Quote
    if (flags.file) {
      const fileData = this.readJsonFile(flags.file) as Record<string, unknown>
      const parsed = quoteFileCreateSchema.safeParse(fileData)
      if (!parsed.success) {
        this.error(`Validation errors:\n${formatZodError(parsed.error)}`)
      }

      quote = ensureContactNested(fileData) as Quote
    } else {
      const data = {
        contactId: flags['contact-id'],
        title: flags.title,
        summary: flags.summary,
        terms: flags.terms,
        reference: flags.reference,
        date: flags.date,
        lineItems: [
          {
            description: flags.description,
            quantity: flags.quantity ? Number(flags.quantity) : undefined,
            unitAmount: flags['unit-amount'] ? Number(flags['unit-amount']) : undefined,
            accountCode: flags['account-code'],
            taxType: flags['tax-type'],
          },
        ],
      }

      const parsed = quoteCreateSchema.safeParse(data)
      if (!parsed.success) {
        this.error(`Validation errors:\n${formatZodError(parsed.error)}`)
      }

      const lineItems: LineItem[] = parsed.data.lineItems.map(li => ({
        description: li.description,
        quantity: li.quantity,
        unitAmount: li.unitAmount,
        accountCode: li.accountCode,
        taxType: li.taxType,
      }))

      quote = {
        contact: {contactID: parsed.data.contactId},
        lineItems,
        title: parsed.data.title,
        summary: parsed.data.summary,
        terms: parsed.data.terms,
        reference: parsed.data.reference,
        quoteNumber: parsed.data.quoteNumber,
        date: parsed.data.date,
      }
    }

    await this.runGatedMutation(
      flags,
      {
        operation: 'create',
        resource: 'quotes',
        target,
        summary: [
          `quote ${quote.quoteNumber ?? quote.title ?? '(new)'}`,
          `contact ${quote.contact?.contactID ?? '(unspecified)'}`,
          `${quote.lineItems?.length ?? 0} line item(s)`,
          `fields: ${Object.keys(quote)
            .filter(key => quote[key as keyof Quote] !== undefined)
            .join(', ')}`,
          ...(quote.status ? [`status ${quote.status}`] : []),
        ],
        payload: quote as unknown as Record<string, unknown>,
      },
      async (xero, tenantId, snapshot) => {
        const response = await xero.accountingApi.createQuotes(tenantId, {
          quotes: [snapshot.payload as unknown as Quote],
        })
        const resource = checkDirectMutationResult(response, 'quotes')
        const shortCode = await this.getOrgShortCode(xero, tenantId)
        const resultLine = `Quote created: ${resource?.quoteNumber} (${resource?.quoteID})`
        const link =
          shortCode && resource?.quoteID
            ? `\nView in Xero: ${quoteDeepLink(shortCode, resource.quoteID as string)}`
            : ''
        return {resource, resultLine: resultLine + link}
      },
    )
  }
}
