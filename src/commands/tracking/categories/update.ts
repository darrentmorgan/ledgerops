import {Flags} from '@oclif/core'
import {BaseCommand} from '../../../base-command.js'
import {trackingCategoryUpdateSchema, formatZodError} from '../../../lib/validators.js'
import type {TrackingCategory} from 'xero-node'

export default class TrackingCategoriesUpdate extends BaseCommand {
  static override description = 'Update a tracking category in Xero (preview by default; pass --execute to dispatch)'

  static override examples = [
    '<%= config.bin %> tracking categories update --category-id abc-123 --name "Updated Name"',
    '<%= config.bin %> tracking categories update --category-id abc-123 --status ARCHIVED',
    '<%= config.bin %> tracking categories update --category-id abc-123 --status ARCHIVED --execute',
  ]

  static override flags = {
    ...BaseCommand.baseFlags,
    ...BaseCommand.mutationFlags,
    'category-id': Flags.string({description: 'Tracking category ID', required: true}),
    name: Flags.string({description: 'New category name'}),
    status: Flags.string({description: 'Category status', options: ['ACTIVE', 'ARCHIVED']}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(TrackingCategoriesUpdate)

    const target = this.resolveCredentials(flags)
    const parsed = trackingCategoryUpdateSchema.safeParse({
      trackingCategoryId: flags['category-id'],
      name: flags.name,
      status: flags.status,
    })
    if (!parsed.success) {
      this.error(`Validation errors:\n${formatZodError(parsed.error)}`)
    }

    if (parsed.data.name === undefined && parsed.data.status === undefined) {
      this.error('Validation errors: At least one change (name or status) is required')
    }
    const category: TrackingCategory = {
      trackingCategoryID: parsed.data.trackingCategoryId,
      name: parsed.data.name,
      status: parsed.data.status as TrackingCategory['status'],
    }
    const changedFields = Object.keys(category).filter(
      key => key !== 'trackingCategoryID' && category[key as keyof TrackingCategory] !== undefined,
    )
    await this.runGatedMutation(
      flags,
      {
        operation: 'update',
        resource: 'tracking-categories',
        target,
        summary: [
          `tracking category ${category.trackingCategoryID}${category.name ? ` (${category.name})` : ''}`,
          `changed fields: ${changedFields.join(', ')}`,
          ...(category.status ? [`status ${category.status}`] : []),
        ],
        payload: category as unknown as Record<string, unknown>,
      },
      async (xero, tenantId, snapshot) => {
        const sealedCategory = snapshot.payload as unknown as TrackingCategory & {trackingCategoryID: string}
        const response = await xero.accountingApi.updateTrackingCategory(
          tenantId,
          sealedCategory.trackingCategoryID,
          sealedCategory,
        )
        const resource = response.body.trackingCategories?.[0] as Record<string, unknown> | undefined
        return {resource, resultLine: `Tracking category updated: ${resource?.name} (${resource?.trackingCategoryID})`}
      },
    )
  }
}
