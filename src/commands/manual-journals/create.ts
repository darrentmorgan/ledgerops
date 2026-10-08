import {Flags} from '@oclif/core'
import {BaseCommand} from '../../base-command.js'
import {checkDirectMutationResult} from '../../lib/ledgerops/direct-result.js'
import {journalFileCreateSchema, formatZodError} from '../../lib/validators.js'
import type {ManualJournal} from 'xero-node'

export default class ManualJournalsCreate extends BaseCommand {
  static override description = 'Create a manual journal in Xero (preview by default; pass --execute to dispatch)'

  static override examples = [
    '<%= config.bin %> manual-journals create --file journal.json',
    '<%= config.bin %> manual-journals create --file journal.json --execute',
  ]

  static override flags = {
    ...BaseCommand.baseFlags,
    ...BaseCommand.mutationFlags,
    file: Flags.string({description: 'JSON file with journal data', required: true}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(ManualJournalsCreate)
    const target = this.resolveCredentials(flags)

    const fileData = this.readJsonFile(flags.file) as Record<string, unknown>

    const parsed = journalFileCreateSchema.safeParse(fileData)
    if (!parsed.success) {
      this.error(`Validation errors:\n${formatZodError(parsed.error)}`)
    }

    await this.runGatedMutation(
      flags,
      {
        operation: 'create',
        resource: 'manual-journals',
        target,
        summary: [
          `narration ${fileData.narration}`,
          `${parsed.data.journalLines.length} journal line(s)`,
          ...(fileData.status ? [`status: ${fileData.status}`] : []),
        ],
        payload: fileData,
      },
      async (xero, tenantId, snapshot) => {
        const response = await xero.accountingApi.createManualJournals(tenantId, {
          manualJournals: [snapshot.payload as unknown as ManualJournal],
        })
        const resource = checkDirectMutationResult(response, 'manual-journals')
        return {resource, resultLine: `Manual journal created: ${resource?.manualJournalID}`}
      },
    )
  }
}
