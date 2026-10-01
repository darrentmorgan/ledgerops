import {Flags} from '@oclif/core'
import {BaseCommand} from '../../base-command.js'
import {invoiceCreateSchema, invoiceFileCreateSchema, formatZodError} from '../../lib/validators.js'
import {invoiceDeepLink, billDeepLink} from '../../lib/deeplinks.js'
import {ensureContactNested} from '../../lib/file-data.js'
import {runMutationGate, type MutationDescriptor} from '../../lib/ledgerops/mutation-gate.js'
import {Invoice} from 'xero-node'
import type {LineItem} from 'xero-node'

interface CreatedInvoice {
  resource: Record<string, unknown> | undefined
  shortCode?: string
}

const INVOICE_RESULT_COLUMNS = [
  {key: 'invoiceID', header: 'invoiceID'},
  {key: 'invoiceNumber', header: 'invoiceNumber'},
  {key: 'status', header: 'status'},
]

export default class InvoicesCreate extends BaseCommand {
  static override description = 'Create an invoice in Xero (preview by default; pass --execute to dispatch)'

  // Account and tax codes in these examples are organisation-specific; look yours up
  // with `accounts list` and `tax-rates list`.
  static override examples = [
    '<%= config.bin %> invoices create --file invoice.json',
    '<%= config.bin %> invoices create --file invoice.json --execute',
    '<%= config.bin %> invoices create --contact-id abc-123 --type ACCREC --description "Consulting" --quantity 10 --unit-amount 150 --account-code 200 --tax-type OUTPUT2 --execute',
  ]

  static override flags = {
    ...BaseCommand.baseFlags,
    execute: Flags.boolean({
      description: 'Dispatch this mutation now (non-interactive)',
      default: false,
    }),
    yes: Flags.boolean({
      description: "Answer 'yes' to an interactive confirmation prompt if one is presented",
      default: false,
    }),
    file: Flags.string({description: 'JSON file with invoice data'}),
    'contact-id': Flags.string({description: 'Contact ID'}),
    type: Flags.string({description: 'Invoice type (ACCREC or ACCPAY)', options: ['ACCREC', 'ACCPAY']}),
    description: Flags.string({description: 'Line item description'}),
    quantity: Flags.string({description: 'Line item quantity'}),
    'unit-amount': Flags.string({description: 'Line item unit amount'}),
    'account-code': Flags.string({description: 'Line item account code'}),
    'tax-type': Flags.string({description: 'Line item tax type'}),
    'item-code': Flags.string({description: 'Line item code'}),
    date: Flags.string({description: 'Invoice date (YYYY-MM-DD)'}),
    reference: Flags.string({description: 'Invoice reference'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(InvoicesCreate)
    const credentials = this.resolveCredentials(flags)

    let invoice: Invoice
    let summary: string[]
    let invoiceType: string | undefined

    if (flags.file) {
      const fileData = this.readJsonFile(flags.file) as Record<string, unknown>
      const parsed = invoiceFileCreateSchema.safeParse(fileData)
      if (!parsed.success) {
        this.error(`Validation errors:\n${formatZodError(parsed.error)}`)
      }

      invoice = ensureContactNested(fileData) as Invoice
      invoiceType = typeof parsed.data.type === 'string' ? parsed.data.type : undefined
      summary = [
        `type ${invoiceType ?? 'ACCREC'}`,
        `${Array.isArray(invoice.lineItems) ? invoice.lineItems.length : 0} line item(s)`,
      ]
    } else {
      const data = {
        contactId: flags['contact-id'],
        type: flags.type,
        date: flags.date,
        reference: flags.reference,
        lineItems: [
          {
            description: flags.description,
            quantity: flags.quantity ? Number(flags.quantity) : undefined,
            unitAmount: flags['unit-amount'] ? Number(flags['unit-amount']) : undefined,
            accountCode: flags['account-code'],
            taxType: flags['tax-type'],
            itemCode: flags['item-code'],
          },
        ],
      }

      const parsed = invoiceCreateSchema.safeParse(data)
      if (!parsed.success) {
        this.error(`Validation errors:\n${formatZodError(parsed.error)}`)
      }

      const lineItems: LineItem[] = parsed.data.lineItems.map(li => ({
        description: li.description,
        quantity: li.quantity,
        unitAmount: li.unitAmount,
        accountCode: li.accountCode,
        taxType: li.taxType,
        itemCode: li.itemCode,
        tracking: li.tracking as LineItem['tracking'],
      }))

      invoice = {
        type: Invoice.TypeEnum[parsed.data.type as keyof typeof Invoice.TypeEnum],
        contact: {contactID: parsed.data.contactId},
        lineItems,
        date: parsed.data.date,
        reference: parsed.data.reference,
      }
      invoiceType = parsed.data.type
      summary = [`type ${invoiceType}`, `${lineItems.length} line item(s)`]
    }

    const descriptor: MutationDescriptor = {
      operation: 'create',
      resource: 'invoices',
      target: credentials,
      summary,
      payload: invoice as unknown as Record<string, unknown>,
    }

    let outcome: Awaited<ReturnType<typeof runMutationGate<CreatedInvoice>>>
    try {
      outcome = await runMutationGate<CreatedInvoice>(
        descriptor,
        {execute: flags.execute, yes: flags.yes},
        {
          log: line => this.log(line),
          promptLog: line => this.logToStderr(line),
          outputFormat: this.getOutputFormat(flags),
          dispatchOnce: async snapshot =>
            this.xeroMutationCall(snapshot.target, async (xero, tenantId) => {
              const response = await xero.accountingApi.createInvoices(tenantId, {
                invoices: [snapshot.payload as unknown as Invoice],
              })
              const shortCode = await this.getOrgShortCode(xero, tenantId)
              return {
                resource: response.body.invoices?.[0] as Record<string, unknown> | undefined,
                shortCode,
              }
            }),
        },
      )
    } catch (caught) {
      this.error(caught instanceof Error ? caught.message : String(caught))
    }

    if (!outcome.dispatched || !outcome.response) {
      return
    }

    const result = outcome.response
    if (flags.json) {
      this.log(JSON.stringify(result.resource, null, 2))
    } else if (flags.csv || flags.toon) {
      this.outputFormatted([result.resource as Record<string, unknown>], INVOICE_RESULT_COLUMNS, flags)
    } else {
      const r = result.resource
      this.log(`Invoice created: ${r?.invoiceNumber} (${r?.invoiceID})`)
      if (result.shortCode && r?.invoiceID) {
        const link =
          invoiceType === 'ACCPAY'
            ? billDeepLink(result.shortCode, r.invoiceID as string)
            : invoiceDeepLink(result.shortCode, r.invoiceID as string)
        this.log(`View in Xero: ${link}`)
      }
    }
  }
}
