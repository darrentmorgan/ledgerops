import {Command, Flags} from '@oclif/core'
import {executeMutation, InMemoryReceiptSink} from '../../lib/ledgerops/index.js'
import {createDryRunTransport} from '../../lib/ledgerops/dry-run-transport.js'
import {applyRequestFor, loadOfflineIdentity, loadOfflinePlan} from '../../lib/ledgerops/offline-target.js'

export default class TargetApply extends Command {
  static override description = 'Exercise the guarded apply path using the in-memory dry-run transport only'

  static override flags = {
    profile: Flags.string({required: true, description: 'Explicit profile name'}),
    resource: Flags.string({required: true, description: 'Single resource type'}),
    identity: Flags.string({required: true, description: 'Offline identity JSON file'}),
    plan: Flags.string({required: true, description: 'Offline plan JSON file'}),
    confirm: Flags.string({required: true, description: 'Exact CONFIRM <plan digest> token'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(TargetApply)
    const identity = loadOfflineIdentity(flags.identity, flags.profile, flags.resource)
    const plan = loadOfflinePlan(flags.plan, flags.profile, flags.resource)
    const receipts = new InMemoryReceiptSink()
    const result = await executeMutation({
      request: applyRequestFor(plan),
      plan,
      confirmation: flags.confirm,
      context: {profileName: flags.profile, identity, receiptSink: receipts},
      transport: createDryRunTransport(identity),
    })
    this.log(JSON.stringify({result, receipts: receipts.receipts}, null, 2))
  }
}
