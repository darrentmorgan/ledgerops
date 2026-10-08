import {Flags} from '@oclif/core'
import {BaseCommand} from '../../../base-command.js'
import {checkDirectMutationResult} from '../../../lib/ledgerops/direct-result.js'
import {trackingOptionsUpdateSchema, formatZodError} from '../../../lib/validators.js'
import type {TrackingOption} from 'xero-node'

export default class TrackingOptionsUpdate extends BaseCommand {
  static override description = 'Update one tracking option in Xero (preview by default; pass --execute to dispatch)'

  static override examples = [
    '<%= config.bin %> tracking options update --category-id abc-123 --option-id def-456 --name "Sales"',
    '<%= config.bin %> tracking options update --category-id abc-123 --option-id def-456 --status ARCHIVED',
    '<%= config.bin %> tracking options update --category-id abc-123 --option-id def-456 --status ARCHIVED --execute',
  ]

  static override flags = {
    ...BaseCommand.baseFlags,
    ...BaseCommand.mutationFlags,
    'category-id': Flags.string({description: 'Tracking category ID', required: true}),
    'option-id': Flags.string({description: 'Tracking option ID', required: true}),
    name: Flags.string({description: 'New option name'}),
    status: Flags.string({description: 'Option status', options: ['ACTIVE', 'ARCHIVED']}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(TrackingOptionsUpdate)
    const target = this.resolveCredentials(flags)
    const parsed = trackingOptionsUpdateSchema.safeParse({
      trackingCategoryId: flags['category-id'],
      options: [{trackingOptionId: flags['option-id'], name: flags.name, status: flags.status}],
    })
    if (!parsed.success) {
      this.error(`Validation errors:\n${formatZodError(parsed.error)}`)
    }

    const change = parsed.data.options[0]
    if (change.name === undefined && change.status === undefined) {
      this.error('Validation errors: At least one change (name or status) is required')
    }
    const option: TrackingOption = {
      trackingOptionID: change.trackingOptionId,
      name: change.name,
      status: change.status as TrackingOption['status'],
    }
    const changedFields = Object.keys(option).filter(
      key => key !== 'trackingOptionID' && option[key as keyof TrackingOption] !== undefined,
    )
    await this.runGatedMutation(
      flags,
      {
        operation: 'update',
        resource: 'tracking-options',
        target,
        summary: [
          `tracking category ${parsed.data.trackingCategoryId}`,
          `tracking option ${option.trackingOptionID}${option.name ? ` (${option.name})` : ''}`,
          `changed fields: ${changedFields.join(', ')}`,
          ...(option.status ? [`status ${option.status}`] : []),
        ],
        payload: {trackingCategoryID: parsed.data.trackingCategoryId, option},
      },
      async (xero, tenantId, snapshot) => {
        const sealed = snapshot.payload as unknown as {
          trackingCategoryID: string
          option: TrackingOption & {trackingOptionID: string}
        }
        const response = await xero.accountingApi.updateTrackingOptions(
          tenantId,
          sealed.trackingCategoryID,
          sealed.option.trackingOptionID,
          sealed.option,
        )
        const resource = checkDirectMutationResult(response, 'tracking-options', sealed.option.trackingOptionID)
        return {resource, resultLine: `Tracking option updated: ${resource?.name} (${resource?.trackingOptionID})`}
      },
    )
  }
}
