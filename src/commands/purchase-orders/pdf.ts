import {Flags} from '@oclif/core'
import {BaseCommand} from '../../base-command.js'
import {resolveDownloadTarget, writeDownload, STDOUT_TARGET} from '../../lib/file-download.js'

export default class PurchaseOrdersPdf extends BaseCommand {
  static override description =
    'Download a purchase order as a PDF from Xero (binary output; --json/--csv/--toon are not supported)'

  static override examples = [
    '<%= config.bin %> purchase-orders pdf --purchase-order-id abc-123',
    '<%= config.bin %> purchase-orders pdf --purchase-order-id abc-123 --out po.pdf',
    '<%= config.bin %> purchase-orders pdf --purchase-order-id abc-123 --out - > po.pdf',
  ]

  static override flags = {
    ...BaseCommand.baseFlags,
    'purchase-order-id': Flags.string({description: 'Purchase order ID (GUID)'}),
    out: Flags.string({
      description: "Output file path, or '-' to stream raw PDF bytes to stdout",
    }),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(PurchaseOrdersPdf)

    if (flags.json || flags.csv || flags.toon) {
      this.error(
        '--json, --csv, and --toon are not supported for purchase-orders pdf: this command returns binary PDF bytes, not structured data.',
      )
    }

    const purchaseOrderId = flags['purchase-order-id']
    if (!purchaseOrderId) {
      this.error('--purchase-order-id is required.')
    }

    // The PDF response carries no purchase order number, and the default filename needs
    // one; only pay for the extra getPurchaseOrder lookup when the default name is used.
    const needsPurchaseOrderNumber = !flags.out

    const {bytes, purchaseOrderNumber} = await this.xeroCall(flags, async (xero, tenantId) => {
      const response = await xero.accountingApi.getPurchaseOrderAsPdf(tenantId, purchaseOrderId)
      const pdfBytes = response.body as unknown as Buffer

      let number: string | undefined
      if (needsPurchaseOrderNumber) {
        const purchaseOrderResponse = await xero.accountingApi.getPurchaseOrder(tenantId, purchaseOrderId)
        number = purchaseOrderResponse.body.purchaseOrders?.[0]?.purchaseOrderNumber
      }

      return {bytes: pdfBytes, purchaseOrderNumber: number}
    })

    const defaultFilename = `./PO-${purchaseOrderNumber ?? purchaseOrderId}.pdf`
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
