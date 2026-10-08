import {Flags} from '@oclif/core'
import {BaseCommand} from '../../base-command.js'
import {checkDirectMutationResult} from '../../lib/ledgerops/direct-result.js'
import {itemUpdateSchema, itemFileUpdateSchema, formatZodError} from '../../lib/validators.js'
import type {Item} from 'xero-node'

export default class ItemsUpdate extends BaseCommand {
  static override description = 'Update an item in Xero (preview by default; pass --execute to dispatch)'

  static override examples = [
    '<%= config.bin %> items update --file item-update.json',
    '<%= config.bin %> items update --item-id abc-123 --code WIDGET --name "Updated Widget"',
    '<%= config.bin %> items update --file item-update.json --execute',
  ]

  static override flags = {
    ...BaseCommand.baseFlags,
    ...BaseCommand.mutationFlags,
    file: Flags.string({description: 'JSON file with item update data'}),
    'item-id': Flags.string({description: 'Item ID'}),
    code: Flags.string({description: 'Item code'}),
    name: Flags.string({description: 'Item name'}),
    description: Flags.string({description: 'Item description'}),
    'sale-price': Flags.string({description: 'Sales unit price'}),
    'purchase-price': Flags.string({description: 'Purchase unit price'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(ItemsUpdate)

    const target = this.resolveCredentials(flags)
    let item: Item
    if (flags.file) {
      const fileData = this.readJsonFile(flags.file) as Record<string, unknown>
      const parsed = itemFileUpdateSchema.safeParse(fileData)
      if (!parsed.success) this.error(`Validation errors:\n${formatZodError(parsed.error)}`)
      item = fileData as unknown as Item
    } else {
      const parsed = itemUpdateSchema.safeParse({
        itemId: flags['item-id'],
        code: flags.code,
        name: flags.name,
        description: flags.description,
        salesDetails: flags['sale-price'] ? {unitPrice: Number(flags['sale-price'])} : undefined,
        purchaseDetails: flags['purchase-price'] ? {unitPrice: Number(flags['purchase-price'])} : undefined,
      })
      if (!parsed.success) this.error(`Validation errors:\n${formatZodError(parsed.error)}`)
      item = {
        itemID: parsed.data.itemId,
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

    const changedFields = Object.keys(item).filter(key => key !== 'itemID' && item[key as keyof Item] !== undefined)
    await this.runGatedMutation(
      flags,
      {
        operation: 'update',
        resource: 'items',
        target,
        summary: [
          `item ${item.itemID}${item.code ? ` (${item.code})` : ''}`,
          `changed fields: ${changedFields.join(', ') || '(none)'}`,
        ],
        payload: item as unknown as Record<string, unknown>,
      },
      async (xero, tenantId, snapshot) => {
        const sealedItem = snapshot.payload as unknown as Item & {itemID: string}
        const response = await xero.accountingApi.updateItem(tenantId, sealedItem.itemID, {items: [sealedItem]})
        const resource = checkDirectMutationResult(response, 'items', sealedItem.itemID)
        return {resource, resultLine: `Item updated: ${resource?.code} - ${resource?.name} (${resource?.itemID})`}
      },
    )
  }
}
