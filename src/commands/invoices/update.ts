import {Flags} from '@oclif/core'
import {BaseCommand} from '../../base-command.js'
import {invoiceUpdateSchema, invoiceFileUpdateSchema, formatZodError} from '../../lib/validators.js'
import type {Invoice, LineItem} from 'xero-node'

export default class InvoicesUpdate extends BaseCommand {
  static override description = 'Update an invoice in Xero (preview by default; pass --execute to dispatch)'

  static override examples = [
    '<%= config.bin %> invoices update --file invoice-update.json',
    '<%= config.bin %> invoices update --file invoice-update.json --execute',
    '<%= config.bin %> invoices update --invoice-id 00000000-0000-4000-8000-000000000001 --reference "Updated ref"',
  ]

  static override flags = {
    ...BaseCommand.baseFlags,
    ...BaseCommand.mutationFlags,
    file: Flags.string({
      description: 'JSON file with invoiceID and changed fields (including status, such as AUTHORISED or VOIDED)',
    }),
    'invoice-id': Flags.string({description: 'Invoice ID'}),
    'contact-id': Flags.string({description: 'Contact ID'}),
    date: Flags.string({description: 'Invoice date (YYYY-MM-DD)'}),
    'due-date': Flags.string({description: 'Due date (YYYY-MM-DD)'}),
    reference: Flags.string({description: 'Invoice reference'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(InvoicesUpdate)
    const target = this.resolveCredentials(flags)
    let invoice: Invoice

    if (flags.file) {
      const fileData = this.readJsonFile(flags.file) as Record<string, unknown>
      const parsed = invoiceFileUpdateSchema.safeParse(fileData)
      if (!parsed.success) {
        this.error(`Validation errors:\n${formatZodError(parsed.error)}`)
      }

      invoice = fileData as Invoice
    } else {
      const data = {
        invoiceId: flags['invoice-id'],
        contactId: flags['contact-id'],
        date: flags.date,
        dueDate: flags['due-date'],
        reference: flags.reference,
      }

      const parsed = invoiceUpdateSchema.safeParse(data)
      if (!parsed.success) {
        this.error(`Validation errors:\n${formatZodError(parsed.error)}`)
      }

      invoice = {
        invoiceID: parsed.data.invoiceId,
        contact: parsed.data.contactId ? {contactID: parsed.data.contactId} : undefined,
        date: parsed.data.date,
        dueDate: parsed.data.dueDate,
        reference: parsed.data.reference,
      }

      if (parsed.data.lineItems) {
        invoice.lineItems = parsed.data.lineItems.map(li => ({
          description: li.description,
          quantity: li.quantity,
          unitAmount: li.unitAmount,
          accountCode: li.accountCode,
          taxType: li.taxType,
          itemCode: li.itemCode,
          tracking: li.tracking as LineItem['tracking'],
        }))
      }
    }

    const changedFields = Object.keys(invoice).filter(
      key => key !== 'invoiceID' && invoice[key as keyof Invoice] !== undefined,
    )
    await this.runGatedMutation(
      flags,
      {
        operation: 'update',
        resource: 'invoices',
        target,
        summary: [
          `invoice ${invoice.invoiceID}`,
          `changed fields: ${changedFields.join(', ') || '(none)'}`,
          ...(invoice.status ? [`status transition: to ${invoice.status}`] : []),
        ],
        payload: invoice as unknown as Record<string, unknown>,
      },
      async (xero, tenantId, snapshot) => {
        const sealedInvoice = snapshot.payload as unknown as Invoice & {invoiceID: string}
        const response = await xero.accountingApi.updateInvoice(tenantId, sealedInvoice.invoiceID, {
          invoices: [sealedInvoice],
        })
        const resource = response.body.invoices?.[0] as Record<string, unknown> | undefined
        return {
          resource,
          resultLine: `Invoice updated: ${resource?.invoiceNumber} (${resource?.invoiceID})`,
        }
      },
    )
  }
}
