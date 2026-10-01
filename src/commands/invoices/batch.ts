import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {Flags} from '@oclif/core'
import {BaseCommand} from '../../base-command.js'
import {executeBatch} from '../../lib/ledgerops/batch-executor.js'
import {bindBatchManifestTenant} from '../../lib/ledgerops/batch-manifest.js'
import {observeBatchTarget} from '../../lib/ledgerops/batch-live-provenance.js'
import {createTargetBinding} from '../../lib/ledgerops/identity.js'
import {projectBatchResult, renderBatchResult, type BatchResult} from '../../lib/ledgerops/batch-result.js'
import {confirmationTokenFor} from '../../lib/ledgerops/confirmation.js'
import {createFileReceiptSink, defaultReceiptFilePath} from '../../lib/ledgerops/file-receipt-sink.js'
import {runMutationGate, type MutationDescriptor} from '../../lib/ledgerops/mutation-gate.js'
import {loadOfflineIdentity} from '../../lib/ledgerops/offline-target.js'
import type {TargetIdentity} from '../../lib/ledgerops/types.js'
import {createXeroLiveDraftTransport} from '../../lib/ledgerops/xero-live-draft.js'
import {planInvoiceBatch} from '../../lib/ledgerops/workflows/invoice-batch-plan.js'

const BATCH_RESOURCE = 'invoices'

/**
 * `ledgerops invoices batch` — the ADR-0011 batch journey behind one command.
 *
 * The command owns no execution policy. It resolves the target, plans the
 * batch, and hands one `MutationDescriptor` to the shared ADR-0013 gate; the
 * gate decides preview-versus-dispatch, whether a confirmation is presented,
 * and that dispatch happens at most once. Everything below the gate is the
 * unchanged kernel: `planInvoiceBatch` seals the manifest, `executeBatch`
 * preflights and runs it member by member, and `projectBatchResult` is the
 * only account of the run this command prints.
 *
 * The confirmation is bound to the sealed `manifestDigest`, the same digest
 * `executeBatch` re-checks, so a stale or altered manifest fails closed with
 * nothing dispatched.
 */
export default class InvoicesBatch extends BaseCommand {
  static override description =
    'Plan a CSV batch of DRAFT invoices and run it (preview by default; pass --execute to dispatch)'

  // Account and tax codes in these examples are organisation-specific; look yours up
  // with `accounts list` and `tax-rates list`.
  static override examples = [
    '<%= config.bin %> invoices batch --file invoices.csv --identity identity.json --account-code 200 --source-receipt-id <digest> --source-manifest-hash <digest>',
    '<%= config.bin %> invoices batch --file invoices.csv --identity identity.json --account-code 200 --source-receipt-id <digest> --source-manifest-hash <digest> --execute',
  ]

  static override flags = {
    ...BaseCommand.baseFlags,
    execute: Flags.boolean({
      description: 'Dispatch this batch now (non-interactive)',
      default: false,
    }),
    yes: Flags.boolean({
      description: "Answer 'yes' to an interactive confirmation prompt if one is presented",
      default: false,
    }),
    file: Flags.string({
      required: true,
      description: 'Invoice batch CSV (contact,reference,date,description,quantity,unitAmount)',
    }),
    identity: Flags.string({
      required: true,
      description: 'Verified target identity JSON for the invoices resource',
    }),
    'account-code': Flags.string({required: true, description: 'Account code applied to every line item'}),
    'invoice-type': Flags.string({
      description: 'Invoice type applied to every member',
      options: ['ACCREC', 'ACCPAY'],
      default: 'ACCREC',
    }),
    'tax-type': Flags.string({description: 'Tax type applied to every line item'}),
    'batch-id': Flags.string({description: 'Batch identifier sealed into the manifest'}),
    'halt-policy': Flags.string({
      description: 'What a pre-dispatch STOP does to the rest of the batch',
      options: ['halt-on-stop', 'continue-on-stop'],
      default: 'halt-on-stop',
    }),
    'ttl-ms': Flags.integer({description: 'Lifetime of the sealed plans and manifest, in milliseconds'}),
    'source-receipt-id': Flags.string({
      required: true,
      description: 'SHA-256 receipt digest this batch derives from',
    }),
    'source-manifest-hash': Flags.string({
      required: true,
      multiple: true,
      description: 'SHA-256 source manifest digest (repeatable)',
    }),
    receipts: Flags.string({description: 'Append-only receipt store path'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(InvoicesBatch)

    // Target resolution precedes payload validation (ADR-0013): every preview
    // is target-bound, and an unresolvable target never reaches the CSV.
    const credentials = this.resolveCredentials(flags)

    let identity: TargetIdentity
    try {
      identity = loadOfflineIdentity(flags.identity, credentials.profileName, BATCH_RESOURCE)
    } catch (caught) {
      return this.error(caught instanceof Error ? caught.message : String(caught))
    }

    let csv: string
    try {
      csv = readFileSync(resolve(flags.file), 'utf8')
    } catch {
      return this.error(`Batch CSV file could not be read: ${flags.file}`)
    }

    const planned = planInvoiceBatch(identity, csv, {
      schemaVersion: 'ledgerops.invoice-batch-plan.request.v1',
      profileName: credentials.profileName,
      ...(flags['batch-id'] === undefined ? {} : {batchId: flags['batch-id']}),
      invoiceType: flags['invoice-type'],
      accountCode: flags['account-code'],
      ...(flags['tax-type'] === undefined ? {} : {taxType: flags['tax-type']}),
      createdAt: Date.now(),
      ...(flags['ttl-ms'] === undefined ? {} : {ttlMs: flags['ttl-ms']}),
      haltPolicy: flags['halt-policy'],
      sourceReceiptId: flags['source-receipt-id'],
      // The sealed provenance is one deterministic ascending set; ordering the
      // repeated flag here is normalization, never a relaxation — a duplicate
      // still fails closed in the workflow.
      sourceManifestHashes: [...flags['source-manifest-hash']].sort(),
    })
    if (planned.status === 'STOP') {
      return this.error(`${planned.code}: ${planned.reason}`)
    }

    const {manifest: planningManifest, plans} = planned
    const manifest = bindBatchManifestTenant(planningManifest, createTargetBinding(identity).tenantFingerprint)
    const descriptor: MutationDescriptor = {
      operation: 'batch-create',
      resource: BATCH_RESOURCE,
      target: credentials,
      // Every member is named, never a count alone: a batch preview a reader
      // has to trust is not a preview.
      summary: [
        `batch ${manifest.batchId}`,
        `${plans.length} draft invoice(s)`,
        `type ${flags['invoice-type']}`,
        `halt policy ${manifest.haltPolicy}`,
        ...plans.map(
          (entry, index) =>
            `[${index}] ${entry.row.contact} · ${entry.row.reference} · ${entry.row.date}` +
            ` · ${entry.row.description} · ${entry.row.quantity} x ${entry.row.unitAmount}` +
            ` = ${entry.row.lineTotal}`,
        ),
      ],
      payload: {
        batchId: manifest.batchId,
        profile: credentials.profileName,
        invoiceType: flags['invoice-type'],
        haltPolicy: manifest.haltPolicy,
        manifestDigest: manifest.manifestDigest,
        itemCount: plans.length,
        items: plans.map((entry, index) => ({
          index,
          planId: entry.planId,
          planDigest: entry.planDigest,
          contact: entry.row.contact,
          reference: entry.row.reference,
          date: entry.row.date,
          description: entry.row.description,
          quantity: entry.row.quantity,
          unitAmount: entry.row.unitAmount,
          lineTotal: entry.row.lineTotal,
        })),
      },
      // What the user confirms is the manifest digest the executor re-checks.
      sealedDigest: manifest.manifestDigest,
    }

    let outcome: Awaited<ReturnType<typeof runMutationGate<BatchResult>>>
    try {
      outcome = await runMutationGate<BatchResult>(
        descriptor,
        {execute: flags.execute, yes: flags.yes},
        {
          log: line => this.log(line),
          promptLog: line => this.logToStderr(line),
          outputFormat: this.getOutputFormat(flags),
          dispatchOnce: async snapshot => {
            // ADR-0013: the dispatched request is built from the snapshot the
            // user was shown. The sealed manifest itself cannot be rebuilt
            // from a preview payload, so the binding is asserted instead: if
            // the confirmed digest is not this manifest's, nothing is written
            // and nothing is dispatched.
            if (snapshot.sealedDigest !== manifest.manifestDigest) {
              throw new Error(
                'BATCH_SNAPSHOT_DIGEST_MISMATCH: the confirmed batch digest is not the sealed manifest digest.',
              )
            }

            const client = await observeBatchTarget(manifest, identity, snapshot.target)
            const sink = createFileReceiptSink({path: flags.receipts ?? defaultReceiptFilePath()})
            // A store that cannot hold the manifest cannot be trusted to hold
            // the run's links or its closing receipt: refuse before dispatch.
            try {
              sink.writeBatchManifest(manifest)
            } catch {
              throw new Error('BATCH_MANIFEST_NOT_DURABLE: the receipt store refused the batch manifest.')
            }

            const execution = await executeBatch({
              manifest,
              plans: plans.map(entry => entry.plan),
              confirmation: confirmationTokenFor(snapshot.sealedDigest),
              context: {profileName: snapshot.target.profileName, identity, receiptSink: sink},
              transport: createXeroLiveDraftTransport(identity, {boundClient: client}),
              sink,
            })
            if (!execution.ok) {
              const detail = execution.preflight === undefined ? '' : `: ${execution.preflight.code}`
              throw new Error(`${execution.code}${detail}`)
            }
            return projectBatchResult(execution)
          },
        },
      )
    } catch (caught) {
      return this.error(caught instanceof Error ? caught.message : String(caught))
    }

    if (!outcome.dispatched || !outcome.response) {
      return
    }

    this.log(renderBatchResult(outcome.response, this.getOutputFormat(flags)))
  }
}
