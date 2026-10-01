import {Flags} from '@oclif/core'
import {BaseCommand} from '../../base-command.js'
import {formatStatus} from '../../lib/formatters.js'

export default class ContactsGet extends BaseCommand {
  static override description = 'Get a single contact from Xero by ID or contact number'

  static override examples = [
    '<%= config.bin %> contacts get --contact-id 00000000-0000-0000-0000-000000000000',
    '<%= config.bin %> contacts get --contact-number CN001',
    '<%= config.bin %> contacts get --contact-id 00000000-0000-0000-0000-000000000000 --json',
  ]

  static override flags = {
    ...BaseCommand.baseFlags,
    'contact-id': Flags.string({description: 'Contact ID (GUID); mutually exclusive with --contact-number'}),
    'contact-number': Flags.string({description: 'Contact number; mutually exclusive with --contact-id'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(ContactsGet)

    const contactId = flags['contact-id']
    const contactNumber = flags['contact-number']
    if ((contactId === undefined) === (contactNumber === undefined)) {
      this.error('Exactly one of --contact-id or --contact-number is required')
    }

    const identifier = (contactId ?? contactNumber) as string

    const result = await this.xeroCall(flags, async (xero, tenantId) => {
      const response = await xero.accountingApi.getContact(tenantId, identifier)
      return response.body.contacts?.[0]
    })

    if (flags.json) {
      this.log(JSON.stringify(result, null, 2))
      return
    }

    this.outputFormatted(
      result ? [result as unknown as Record<string, unknown>] : [],
      [
        {key: 'contactID', header: 'ID'},
        {key: 'name', header: 'Name'},
        {key: 'emailAddress', header: 'Email'},
        {key: 'contactStatus', header: 'Status', format: v => formatStatus(String(v ?? ''))},
      ],
      flags,
    )
  }
}
