import {Flags} from '@oclif/core'
import {BaseCommand} from '../../base-command.js'

export default class UsersList extends BaseCommand {
  static override description = 'List users in Xero'

  static override examples = [
    '<%= config.bin %> users list',
    '<%= config.bin %> users list --user-id 00000000-0000-0000-0000-000000000000',
    '<%= config.bin %> users list --json',
  ]

  static override flags = {
    ...BaseCommand.baseFlags,
    'user-id': Flags.string({description: 'Get a specific user'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(UsersList)

    const result = await this.xeroCall(flags, async (xero, tenantId) => {
      if (flags['user-id']) {
        const response = await xero.accountingApi.getUser(tenantId, flags['user-id'])
        return response.body.users ?? []
      }

      const response = await xero.accountingApi.getUsers(tenantId)
      return response.body.users ?? []
    })

    const users = result as unknown as Record<string, unknown>[]

    if (flags.json) {
      this.log(JSON.stringify(users, null, 2))
      return
    }

    const rows = users.map(user => ({
      ...user,
      fullName: [user.firstName, user.lastName].filter(Boolean).join(' '),
    }))

    this.outputFormatted(
      rows,
      [
        {key: 'userID', header: 'ID'},
        {key: 'fullName', header: 'Name'},
        {key: 'emailAddress', header: 'Email'},
        {key: 'organisationRole', header: 'Role'},
        {key: 'isSubscriber', header: 'Subscriber', format: v => String(Boolean(v))},
      ],
      flags,
    )
  }
}
