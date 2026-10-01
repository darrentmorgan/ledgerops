import {describe, expect, it} from 'vitest'
import {
  createTargetIdentity,
  digestJson,
  planInvoiceBatch,
  assembleInvoiceBatchManifest,
  verifyPlanIntegrity,
  verifyBatchManifestIntegrity,
  type InvoiceBatchPlanEntry,
  type InvoiceBatchPlanRequest,
  type InvoiceBatchPlanResult,
  type InvoiceBatchPlanStop,
} from '../../../../src/lib/ledgerops/index.js'

/**
 * Offline contract tests for the invoice-batch journey plan/manifest
 * builder (issue #60): parsed CSV rows become one signed DRAFT invoice plan
 * each, and one `ledgerops.batch-manifest.v1` seals them. Nothing here
 * touches the network, the Xero SDK, or real tenant data.
 */

const HEADER = 'contact,reference,date,description,quantity,unitAmount'

function csvFor(...dataRows: string[]): string {
  return [HEADER, ...dataRows].join('\n')
}

const HAPPY_CSV = csvFor(
  'Synthetic Coffee Co,SC-001,2026-08-01,Beans whole 1kg,2,10.50',
  'Synthetic Desk Works,SD-002,2026-08-02,Standing desk assembly,1.5,200',
)

const CREATED_AT = Date.parse('2026-08-25T00:00:00.000Z')

function target() {
  return createTargetIdentity({
    profileName: 'demo-profile',
    tenantId: 'tenant-alpha',
    resource: 'invoices',
    isDemoCompany: true,
    observedAt: CREATED_AT,
  })
}

function syntheticDigest(seed: string): string {
  return digestJson({seed})
}

function requestFor(overrides: Partial<InvoiceBatchPlanRequest> = {}): InvoiceBatchPlanRequest {
  return {
    schemaVersion: 'ledgerops.invoice-batch-plan.request.v1',
    profileName: 'demo-profile',
    batchId: 'batch-1',
    invoiceType: 'ACCREC',
    accountCode: '200',
    createdAt: CREATED_AT,
    sourceReceiptId: syntheticDigest('source-receipt'),
    sourceManifestHashes: [syntheticDigest('source-a'), syntheticDigest('source-b')].sort(),
    ...overrides,
  }
}

function expectPlanned(result: InvoiceBatchPlanResult | InvoiceBatchPlanStop): InvoiceBatchPlanResult {
  expect(result.status).toBe('PLANNED')
  if (result.status !== 'PLANNED') throw new Error('expected a PLANNED result')
  return result
}

function expectStop(result: InvoiceBatchPlanResult | InvoiceBatchPlanStop, code: string): InvoiceBatchPlanStop {
  expect(result.status).toBe('STOP')
  if (result.status !== 'STOP') throw new Error('expected a STOP result')
  expect(result.code).toBe(code)
  return result
}

describe('invoice batch plan and manifest builder', () => {
  it('turns each parsed row into one signed DRAFT invoice plan (RED: not yet implemented)', () => {
    const result = expectPlanned(planInvoiceBatch(target(), HAPPY_CSV, requestFor()))

    expect(result.plans).toHaveLength(2)
    for (const entry of result.plans) {
      expect(entry.plan.objectCount).toBe(1)
      expect(entry.plan.requiresDemoCompany).toBe(true)
      expect(entry.plan.profileName).toBe('demo-profile')
      expect(entry.plan.resource).toBe('invoices')
      expect(verifyPlanIntegrity(entry.plan)).toBe(true)
      expect(entry.planDigest).toBe(entry.plan.planDigest)
    }
    expect(verifyBatchManifestIntegrity(result.manifest)).toBe(true)
    expect(result.manifest.memberCount).toBe(2)
    expect(result.manifest.entries.map(e => e.planId)).toEqual(result.plans.map(p => p.planId))
  })

  it('produces identical plan digests and manifest digest for the same fixture twice', () => {
    const first = expectPlanned(planInvoiceBatch(target(), HAPPY_CSV, requestFor()))
    const second = expectPlanned(planInvoiceBatch(target(), HAPPY_CSV, requestFor()))

    expect(second.plans.map(p => p.planDigest)).toEqual(first.plans.map(p => p.planDigest))
    expect(second.manifest.manifestDigest).toBe(first.manifest.manifestDigest)
  })

  it("changes exactly the edited row's plan digest and the manifest digest", () => {
    const baseline = expectPlanned(planInvoiceBatch(target(), HAPPY_CSV, requestFor()))

    const editedCsv = csvFor(
      'Synthetic Coffee Co,SC-001,2026-08-01,Beans whole 1kg,3,10.50',
      'Synthetic Desk Works,SD-002,2026-08-02,Standing desk assembly,1.5,200',
    )
    const edited = expectPlanned(planInvoiceBatch(target(), editedCsv, requestFor()))

    expect(edited.plans[0].planDigest).not.toBe(baseline.plans[0].planDigest)
    expect(edited.plans[1].planDigest).toBe(baseline.plans[1].planDigest)
    expect(edited.manifest.manifestDigest).not.toBe(baseline.manifest.manifestDigest)
  })

  it('refuses a mixed-profile or cross-tenant manifest assembly', () => {
    const planned = expectPlanned(planInvoiceBatch(target(), HAPPY_CSV, requestFor()))
    const otherTenantResult = expectPlanned(
      planInvoiceBatch(
        createTargetIdentity({
          profileName: 'demo-profile',
          tenantId: 'tenant-beta',
          resource: 'invoices',
          isDemoCompany: true,
          observedAt: CREATED_AT,
        }),
        csvFor('Synthetic Paper Trail,SP-003,2026-08-03,Paper carton,6,18.25'),
        requestFor(),
      ),
    )

    const mixedTenantEntries: InvoiceBatchPlanEntry[] = [planned.plans[0], otherTenantResult.plans[0]]
    expectStop(assembleInvoiceBatchManifest(requestFor(), mixedTenantEntries), 'MANIFEST_ERROR')

    const otherProfileResult = expectPlanned(
      planInvoiceBatch(
        createTargetIdentity({
          profileName: 'other-profile',
          tenantId: 'tenant-alpha',
          resource: 'invoices',
          isDemoCompany: true,
          observedAt: CREATED_AT,
        }),
        csvFor('Synthetic Paper Trail,SP-003,2026-08-03,Paper carton,6,18.25'),
        requestFor({profileName: 'other-profile'}),
      ),
    )
    const mixedProfileEntries: InvoiceBatchPlanEntry[] = [planned.plans[0], otherProfileResult.plans[0]]
    expectStop(assembleInvoiceBatchManifest(requestFor(), mixedProfileEntries), 'MANIFEST_ERROR')
  })

  it('refuses a batch CSV parse error with no manifest produced', () => {
    const badCsv = csvFor('Synthetic Coffee Co,SC-001,2026-08-01,Beans whole 1kg,0,10.50')
    expectStop(planInvoiceBatch(target(), badCsv, requestFor()), 'INVALID_BATCH_CSV')
  })

  it('refuses a target that does not bind the invoices resource', () => {
    const wrongResourceTarget = createTargetIdentity({
      profileName: 'demo-profile',
      tenantId: 'tenant-alpha',
      resource: 'manual-journals',
      isDemoCompany: true,
      observedAt: CREATED_AT,
    })
    expectStop(planInvoiceBatch(wrongResourceTarget, HAPPY_CSV, requestFor()), 'TARGET_RESOURCE_MISMATCH')
  })

  it('refuses a request profile that does not match the target profile', () => {
    expectStop(
      planInvoiceBatch(target(), HAPPY_CSV, requestFor({profileName: 'someone-elses-profile'})),
      'TARGET_PROFILE_MISMATCH',
    )
  })

  it('refuses malformed provenance and an unsupported schema version', () => {
    expectStop(
      planInvoiceBatch(target(), HAPPY_CSV, requestFor({sourceReceiptId: 'not-a-digest'})),
      'INVALID_PROVENANCE',
    )
    expectStop(planInvoiceBatch(target(), HAPPY_CSV, requestFor({sourceManifestHashes: []})), 'INVALID_PROVENANCE')
    expectStop(
      planInvoiceBatch(
        target(),
        HAPPY_CSV,
        requestFor({schemaVersion: 'wrong' as InvoiceBatchPlanRequest['schemaVersion']}),
      ),
      'INVALID_SCHEMA_VERSION',
    )
  })

  it('refuses an invalid invoice type and a missing account code', () => {
    expectStop(
      planInvoiceBatch(
        target(),
        HAPPY_CSV,
        requestFor({invoiceType: 'ACCXYZ' as InvoiceBatchPlanRequest['invoiceType']}),
      ),
      'INVALID_INVOICE_TYPE',
    )
    expectStop(planInvoiceBatch(target(), HAPPY_CSV, requestFor({accountCode: ''})), 'INVALID_ACCOUNT_CODE')
  })
})
