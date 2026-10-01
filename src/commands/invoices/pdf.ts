import {Flags} from '@oclif/core'
import {BaseCommand} from '../../base-command.js'
import {resolveDownloadTarget, writeDownload, STDOUT_TARGET} from '../../lib/file-download.js'

export default class InvoicesPdf extends BaseCommand {
  static override description =
    'Download an invoice as a PDF from Xero (binary output; --json/--csv/--toon are not supported)'

  static override examples = [
    '<%= config.bin %> invoices pdf --invoice-id abc-123',
    '<%= config.bin %> invoices pdf --invoice-id abc-123 --out invoice.pdf',
    '<%= config.bin %> invoices pdf --invoice-id abc-123 --out - > invoice.pdf',
  ]

  static override flags = {
    ...BaseCommand.baseFlags,
    'invoice-id': Flags.string({description: 'Invoice ID (GUID)'}),
    out: Flags.string({
      description: "Output file path, or '-' to stream raw PDF bytes to stdout",
    }),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(InvoicesPdf)

    if (flags.json || flags.csv || flags.toon) {
      this.error(
        '--json, --csv, and --toon are not supported for invoices pdf: this command returns binary PDF bytes, not structured data.',
      )
    }

    const invoiceId = flags['invoice-id']
    if (!invoiceId) {
      this.error('--invoice-id is required.')
    }

    // The PDF response carries no invoice number, and the default filename needs one;
    // only pay for the extra getInvoice lookup when the default name will actually be used.
    const needsInvoiceNumber = !flags.out

    const {bytes, invoiceNumber} = await this.xeroCall(flags, async (xero, tenantId) => {
      const response = await xero.accountingApi.getInvoiceAsPdf(tenantId, invoiceId)
      const pdfBytes = response.body as unknown as Buffer

      let number: string | undefined
      if (needsInvoiceNumber) {
        const invoiceResponse = await xero.accountingApi.getInvoice(tenantId, invoiceId)
        number = invoiceResponse.body.invoices?.[0]?.invoiceNumber
      }

      return {bytes: pdfBytes, invoiceNumber: number}
    })

    const defaultFilename = `./INV-${invoiceNumber ?? invoiceId}.pdf`
    const target = resolveDownloadTarget(flags.out, defaultFilename)

    let result: ReturnType<typeof writeDownload>
    try {
      result = writeDownload(bytes, target)
    } catch (caught) {
      this.error(caught instanceof Error ? caught.message : String(caught))
    }

    if (target !== STDOUT_TARGET) {
      this.log(`Wrote ${result.path} (${result.bytesWritten} bytes)`)
    }
  }
}
