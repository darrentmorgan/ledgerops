import {Flags} from '@oclif/core'
import {BaseCommand} from '../../base-command.js'
import {accountUpdateSchema, accountFileUpdateSchema, formatZodError} from '../../lib/validators.js'
import type {Account} from 'xero-node'

export default class AccountsUpdate extends BaseCommand {
  static override description =
    'Update an account in Xero (payload-only preview by default; pass --execute to dispatch once)'

  static override examples = [
    '<%= config.bin %> accounts update --account-id abc-123 --name "New Name"',
    '<%= config.bin %> accounts update --file account-update.json',
    '<%= config.bin %> accounts update --account-id abc-123 --status ARCHIVED --execute',
  ]

  static override flags = {
    ...BaseCommand.baseFlags,
    ...BaseCommand.mutationFlags,
    file: Flags.string({description: 'JSON file with account update data'}),
    'account-id': Flags.string({description: 'Account ID'}),
    name: Flags.string({description: 'Account name'}),
    code: Flags.string({description: 'Account code'}),
    description: Flags.string({description: 'Account description'}),
    status: Flags.string({description: 'Account status (ACTIVE or ARCHIVED)'}),
    'tax-type': Flags.string({description: 'Tax type'}),
    'enable-payments-to-account': Flags.boolean({description: 'Enable payments to account', allowNo: true}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(AccountsUpdate)
    const target = this.resolveCredentials(flags)
    let account: Record<string, unknown>

    if (flags.file) {
      const parsed = accountFileUpdateSchema.safeParse(this.readJsonFile(flags.file))
      if (!parsed.success) this.error(`Validation errors:\n${formatZodError(parsed.error)}`)
      account = parsed.data
    } else {
      const parsed = accountUpdateSchema.safeParse({
        accountId: flags['account-id'],
        name: flags.name,
        code: flags.code,
        description: flags.description,
        status: flags.status,
        taxType: flags['tax-type'],
        enablePaymentsToAccount: flags['enable-payments-to-account'],
      })
      if (!parsed.success) this.error(`Validation errors:\n${formatZodError(parsed.error)}`)
      const {accountId, ...changes} = parsed.data
      account = Object.fromEntries(
        Object.entries({accountID: accountId, ...changes}).filter(([, value]) => value !== undefined),
      )
    }

    const fields = Object.keys(account)
      .filter(key => key !== 'accountID')
      .sort()
    const summary = [
      `account ${String(account.accountID)}${account.name ? ` (${String(account.name)})` : ''}`,
      `changed fields: ${fields.join(', ') || '(none)'}`,
      ...(account.status === undefined
        ? []
        : [`status transition: to ${String(account.status)} (current status not read)`]),
    ]
    await this.runGatedMutation(
      flags,
      {
        operation: 'update',
        resource: 'accounts',
        target,
        summary,
        payload: account,
      },
      async (xero, tenantId, snapshot) => {
        const payload = snapshot.payload as unknown as Account
        const response = await xero.accountingApi.updateAccount(tenantId, payload.accountID as string, {
          accounts: [payload],
        })
        const resource = response.body.accounts?.[0] as Record<string, unknown> | undefined
        return {resource, resultLine: `Account updated: ${resource?.name} (${resource?.accountID})`}
      },
    )
  }
}
