import {Flags} from '@oclif/core'
import {BaseCommand} from '../../../base-command.js'
import {checkDirectMutationResult} from '../../../lib/ledgerops/direct-result.js'
import {trackingCategoryCreateSchema, formatZodError} from '../../../lib/validators.js'
import type {TrackingCategory} from 'xero-node'

export default class TrackingCategoriesCreate extends BaseCommand {
  static override description = 'Create a tracking category in Xero (preview by default; pass --execute to dispatch)'

  static override examples = [
    '<%= config.bin %> tracking categories create --name "Department"',
    '<%= config.bin %> tracking categories create --name "Department" --execute',
  ]

  static override flags = {
    ...BaseCommand.baseFlags,
    ...BaseCommand.mutationFlags,
    name: Flags.string({description: 'Category name', required: true}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(TrackingCategoriesCreate)

    const target = this.resolveCredentials(flags)
    const parsed = trackingCategoryCreateSchema.safeParse({name: flags.name})
    if (!parsed.success) {
      this.error(`Validation errors:\n${formatZodError(parsed.error)}`)
    }

    const category: TrackingCategory = {name: parsed.data.name}
    await this.runGatedMutation(
      flags,
      {
        operation: 'create',
        resource: 'tracking-categories',
        target,
        summary: [`tracking category ${category.name}`],
        payload: category as unknown as Record<string, unknown>,
      },
      async (xero, tenantId, snapshot) => {
        const response = await xero.accountingApi.createTrackingCategory(
          tenantId,
          snapshot.payload as unknown as TrackingCategory,
        )
        const resource = checkDirectMutationResult(response, 'tracking-categories')
        return {resource, resultLine: `Tracking category created: ${resource?.name} (${resource?.trackingCategoryID})`}
      },
    )
  }
}
