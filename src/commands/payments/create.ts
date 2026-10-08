import {Flags} from '@oclif/core'
import {BaseCommand} from '../../base-command.js'
import {checkDirectMutationResult} from '../../lib/ledgerops/direct-result.js'
import {paymentCreateSchema, paymentFileCreateSchema, formatZodError} from '../../lib/validators.js'
import {paymentDeepLink} from '../../lib/deeplinks.js'
import {ensureInvoiceNested, ensureAccountNested} from '../../lib/file-data.js'
import {runMutationGate, type MutationDescriptor} from '../../lib/ledgerops/mutation-gate.js'
import type {Payment} from 'xero-node'

interface CreatedPayment {
  resource: Record<string, unknown>
  shortCode?: string
}

const PAYMENT_RESULT_COLUMNS = [
  {key: 'paymentID', header: 'paymentID'},
  {key: 'amount', header: 'amount'},
  {key: 'status', header: 'status'},
]

export default class PaymentsCreate extends BaseCommand {
  static override description =
    'Create a payment against an invoice in Xero (preview by default; pass --execute to dispatch)'

  static override examples = [
    '<%= config.bin %> payments create --invoice-id abc-123 --account-id def-456 --amount 500',
    '<%= config.bin %> payments create --invoice-id abc-123 --account-id def-456 --amount 500 --execute',
    '<%= config.bin %> payments create --file payment.json --execute',
  ]

  static override flags = {
    ...BaseCommand.baseFlags,
    execute: Flags.boolean({
      description: 'Dispatch this mutation now (non-interactive)',
      default: false,
    }),
    yes: Flags.boolean({
      description: "Answer 'yes' to an interactive confirmation prompt if one is presented",
      default: false,
    }),
    file: Flags.string({description: 'JSON file with payment data'}),
    'invoice-id': Flags.string({description: 'Invoice ID'}),
    'account-id': Flags.string({description: 'Payment account ID'}),
    amount: Flags.string({description: 'Payment amount'}),
    date: Flags.string({description: 'Payment date (YYYY-MM-DD)'}),
    reference: Flags.string({description: 'Payment reference'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(PaymentsCreate)
    const credentials = this.resolveCredentials(flags)

    let payment: Payment
    let summary: string[]

    if (flags.file) {
      const fileData = this.readJsonFile(flags.file) as Record<string, unknown>
      const parsed = paymentFileCreateSchema.safeParse(fileData)
      if (!parsed.success) {
        this.error(`Validation errors:\n${formatZodError(parsed.error)}`)
      }

      payment = ensureAccountNested(ensureInvoiceNested(fileData)) as Payment
      summary = this.paymentSummary(payment.amount, payment.date, payment.reference)
    } else {
      const data = {
        invoiceId: flags['invoice-id'],
        accountId: flags['account-id'],
        amount: flags.amount ? Number(flags.amount) : undefined,
        date: flags.date,
        reference: flags.reference,
      }

      const parsed = paymentCreateSchema.safeParse(data)
      if (!parsed.success) {
        this.error(`Validation errors:\n${formatZodError(parsed.error)}`)
      }

      payment = {
        invoice: {invoiceID: parsed.data.invoiceId},
        account: {accountID: parsed.data.accountId},
        amount: parsed.data.amount,
        date: parsed.data.date,
        reference: parsed.data.reference,
      }
      summary = this.paymentSummary(parsed.data.amount, parsed.data.date, parsed.data.reference)
    }

    const descriptor: MutationDescriptor = {
      operation: 'create',
      resource: 'payments',
      target: credentials,
      summary,
      payload: payment as unknown as Record<string, unknown>,
    }

    let outcome: Awaited<ReturnType<typeof runMutationGate<CreatedPayment>>>
    try {
      outcome = await runMutationGate<CreatedPayment>(
        descriptor,
        {execute: flags.execute, yes: flags.yes},
        {
          log: line => this.log(line),
          promptLog: line => this.logToStderr(line),
          outputFormat: this.getOutputFormat(flags),
          dispatchOnce: async snapshot =>
            this.xeroMutationCall(snapshot.target, async (xero, tenantId) => {
              const response = await xero.accountingApi.createPayment(tenantId, snapshot.payload as unknown as Payment)
              const resource = checkDirectMutationResult(response, 'payments')
              const shortCode = await this.getOrgShortCode(xero, tenantId)
              return {
                resource,
                shortCode,
              }
            }),
        },
      )
    } catch (caught) {
      this.mutationError(caught, flags)
    }

    if (!outcome.dispatched || !outcome.response) {
      return
    }

    const result = outcome.response
    if (flags.json) {
      this.log(JSON.stringify(result.resource, null, 2))
    } else if (flags.csv || flags.toon) {
      this.outputFormatted([result.resource as Record<string, unknown>], PAYMENT_RESULT_COLUMNS, flags)
    } else {
      const r = result.resource
      this.log(`Payment created: ${r?.paymentID}`)
      if (result.shortCode && r?.paymentID) {
        this.log(`View in Xero: ${paymentDeepLink(result.shortCode, r.paymentID as string)}`)
      }
    }
  }

  private paymentSummary(amount: unknown, date: unknown, reference: unknown): string[] {
    const lines = [`amount ${String(amount)}`]
    if (typeof date === 'string' && date.length > 0) {
      lines.push(`date ${date}`)
    }
    if (typeof reference === 'string' && reference.length > 0) {
      lines.push(`reference ${reference}`)
    }
    return lines
  }
}
