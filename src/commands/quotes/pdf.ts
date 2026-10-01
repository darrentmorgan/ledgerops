import {Flags} from '@oclif/core'
import {BaseCommand} from '../../base-command.js'
import {resolveDownloadTarget, writeDownload, STDOUT_TARGET} from '../../lib/file-download.js'

export default class QuotesPdf extends BaseCommand {
  static override description =
    'Download a quote as a PDF from Xero (binary output; --json/--csv/--toon are not supported)'

  static override examples = [
    '<%= config.bin %> quotes pdf --quote-id abc-123',
    '<%= config.bin %> quotes pdf --quote-id abc-123 --out quote.pdf',
    '<%= config.bin %> quotes pdf --quote-id abc-123 --out - > quote.pdf',
  ]

  static override flags = {
    ...BaseCommand.baseFlags,
    'quote-id': Flags.string({description: 'Quote ID (GUID)'}),
    out: Flags.string({
      description: "Output file path, or '-' to stream raw PDF bytes to stdout",
    }),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(QuotesPdf)

    if (flags.json || flags.csv || flags.toon) {
      this.error(
        '--json, --csv, and --toon are not supported for quotes pdf: this command returns binary PDF bytes, not structured data.',
      )
    }

    const quoteId = flags['quote-id']
    if (!quoteId) {
      this.error('--quote-id is required.')
    }

    // The PDF response carries no quote number, and the default filename needs one;
    // only pay for the extra getQuote lookup when the default name will actually be used.
    const needsQuoteNumber = !flags.out

    const {bytes, quoteNumber} = await this.xeroCall(flags, async (xero, tenantId) => {
      const response = await xero.accountingApi.getQuoteAsPdf(tenantId, quoteId)
      const pdfBytes = response.body as unknown as Buffer

      let number: string | undefined
      if (needsQuoteNumber) {
        const quoteResponse = await xero.accountingApi.getQuote(tenantId, quoteId)
        number = quoteResponse.body.quotes?.[0]?.quoteNumber
      }

      return {bytes: pdfBytes, quoteNumber: number}
    })

    const defaultFilename = `./QU-${quoteNumber ?? quoteId}.pdf`
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
