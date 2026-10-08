import {Flags} from '@oclif/core'
import {BaseCommand} from '../../base-command.js'
import {checkDirectMutationResult} from '../../lib/ledgerops/direct-result.js'
import {contactCreateSchema, contactFileCreateSchema, formatZodError} from '../../lib/validators.js'
import {contactDeepLink} from '../../lib/deeplinks.js'
import type {Contact} from 'xero-node'

export default class ContactsCreate extends BaseCommand {
  static override description = 'Create a contact in Xero (preview by default; pass --execute to dispatch)'

  static override examples = [
    '<%= config.bin %> contacts create --name "Acme Corp" --email acme@example.com',
    '<%= config.bin %> contacts create --file contact.json',
  ]

  static override flags = {
    ...BaseCommand.baseFlags,
    ...BaseCommand.mutationFlags,
    file: Flags.string({description: 'JSON file with contact data'}),
    name: Flags.string({description: 'Contact name'}),
    email: Flags.string({description: 'Contact email'}),
    phone: Flags.string({description: 'Contact phone'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(ContactsCreate)

    const target = this.resolveCredentials(flags)
    let contact: Contact
    if (flags.file) {
      const fileData = this.readJsonFile(flags.file)
      const parsed = contactFileCreateSchema.safeParse(fileData)
      if (!parsed.success) this.error(`Validation errors:\n${formatZodError(parsed.error)}`)
      contact = parsed.data as Contact
    } else {
      const parsed = contactCreateSchema.safeParse({name: flags.name, email: flags.email, phone: flags.phone})
      if (!parsed.success) this.error(`Validation errors:\n${formatZodError(parsed.error)}`)
      contact = {
        name: parsed.data.name,
        emailAddress: parsed.data.email,
        phones: parsed.data.phone ? [{phoneNumber: parsed.data.phone}] : undefined,
      }
    }

    await this.runGatedMutation(
      flags,
      {
        operation: 'create',
        resource: 'contacts',
        target,
        summary: [`contact ${contact.name}`, ...(contact.contactStatus ? [`status ${contact.contactStatus}`] : [])],
        payload: contact as unknown as Record<string, unknown>,
      },
      async (xero, tenantId, snapshot) => {
        const response = await xero.accountingApi.createContacts(tenantId, {
          contacts: [snapshot.payload as unknown as Contact],
        })
        const resource = checkDirectMutationResult(response, 'contacts')
        const shortCode = await this.getOrgShortCode(xero, tenantId)
        const link =
          shortCode && resource?.contactID
            ? `\nView in Xero: ${contactDeepLink(shortCode, resource.contactID as string)}`
            : ''
        return {resource, resultLine: `Contact created: ${resource?.name} (${resource?.contactID})${link}`}
      },
    )
  }
}
