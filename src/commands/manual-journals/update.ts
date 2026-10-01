import {Flags} from '@oclif/core'
import {BaseCommand} from '../../base-command.js'
import {journalFileUpdateSchema, formatZodError} from '../../lib/validators.js'
import type {ManualJournal} from 'xero-node'

export default class ManualJournalsUpdate extends BaseCommand {
  static override description = 'Update a manual journal in Xero (preview by default; pass --execute to dispatch)'

  static override examples = [
    '<%= config.bin %> manual-journals update --file journal-update.json',
    '<%= config.bin %> manual-journals update --file journal-update.json --execute',
  ]

  static override flags = {
    ...BaseCommand.baseFlags,
    ...BaseCommand.mutationFlags,
    file: Flags.string({
      description:
        'JSON file with manualJournalID, narration, journalLines, and changed fields (status may be POSTED or VOIDED)',
      required: true,
    }),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(ManualJournalsUpdate)
    const target = this.resolveCredentials(flags)

    const fileData = this.readJsonFile(flags.file) as Record<string, unknown>

    const parsed = journalFileUpdateSchema.safeParse(fileData)
    if (!parsed.success) {
      this.error(`Validation errors:\n${formatZodError(parsed.error)}`)
    }

    await this.runGatedMutation(
      flags,
      {
        operation: 'update',
        resource: 'manual-journals',
        target,
        summary: [
          `manual journal ${parsed.data.manualJournalID}`,
          `changed fields: ${
            Object.keys(fileData)
              .filter(key => key !== 'manualJournalID')
              .join(', ') || '(none)'
          }`,
          ...(fileData.status ? [`status transition: to ${fileData.status}`] : []),
        ],
        payload: fileData,
      },
      async (xero, tenantId, snapshot) => {
        const sealedJournal = snapshot.payload as unknown as ManualJournal & {manualJournalID: string}
        const response = await xero.accountingApi.updateManualJournal(tenantId, sealedJournal.manualJournalID, {
          manualJournals: [sealedJournal],
        })
        const resource = response.body.manualJournals?.[0] as Record<string, unknown> | undefined
        return {resource, resultLine: `Manual journal updated: ${resource?.manualJournalID}`}
      },
    )
  }
}
