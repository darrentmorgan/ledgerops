import {Flags} from '@oclif/core'
import {BaseCommand} from '../../base-command.js'
import {checkDirectMutationResult} from '../../lib/ledgerops/direct-result.js'
import {creditNoteCreateSchema, creditNoteFileCreateSchema, formatZodError} from '../../lib/validators.js'
import {creditNoteDeepLink} from '../../lib/deeplinks.js'
import {ensureContactNested} from '../../lib/file-data.js'
import {CreditNote} from 'xero-node'
import type {LineItem} from 'xero-node'

export default class CreditNotesCreate extends BaseCommand {
  static override description = 'Create a credit note in Xero (preview by default; pass --execute to dispatch)'

  static override examples = [
    '<%= config.bin %> credit-notes create --file credit-note.json',
    '<%= config.bin %> credit-notes create --file credit-note.json --execute',
  ]

  static override flags = {
    ...BaseCommand.baseFlags,
    ...BaseCommand.mutationFlags,
    file: Flags.string({description: 'JSON file with credit note data'}),
    'contact-id': Flags.string({description: 'Contact ID'}),
    reference: Flags.string({description: 'Credit note reference'}),
    description: Flags.string({description: 'Line item description'}),
    quantity: Flags.string({description: 'Line item quantity'}),
    'unit-amount': Flags.string({description: 'Line item unit amount'}),
    'account-code': Flags.string({description: 'Line item account code'}),
    'tax-type': Flags.string({description: 'Line item tax type'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(CreditNotesCreate)
    const target = this.resolveCredentials(flags)
    let creditNote: CreditNote

    if (flags.file) {
      const fileData = this.readJsonFile(flags.file) as Record<string, unknown>
      const parsed = creditNoteFileCreateSchema.safeParse(fileData)
      if (!parsed.success) {
        this.error(`Validation errors:\n${formatZodError(parsed.error)}`)
      }

      creditNote = ensureContactNested(fileData) as CreditNote
    } else {
      const data = {
        contactId: flags['contact-id'],
        reference: flags.reference,
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

      const parsed = creditNoteCreateSchema.safeParse(data)
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

      creditNote = {
        type: CreditNote.TypeEnum.ACCPAYCREDIT,
        contact: {contactID: parsed.data.contactId},
        lineItems,
        reference: parsed.data.reference,
      }
    }

    await this.runGatedMutation(
      flags,
      {
        operation: 'create',
        resource: 'credit-notes',
        target,
        summary: [
          `type ${creditNote.type ?? '(unspecified)'}`,
          `${Array.isArray(creditNote.lineItems) ? creditNote.lineItems.length : 0} line item(s)`,
          ...(creditNote.status ? [`status ${creditNote.status}`] : []),
        ],
        payload: creditNote as unknown as Record<string, unknown>,
      },
      async (xero, tenantId, snapshot) => {
        const response = await xero.accountingApi.createCreditNotes(tenantId, {
          creditNotes: [snapshot.payload as unknown as CreditNote],
        })
        const resource = checkDirectMutationResult(response, 'credit-notes')
        const shortCode = await this.getOrgShortCode(xero, tenantId)
        const link =
          shortCode && resource?.creditNoteID
            ? `\nView in Xero: ${creditNoteDeepLink(shortCode, resource.creditNoteID as string)}`
            : ''
        return {
          resource,
          resultLine: `Credit note created: ${resource?.creditNoteNumber ?? 'Draft'} (${resource?.creditNoteID})${link}`,
        }
      },
    )
  }
}
