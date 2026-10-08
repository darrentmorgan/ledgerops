import {Flags} from '@oclif/core'
import {BaseCommand} from '../../base-command.js'
import {checkDirectMutationResult} from '../../lib/ledgerops/direct-result.js'
import {bankTransactionCreateSchema, bankTransactionFileCreateSchema, formatZodError} from '../../lib/validators.js'
import {bankTransactionDeepLink} from '../../lib/deeplinks.js'
import {ensureContactNested, ensureBankAccountNested} from '../../lib/file-data.js'
import {BankTransaction} from 'xero-node'

export default class BankTransactionsCreate extends BaseCommand {
  static override description = 'Create a bank transaction in Xero (preview by default; pass --execute to dispatch)'

  static override examples = [
    '<%= config.bin %> bank-transactions create --file bank-transaction.json',
    '<%= config.bin %> bank-transactions create --file bank-transaction.json --execute',
  ]

  static override flags = {
    ...BaseCommand.baseFlags,
    ...BaseCommand.mutationFlags,
    file: Flags.string({description: 'JSON file with bank transaction data'}),
    type: Flags.string({description: 'Transaction type (RECEIVE or SPEND)', options: ['RECEIVE', 'SPEND']}),
    'bank-account-id': Flags.string({description: 'Bank account ID'}),
    'contact-id': Flags.string({description: 'Contact ID'}),
    date: Flags.string({description: 'Transaction date (YYYY-MM-DD)'}),
    reference: Flags.string({description: 'Transaction reference'}),
    description: Flags.string({description: 'Line item description'}),
    quantity: Flags.string({description: 'Line item quantity'}),
    'unit-amount': Flags.string({description: 'Line item unit amount'}),
    'account-code': Flags.string({description: 'Line item account code'}),
    'tax-type': Flags.string({description: 'Line item tax type'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(BankTransactionsCreate)

    const target = this.resolveCredentials(flags)
    let bankTransaction: BankTransaction

    if (flags.file) {
      const fileData = this.readJsonFile(flags.file) as Record<string, unknown>
      const parsed = bankTransactionFileCreateSchema.safeParse(fileData)
      if (!parsed.success) this.error(`Validation errors:\n${formatZodError(parsed.error)}`)
      bankTransaction = ensureBankAccountNested(ensureContactNested(fileData)) as unknown as BankTransaction
    } else {
      const data = {
        type: flags.type,
        bankAccountId: flags['bank-account-id'],
        contactId: flags['contact-id'],
        date: flags.date,
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

      const parsed = bankTransactionCreateSchema.safeParse(data)
      if (!parsed.success) this.error(`Validation errors:\n${formatZodError(parsed.error)}`)
      bankTransaction = {
        type: BankTransaction.TypeEnum[parsed.data.type as keyof typeof BankTransaction.TypeEnum],
        bankAccount: {accountID: parsed.data.bankAccountId},
        contact: {contactID: parsed.data.contactId},
        lineItems: parsed.data.lineItems,
        date: parsed.data.date,
        reference: parsed.data.reference,
      } as BankTransaction
    }

    const summary = [`type ${bankTransaction.type}`, `${bankTransaction.lineItems?.length ?? 0} line item(s)`]
    await this.runGatedMutation(
      flags,
      {
        operation: 'create',
        resource: 'bank-transactions',
        target,
        summary,
        payload: bankTransaction as unknown as Record<string, unknown>,
      },
      async (xero, tenantId, snapshot) => {
        const transaction = snapshot.payload as unknown as BankTransaction
        const response = await xero.accountingApi.createBankTransactions(tenantId, {bankTransactions: [transaction]})
        const resource = checkDirectMutationResult(response, 'bank-transactions')
        const shortCode = await this.getOrgShortCode(xero, tenantId)
        const link =
          shortCode && resource?.bankTransactionID
            ? `\nView in Xero: ${bankTransactionDeepLink(shortCode, resource.bankTransactionID as string)}`
            : ''
        return {resource, resultLine: `Bank transaction created: ${resource?.bankTransactionID}${link}`}
      },
    )
  }
}
