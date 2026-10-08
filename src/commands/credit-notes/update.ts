import {Flags} from '@oclif/core'
import {BaseCommand} from '../../base-command.js'
import {checkDirectMutationResult} from '../../lib/ledgerops/direct-result.js'
import {creditNoteUpdateSchema, creditNoteFileUpdateSchema, formatZodError} from '../../lib/validators.js'
import type {CreditNote, LineItem} from 'xero-node'

export default class CreditNotesUpdate extends BaseCommand {
  static override description = 'Update a draft credit note in Xero (preview by default; pass --execute to dispatch)'

  static override examples = [
    '<%= config.bin %> credit-notes update --file credit-note-update.json',
    '<%= config.bin %> credit-notes update --file credit-note-update.json --execute',
  ]

  static override flags = {
    ...BaseCommand.baseFlags,
    ...BaseCommand.mutationFlags,
    file: Flags.string({description: 'JSON file with credit note update data'}),
    'credit-note-id': Flags.string({description: 'Credit note ID'}),
    'contact-id': Flags.string({description: 'Contact ID'}),
    date: Flags.string({description: 'Credit note date (YYYY-MM-DD)'}),
    reference: Flags.string({description: 'Credit note reference'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(CreditNotesUpdate)
    const target = this.resolveCredentials(flags)
    let creditNote: CreditNote

    if (flags.file) {
      const fileData = this.readJsonFile(flags.file) as Record<string, unknown>
      const parsed = creditNoteFileUpdateSchema.safeParse(fileData)
      if (!parsed.success) {
        this.error(`Validation errors:\n${formatZodError(parsed.error)}`)
      }

      creditNote = fileData as CreditNote
    } else {
      const data = {
        creditNoteId: flags['credit-note-id'],
        contactId: flags['contact-id'],
        date: flags.date,
        reference: flags.reference,
      }

      const parsed = creditNoteUpdateSchema.safeParse(data)
      if (!parsed.success) {
        this.error(`Validation errors:\n${formatZodError(parsed.error)}`)
      }

      creditNote = {
        creditNoteID: parsed.data.creditNoteId,
        contact: parsed.data.contactId ? {contactID: parsed.data.contactId} : undefined,
        date: parsed.data.date,
        reference: parsed.data.reference,
      }

      if (parsed.data.lineItems) {
        creditNote.lineItems = parsed.data.lineItems.map(li => ({
          description: li.description,
          quantity: li.quantity,
          unitAmount: li.unitAmount,
          accountCode: li.accountCode,
          taxType: li.taxType,
        })) as LineItem[]
      }
    }

    const changedFields = Object.keys(creditNote).filter(
      key => key !== 'creditNoteID' && creditNote[key as keyof CreditNote] !== undefined,
    )
    await this.runGatedMutation(
      flags,
      {
        operation: 'update',
        resource: 'credit-notes',
        target,
        summary: [
          `credit note ${creditNote.creditNoteID}`,
          `changed fields: ${changedFields.join(', ') || '(none)'}`,
          ...(creditNote.status ? [`status ${creditNote.status}`] : []),
        ],
        payload: creditNote as unknown as Record<string, unknown>,
      },
      async (xero, tenantId, snapshot) => {
        const sealedCreditNote = snapshot.payload as unknown as CreditNote & {creditNoteID: string}
        const response = await xero.accountingApi.updateCreditNote(tenantId, sealedCreditNote.creditNoteID, {
          creditNotes: [sealedCreditNote],
        })
        const resource = checkDirectMutationResult(response, 'credit-notes', sealedCreditNote.creditNoteID)
        return {
          resource,
          resultLine: `Credit note updated: ${resource?.creditNoteNumber ?? 'Draft'} (${resource?.creditNoteID})`,
        }
      },
    )
  }
}
