import {Flags} from '@oclif/core'
import {BaseCommand} from '../../base-command.js'
import {checkDirectMutationResult} from '../../lib/ledgerops/direct-result.js'
import {bankTransactionUpdateSchema, bankTransactionFileUpdateSchema, formatZodError} from '../../lib/validators.js'
import {BankTransaction} from 'xero-node'

export default class BankTransactionsUpdate extends BaseCommand {
  static override description = 'Update a bank transaction in Xero (preview by default; pass --execute to dispatch)'

  static override examples = [
    '<%= config.bin %> bank-transactions update --file bank-transaction-update.json',
    '<%= config.bin %> bank-transactions update --file bank-transaction-update.json --execute',
  ]

  static override flags = {
    ...BaseCommand.baseFlags,
    ...BaseCommand.mutationFlags,
    file: Flags.string({description: 'JSON file with bank transaction update data'}),
    'bank-transaction-id': Flags.string({description: 'Bank transaction ID'}),
    'contact-id': Flags.string({description: 'Contact ID'}),
    type: Flags.string({description: 'Transaction type (RECEIVE or SPEND)', options: ['RECEIVE', 'SPEND']}),
    date: Flags.string({description: 'Transaction date (YYYY-MM-DD)'}),
    reference: Flags.string({description: 'Transaction reference'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(BankTransactionsUpdate)

    const target = this.resolveCredentials(flags)
    let bankTransaction: BankTransaction

    if (flags.file) {
      const fileData = this.readJsonFile(flags.file) as Record<string, unknown>
      const parsed = bankTransactionFileUpdateSchema.safeParse(fileData)
      if (!parsed.success) this.error(`Validation errors:\n${formatZodError(parsed.error)}`)
      bankTransaction = fileData as unknown as BankTransaction
    } else {
      const data = {
        bankTransactionId: flags['bank-transaction-id'],
        contactId: flags['contact-id'],
        type: flags.type,
        date: flags.date,
        reference: flags.reference,
      }

      const parsed = bankTransactionUpdateSchema.safeParse(data)
      if (!parsed.success) this.error(`Validation errors:\n${formatZodError(parsed.error)}`)
      bankTransaction = {
        bankTransactionID: parsed.data.bankTransactionId,
        contact: parsed.data.contactId ? {contactID: parsed.data.contactId} : undefined,
        type: parsed.data.type
          ? BankTransaction.TypeEnum[parsed.data.type as keyof typeof BankTransaction.TypeEnum]
          : undefined,
        lineItems: parsed.data.lineItems,
        date: parsed.data.date,
        reference: parsed.data.reference,
      } as BankTransaction
    }

    const summary = [
      `bank transaction ${bankTransaction.bankTransactionID}`,
      `changed fields: ${
        Object.keys(bankTransaction)
          .filter(
            key =>
              key !== 'bankTransactionID' && (bankTransaction as unknown as Record<string, unknown>)[key] !== undefined,
          )
          .sort()
          .join(', ') || 'none'
      }`,
      ...(bankTransaction.status ? [`status transition: to ${bankTransaction.status}`] : []),
    ]
    await this.runGatedMutation(
      flags,
      {
        operation: 'update',
        resource: 'bank-transactions',
        target,
        summary,
        payload: bankTransaction as unknown as Record<string, unknown>,
      },
      async (xero, tenantId, snapshot) => {
        const transaction = snapshot.payload as unknown as BankTransaction & {bankTransactionID: string}
        const response = await xero.accountingApi.updateBankTransaction(tenantId, transaction.bankTransactionID, {
          bankTransactions: [transaction],
        })
        const resource = checkDirectMutationResult(response, 'bank-transactions')
        return {resource, resultLine: `Bank transaction updated: ${resource?.bankTransactionID}`}
      },
    )
  }
}
