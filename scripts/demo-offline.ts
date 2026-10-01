import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {runMutationGate} from '../src/lib/ledgerops/mutation-gate.js'
import {loadOfflineIdentity} from '../src/lib/ledgerops/offline-target.js'
import {planInvoiceBatch} from '../src/lib/ledgerops/workflows/invoice-batch-plan.js'

// This harness has no credential resolver, live transport, or execution option.
if (process.argv.length > 2) throw new Error('Offline demo accepts no arguments')

const profileName = 'synthetic-offline-demo'
const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/offline-demo/${name}`, import.meta.url))
const identity = loadOfflineIdentity(fixture('identity.json'), profileName, 'invoices')
const csv = readFileSync(fixture('invoices.csv'), 'utf8')
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const planned = planInvoiceBatch(identity, csv, {
  schemaVersion: 'ledgerops.invoice-batch-plan.request.v1',
  profileName,
  batchId: 'synthetic-offline-batch',
  invoiceType: 'ACCREC',
  accountCode: '200',
  createdAt: identity.observedAt,
  haltPolicy: 'halt-on-stop',
  // Synthetic provenance only; neither digest claims a live receipt.
  sourceReceiptId: digest('synthetic-offline-demo-receipt'),
  sourceManifestHashes: [digest(csv)],
})
if (planned.status === 'STOP') throw new Error(`${planned.code}: ${planned.reason}`)

const {manifest, plans} = planned
let dispatches = 0
const outcome = await runMutationGate(
  {
    operation: 'batch-create',
    resource: 'invoices',
    // The gate's client field is unused in preview. No client identifier exists.
    target: {profileName, clientId: ''},
    summary: [`Synthetic batch ${manifest.batchId}`, `${plans.length} draft invoices`],
    sealedDigest: manifest.manifestDigest,
    payload: {
      batchId: manifest.batchId,
      profile: profileName,
      invoiceType: 'ACCREC',
      manifestDigest: manifest.manifestDigest,
      itemCount: plans.length,
      items: plans.map((entry, index) => ({
        index,
        planId: entry.planId,
        planDigest: entry.planDigest,
        ...entry.row,
      })),
    },
  },
  {execute: false, yes: false},
  {
    outputFormat: 'json',
    log: line => process.stdout.write(`${line}\n`),
    dispatchOnce: async () => {
      dispatches += 1
      throw new Error('Offline demo must never dispatch')
    },
  },
)
if (outcome.dispatched || dispatches !== 0) throw new Error('Offline preview invariant failed')
process.stderr.write(`Synthetic offline demo complete: ${dispatches} dispatches; no Xero connection.\n`)
