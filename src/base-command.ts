import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {Command, Flags} from '@oclif/core'
import type {XeroClient} from 'xero-node'
import {getProfileClientId, getDefaultProfile} from './lib/profiles.js'
import {withRetry, withSingleAttempt} from './lib/xero-client.js'
import {formatOutput, type OutputFormat} from './lib/formatters.js'
import {
  runMutationGate,
  type MutationDescriptor,
  type MutationDescriptorSnapshot,
} from './lib/ledgerops/mutation-gate.js'

export abstract class BaseCommand extends Command {
  static baseFlags = {
    profile: Flags.string({
      char: 'p',
      description: 'Xero profile name',
      env: 'XERO_PROFILE',
    }),
    'client-id': Flags.string({
      description: 'Xero client ID (overrides profile)',
      env: 'XERO_CLIENT_ID',
    }),
    json: Flags.boolean({
      description: 'Output as JSON',
      default: false,
    }),
    csv: Flags.boolean({
      description: 'Output as CSV',
      default: false,
    }),
    toon: Flags.boolean({
      description: 'Output as TOON',
      default: false,
    }),
  }

  static mutationFlags = {
    execute: Flags.boolean({description: 'Dispatch this mutation once (preview by default)', default: false}),
    yes: Flags.boolean({
      description: 'Answer an interactive confirmation; never dispatches without --execute',
      default: false,
    }),
  }

  /** Commands describe and dispatch; this helper owns execution and output policy. */
  protected async runGatedMutation(
    flags: {execute?: boolean; yes?: boolean; json?: boolean; csv?: boolean; toon?: boolean},
    descriptor: MutationDescriptor,
    dispatch: (
      xero: XeroClient,
      tenantId: string,
      snapshot: MutationDescriptorSnapshot,
    ) => Promise<{
      resource: Record<string, unknown> | undefined
      resultLine: string
    }>,
  ): Promise<void> {
    try {
      const outcome = await runMutationGate(
        descriptor,
        {execute: flags.execute ?? false, yes: flags.yes ?? false},
        {
          log: line => this.log(line),
          promptLog: line => this.logToStderr(line),
          outputFormat: this.getOutputFormat(flags),
          dispatchOnce: snapshot =>
            this.xeroMutationCall(snapshot.target, (xero, tenantId) => dispatch(xero, tenantId, snapshot)),
        },
      )
      if (!outcome.dispatched || !outcome.response) return
      const {resource, resultLine} = outcome.response
      const format = this.getOutputFormat(flags)
      if (format === 'table') this.log(resultLine)
      else if (format === 'json') this.log(JSON.stringify(resource ?? null, null, 2))
      else
        this.outputFormatted(
          resource ? [resource] : [],
          Object.keys(resource ?? {}).map(key => ({key, header: key})),
          flags,
        )
    } catch (caught) {
      this.error(caught instanceof Error ? caught.message : String(caught))
    }
  }

  protected resolveCredentials(flags: {profile?: string; 'client-id'?: string}): {
    profileName: string
    clientId: string
  } {
    // Priority 1: Explicit client-id flag
    if (flags['client-id']) {
      return {
        profileName: flags.profile ?? '_inline',
        clientId: flags['client-id'],
      }
    }

    // Priority 2: Named profile or default
    const profileName = flags.profile ?? getDefaultProfile()
    if (!profileName) {
      this.error('No profile configured. Run "ledgerops profile add <name>" to set up a profile.')
    }

    const clientId = getProfileClientId(profileName)
    return {profileName, clientId}
  }

  protected async xeroCall<T>(
    flags: {profile?: string; 'client-id'?: string},
    operation: (xero: XeroClient, tenantId: string) => Promise<T>,
  ): Promise<T> {
    const {profileName, clientId} = this.resolveCredentials(flags)
    return withRetry(profileName, clientId, operation)
  }

  protected async xeroMutationCall<T>(
    credentials: {profileName: string; clientId: string},
    operation: (xero: XeroClient, tenantId: string) => Promise<T>,
  ): Promise<T> {
    return withSingleAttempt(credentials.profileName, credentials.clientId, operation)
  }

  protected getOutputFormat(flags: {json?: boolean; csv?: boolean; toon?: boolean}): OutputFormat {
    if (flags.json) return 'json'
    if (flags.toon) return 'toon'
    if (flags.csv) return 'csv'
    return 'table'
  }

  protected outputFormatted(
    data: Record<string, unknown>[],
    columns: {key: string; header: string; format?: (value: unknown) => string}[],
    flags: {json?: boolean; csv?: boolean; toon?: boolean},
  ): void {
    const format = this.getOutputFormat(flags)
    this.log(formatOutput(data, columns, format))
  }

  protected async getOrgShortCode(xero: XeroClient, tenantId: string): Promise<string | undefined> {
    try {
      const response = await xero.accountingApi.getOrganisations(tenantId)
      const org = response.body.organisations?.[0]
      return (org as Record<string, unknown>)?.shortCode as string | undefined
    } catch {
      return undefined
    }
  }

  protected readJsonFile(filePath: string): unknown {
    try {
      const content = readFileSync(resolve(filePath), 'utf-8')
      return JSON.parse(content)
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.error(`File not found: ${filePath}`)
      }
      if (error instanceof SyntaxError) {
        this.error(`Invalid JSON in file: ${filePath}`)
      }
      throw error
    }
  }
}
