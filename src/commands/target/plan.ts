import {Command, Flags} from '@oclif/core'
import {confirmationTokenFor, createMutationPlan} from '../../lib/ledgerops/index.js'
import {loadOfflineIdentity, loadPlanInput} from '../../lib/ledgerops/offline-target.js'

export default class TargetPlan extends Command {
  static override description = 'Create a deterministic one-resource mutation preview from offline JSON'

  static override flags = {
    profile: Flags.string({required: true, description: 'Explicit profile name'}),
    resource: Flags.string({required: true, description: 'Single resource type'}),
    identity: Flags.string({required: true, description: 'Offline identity JSON file'}),
    input: Flags.string({required: true, description: 'Offline plan input JSON file'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(TargetPlan)
    const source = loadPlanInput(flags.input)
    const identity = loadOfflineIdentity(flags.identity, flags.profile, flags.resource)
    const plan = createMutationPlan({
      planId: source.planId ?? 'ledgerops-offline-plan',
      profileName: flags.profile,
      resource: flags.resource,
      operation: source.operation,
      target: identity,
      payload: source.payload,
      requiredCapabilities: source.requiredCapabilities,
      requiredScopes: source.requiredScopes,
      readBack: {expected: source.expected},
      ...(source.createdAt === undefined ? {} : {createdAt: source.createdAt}),
      ...(source.expiresAt === undefined ? {} : {expiresAt: source.expiresAt}),
    })
    this.log(JSON.stringify({plan, exactConfirmation: confirmationTokenFor(plan)}, null, 2))
  }
}
