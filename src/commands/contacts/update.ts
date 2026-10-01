import {Flags} from '@oclif/core'
import {BaseCommand} from '../../base-command.js'
import {contactUpdateSchema, contactFileUpdateSchema, formatZodError} from '../../lib/validators.js'
import type {Contact, Phone, Address} from 'xero-node'

export default class ContactsUpdate extends BaseCommand {
  static override description = 'Update a contact in Xero (preview by default; pass --execute to dispatch)'

  static override examples = [
    '<%= config.bin %> contacts update --contact-id abc-123 --name "New Name"',
    '<%= config.bin %> contacts update --file contact-update.json',
  ]

  static override flags = {
    ...BaseCommand.baseFlags,
    ...BaseCommand.mutationFlags,
    file: Flags.string({description: 'JSON file with contact update data'}),
    'contact-id': Flags.string({description: 'Contact ID'}),
    name: Flags.string({description: 'Contact name'}),
    email: Flags.string({description: 'Contact email'}),
    phone: Flags.string({description: 'Contact phone'}),
    'first-name': Flags.string({description: 'First name'}),
    'last-name': Flags.string({description: 'Last name'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(ContactsUpdate)

    const target = this.resolveCredentials(flags)
    let contact: Contact
    if (flags.file) {
      const parsed = contactFileUpdateSchema.safeParse(this.readJsonFile(flags.file))
      if (!parsed.success) this.error(`Validation errors:\n${formatZodError(parsed.error)}`)
      contact = parsed.data as Contact
    } else {
      const parsed = contactUpdateSchema.safeParse({
        contactId: flags['contact-id'],
        name: flags.name,
        email: flags.email,
        phone: flags.phone,
        firstName: flags['first-name'],
        lastName: flags['last-name'],
      })
      if (!parsed.success) this.error(`Validation errors:\n${formatZodError(parsed.error)}`)
      contact = {
        contactID: parsed.data.contactId,
        name: parsed.data.name,
        emailAddress: parsed.data.email,
        firstName: parsed.data.firstName,
        lastName: parsed.data.lastName,
        phones: parsed.data.phone ? [{phoneNumber: parsed.data.phone} as Phone] : undefined,
        addresses: parsed.data.address ? [parsed.data.address as Address] : undefined,
      }
    }

    const changedFields = Object.keys(contact).filter(
      key => key !== 'contactID' && contact[key as keyof Contact] !== undefined,
    )
    await this.runGatedMutation(
      flags,
      {
        operation: 'update',
        resource: 'contacts',
        target,
        summary: [
          `contact ${contact.contactID}${contact.name ? ` (${contact.name})` : ''}`,
          `changed fields: ${changedFields.join(', ') || '(none)'}`,
          ...(contact.contactStatus ? [`status ${contact.contactStatus}`] : []),
        ],
        payload: contact as unknown as Record<string, unknown>,
      },
      async (xero, tenantId, snapshot) => {
        const sealedContact = snapshot.payload as unknown as Contact & {contactID: string}
        const response = await xero.accountingApi.updateContact(tenantId, sealedContact.contactID, {
          contacts: [sealedContact],
        })
        const resource = response.body.contacts?.[0] as Record<string, unknown> | undefined
        return {resource, resultLine: `Contact updated: ${resource?.name} (${resource?.contactID})`}
      },
    )
  }
}
