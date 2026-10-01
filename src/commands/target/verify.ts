import {Command, Flags} from '@oclif/core'
import {
  redactTargetIdentity,
  createXeroLiveIdentityTransport,
  verifyLiveDemoIdentity,
} from '../../lib/ledgerops/index.js'
import {loadOfflineIdentity} from '../../lib/ledgerops/offline-target.js'

export default class TargetVerify extends Command {
  static override description = 'Verify a supplied offline fixture or one live Demo organisation identity'

  static override flags = {
    profile: Flags.string({description: 'Explicit profile name'}),
    resource: Flags.string({description: 'Single resource type'}),
    input: Flags.string({description: 'Offline identity JSON file; mutually exclusive with --live-demo'}),
    'live-demo': Flags.boolean({default: false, description: 'Perform the one-shot live Demo identity read'}),
    'expect-demo-company': Flags.boolean({default: false, description: 'Require explicit Demo Company identity'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(TargetVerify)

    if (flags['live-demo']) {
      const receipt = await verifyLiveDemoIdentity({
        profileName: flags.profile,
        resource: flags.resource,
        liveDemo: true,
        expectDemoCompany: flags['expect-demo-company'],
        inputProvided: flags.input !== undefined,
        transport: createXeroLiveIdentityTransport(),
      })
      this.log(JSON.stringify(receipt))
      return
    }

    if (!flags.profile || !flags.resource || !flags.input) {
      this.error('--profile, --resource, and --input are required unless --live-demo is set')
    }
    const identity = loadOfflineIdentity(flags.input, flags.profile, flags.resource)
    this.log(JSON.stringify(redactTargetIdentity(identity), null, 2))
  }
}
