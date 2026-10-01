import {Command, Flags} from '@oclif/core'
import {
  createFileReceiptSink,
  createFixtureReadTransport,
  createXeroLiveReadTransport,
  FOUNDATION_READ_RESOURCES,
  InMemoryReadReceiptSink,
  isMatchingReadResource,
  isReportingReadResource,
  MATCHING_READ_RESOURCES,
  REPORTING_READ_RESOURCES,
  runFoundationRead,
  runMatchingRead,
  runReportingRead,
  type JsonValue,
  type ReadReceiptSink,
  type ReadTransport,
} from '../../lib/ledgerops/index.js'
import {loadOfflineIdentity, loadOfflineReadRecords, OfflineTargetError} from '../../lib/ledgerops/offline-target.js'

export default class TargetRead extends Command {
  static override description =
    'Run one bounded Tier 0 read (foundation, reporting, or matching lane) through the kernel'

  static override flags = {
    profile: Flags.string({required: true, description: 'Explicit profile name'}),
    resource: Flags.string({
      required: true,
      description: `One of: ${[
        ...FOUNDATION_READ_RESOURCES,
        ...REPORTING_READ_RESOURCES,
        ...MATCHING_READ_RESOURCES,
      ].join(', ')}`,
    }),
    identity: Flags.string({required: true, description: 'Offline identity JSON file'}),
    records: Flags.string({description: 'Synthetic records JSON array file; mutually exclusive with --live'}),
    live: Flags.boolean({default: false, description: 'Read from Xero through the live Tier 0 adapter'}),
    query: Flags.string({description: 'Resource query as a JSON object string'}),
    'max-calls': Flags.integer({description: 'Explicit transport call bound (default 1)'}),
    receipts: Flags.string({description: 'Receipt file path override; requires --live'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(TargetRead)
    if (flags.live === (flags.records !== undefined)) {
      this.error('Exactly one of --records or --live is required')
    }
    // `--live` defaults to false, so oclif dependsOn cannot express this.
    if (!flags.live && flags.receipts !== undefined) {
      this.error('--receipts requires --live; offline fixture receipts stay in memory')
    }

    const identity = loadOfflineIdentity(flags.identity, flags.profile, flags.resource)

    let query: Record<string, JsonValue> | undefined
    if (flags.query !== undefined) {
      let parsed: unknown
      try {
        parsed = JSON.parse(flags.query)
      } catch {
        this.error('--query must be valid JSON')
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        this.error('--query must be one JSON object')
      }
      query = parsed as Record<string, JsonValue>
    }

    let transport: ReadTransport
    let receiptSink: ReadReceiptSink
    if (flags.live) {
      // Live reads persist through the durable ADR-0009 store; offline runs
      // stay in memory so fixtures never write to the operator's ledger.
      transport = createXeroLiveReadTransport(identity)
      receiptSink = createFileReceiptSink(flags.receipts === undefined ? {} : {path: flags.receipts})
    } else {
      try {
        const records = loadOfflineReadRecords(flags.records as string)
        transport = createFixtureReadTransport(identity, records, query ?? {})
      } catch (error) {
        if (error instanceof OfflineTargetError || error instanceof TypeError) this.error(error.message)
        throw error
      }
      receiptSink = new InMemoryReadReceiptSink()
    }

    // Route by lane; each workflow STOPs any resource outside its own list,
    // so an unknown resource still terminates as a structured STOP.
    const runRead = isReportingReadResource(flags.resource)
      ? runReportingRead
      : isMatchingReadResource(flags.resource)
        ? runMatchingRead
        : runFoundationRead
    const result = await runRead({
      request: {
        profileName: flags.profile,
        resource: flags.resource,
        ...(query === undefined ? {} : {query}),
        ...(flags['max-calls'] === undefined ? {} : {maxCalls: flags['max-calls']}),
      },
      context: {identity, receiptSink},
      transport,
    })
    this.log(JSON.stringify(result, null, 2))
    if (result.stop) process.exitCode = 1
  }
}
