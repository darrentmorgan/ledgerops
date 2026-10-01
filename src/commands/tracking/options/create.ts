import {Flags} from '@oclif/core'
import {BaseCommand} from '../../../base-command.js'
import {trackingOptionsCreateSchema, formatZodError} from '../../../lib/validators.js'
import type {TrackingOption} from 'xero-node'

export default class TrackingOptionsCreate extends BaseCommand {
  static override description = 'Create one tracking option in Xero (preview by default; pass --execute to dispatch)'

  static override examples = [
    '<%= config.bin %> tracking options create --category-id abc-123 --name "Sales"',
    '<%= config.bin %> tracking options create --category-id abc-123 --name "Sales" --execute',
  ]

  static override flags = {
    ...BaseCommand.baseFlags,
    ...BaseCommand.mutationFlags,
    'category-id': Flags.string({description: 'Tracking category ID', required: true}),
    name: Flags.string({description: 'One option name', required: true}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(TrackingOptionsCreate)
    const target = this.resolveCredentials(flags)
    const parsed = trackingOptionsCreateSchema.safeParse({
      trackingCategoryId: flags['category-id'],
      optionNames: [flags.name],
    })
    if (!parsed.success) {
      this.error(`Validation errors:\n${formatZodError(parsed.error)}`)
    }

    const option: TrackingOption = {name: parsed.data.optionNames[0]}
    await this.runGatedMutation(
      flags,
      {
        operation: 'create',
        resource: 'tracking-options',
        target,
        summary: [`tracking category ${parsed.data.trackingCategoryId}`, `tracking option ${option.name}`],
        payload: {trackingCategoryID: parsed.data.trackingCategoryId, option},
      },
      async (xero, tenantId, snapshot) => {
        const sealed = snapshot.payload as unknown as {trackingCategoryID: string; option: TrackingOption}
        const response = await xero.accountingApi.createTrackingOptions(
          tenantId,
          sealed.trackingCategoryID,
          sealed.option,
        )
        const resource = response.body.options?.[0] as Record<string, unknown> | undefined
        return {resource, resultLine: `Tracking option created: ${resource?.name} (${resource?.trackingOptionID})`}
      },
    )
  }
}
