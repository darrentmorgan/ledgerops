import {Flags} from '@oclif/core'
import {BaseCommand} from '../../base-command.js'
import {checkDirectMutationResult} from '../../lib/ledgerops/direct-result.js'
import {itemCreateSchema, itemFileCreateSchema, formatZodError} from '../../lib/validators.js'
import type {Item} from 'xero-node'

export default class ItemsCreate extends BaseCommand {
  static override description = 'Create an item in Xero (preview by default; pass --execute to dispatch)'

  static override examples = [
    '<%= config.bin %> items create --code WIDGET --name "Widget" --sale-price 29.99',
    '<%= config.bin %> items create --file item.json',
    '<%= config.bin %> items create --file item.json --execute',
  ]

  static override flags = {
    ...BaseCommand.baseFlags,
    ...BaseCommand.mutationFlags,
    file: Flags.string({description: 'JSON file with item data'}),
    code: Flags.string({description: 'Item code'}),
    name: Flags.string({description: 'Item name'}),
    description: Flags.string({description: 'Item description'}),
    'sale-price': Flags.string({description: 'Sales unit price'}),
    'purchase-price': Flags.string({description: 'Purchase unit price'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(ItemsCreate)

    const target = this.resolveCredentials(flags)
    let item: Item
    if (flags.file) {
      const fileData = this.readJsonFile(flags.file) as Record<string, unknown>
      const parsed = itemFileCreateSchema.safeParse(fileData)
      if (!parsed.success) this.error(`Validation errors:\n${formatZodError(parsed.error)}`)
      item = fileData as unknown as Item
    } else {
      const parsed = itemCreateSchema.safeParse({
        code: flags.code,
        name: flags.name,
        description: flags.description,
        salesDetails: flags['sale-price'] ? {unitPrice: Number(flags['sale-price'])} : undefined,
        purchaseDetails: flags['purchase-price'] ? {unitPrice: Number(flags['purchase-price'])} : undefined,
      })
      if (!parsed.success) this.error(`Validation errors:\n${formatZodError(parsed.error)}`)
      item = {
        code: parsed.data.code,
        name: parsed.data.name,
        description: parsed.data.description,
        purchaseDescription: parsed.data.purchaseDescription,
        isTrackedAsInventory: parsed.data.isTrackedAsInventory,
        inventoryAssetAccountCode: parsed.data.inventoryAssetAccountCode,
        salesDetails: parsed.data.salesDetails as Item['salesDetails'],
        purchaseDetails: parsed.data.purchaseDetails as Item['purchaseDetails'],
      }
    }

    await this.runGatedMutation(
      flags,
      {
        operation: 'create',
        resource: 'items',
        target,
        summary: [`item ${item.code} (${item.name})`],
        payload: item as unknown as Record<string, unknown>,
      },
      async (xero, tenantId, snapshot) => {
        const response = await xero.accountingApi.createItems(tenantId, {
          items: [snapshot.payload as unknown as Item],
        })
        const resource = checkDirectMutationResult(response, 'items')
        return {resource, resultLine: `Item created: ${resource?.code} - ${resource?.name} (${resource?.itemID})`}
      },
    )
  }
}
