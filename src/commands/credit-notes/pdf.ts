import {Flags} from '@oclif/core'
import {BaseCommand} from '../../base-command.js'
import {resolveDownloadTarget, writeDownload, STDOUT_TARGET} from '../../lib/file-download.js'

export default class CreditNotesPdf extends BaseCommand {
  static override description =
    'Download a credit note as a PDF from Xero (binary output; --json/--csv/--toon are not supported)'

  static override examples = [
    '<%= config.bin %> credit-notes pdf --credit-note-id abc-123',
    '<%= config.bin %> credit-notes pdf --credit-note-id abc-123 --out credit-note.pdf',
    '<%= config.bin %> credit-notes pdf --credit-note-id abc-123 --out - > credit-note.pdf',
  ]

  static override flags = {
    ...BaseCommand.baseFlags,
    'credit-note-id': Flags.string({description: 'Credit note ID (GUID)'}),
    out: Flags.string({
      description: "Output file path, or '-' to stream raw PDF bytes to stdout",
    }),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(CreditNotesPdf)

    if (flags.json || flags.csv || flags.toon) {
      this.error(
        '--json, --csv, and --toon are not supported for credit-notes pdf: this command returns binary PDF bytes, not structured data.',
      )
    }

    const creditNoteId = flags['credit-note-id']
    if (!creditNoteId) {
      this.error('--credit-note-id is required.')
    }

    // The PDF response carries no credit note number, and the default filename needs
    // one; only pay for the extra getCreditNote lookup when the default name is used.
    const needsCreditNoteNumber = !flags.out

    const {bytes, creditNoteNumber} = await this.xeroCall(flags, async (xero, tenantId) => {
      const response = await xero.accountingApi.getCreditNoteAsPdf(tenantId, creditNoteId)
      const pdfBytes = response.body as unknown as Buffer

      let number: string | undefined
      if (needsCreditNoteNumber) {
        const creditNoteResponse = await xero.accountingApi.getCreditNote(tenantId, creditNoteId)
        number = creditNoteResponse.body.creditNotes?.[0]?.creditNoteNumber
      }

      return {bytes: pdfBytes, creditNoteNumber: number}
    })

    const defaultFilename = `./CN-${creditNoteNumber ?? creditNoteId}.pdf`
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
