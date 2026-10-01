import {describe, expect, it, vi} from 'vitest'
import {
  createBatchManifest,
  bindBatchManifestTenant,
  parseBatchManifest,
} from '../../../src/lib/ledgerops/batch-manifest.js'
import {observeBatchTarget, requireBatchTenant} from '../../../src/lib/ledgerops/batch-live-provenance.js'
import {createTargetIdentity, createTargetBinding} from '../../../src/lib/ledgerops/identity.js'
import {createXeroLiveDraftTransport} from '../../../src/lib/ledgerops/xero-live-draft.js'
const now = Date.now()
const tenant = 'synthetic-tenant'
const identity = createTargetIdentity({
  profileName: 'synthetic-profile',
  tenantId: tenant,
  resource: 'invoices',
  isDemoCompany: true,
  observedAt: now,
  freshUntil: now + 60000,
})
const legacy = createBatchManifest({
  profileName: identity.profileName,
  entries: [{planId: 'synthetic-plan', planDigest: 'a'.repeat(64)}],
  provenance: {sourceReceiptId: 'b'.repeat(64), sourceManifestHashes: ['c'.repeat(64)]},
  createdAt: now,
})
const manifest = bindBatchManifestTenant(legacy, createTargetBinding(identity).tenantFingerprint)
function fixture() {
  const client = {
    setTokenSet: vi.fn(),
    updateTenants: vi.fn(async (): Promise<unknown> => [{tenantId: tenant}]),
    accountingApi: {
      getOrganisations: vi.fn(
        async (): Promise<unknown> => ({body: {organisations: [{organisationID: 'distinct-synthetic-organisation'}]}}),
      ),
      createInvoices: vi.fn(async () => ({body: {invoices: [{invoiceID: 'synthetic-invoice', status: 'DRAFT'}]}})),
      getInvoice: vi.fn(async () => ({body: {invoices: [{invoiceID: 'synthetic-invoice', status: 'DRAFT'}]}})),
      createManualJournals: vi.fn(),
      getManualJournal: vi.fn(),
    },
  }
  const deps = {
    fileExists: () => true,
    readTokenSet: vi.fn(async () => ({accessToken: 'synthetic-token', tenantId: tenant, expiresAt: now + 600000})),
    createClient: vi.fn(() => client),
    readClientId: vi.fn(() => {
      throw Error('must not re-resolve profile')
    }),
    now: () => now,
  }
  return {client, deps}
}
const credentials = {profileName: identity.profileName, clientId: 'synthetic-client'}
describe('batch execute provenance', () => {
  it('seals tenant only and preserves historical v1; rejects v1 execution without lookup', async () => {
    expect(legacy.schemaVersion).toBe('ledgerops.batch-manifest.v1')
    expect(manifest.schemaVersion).toBe('ledgerops.batch-manifest.v2')
    expect(manifest.manifestDigest).not.toBe(legacy.manifestDigest)
    expect(parseBatchManifest({...manifest, tenantFingerprint: 'd'.repeat(64)})).toBeUndefined()
    const {deps} = fixture()
    await expect(observeBatchTarget(legacy, identity, credentials, deps)).rejects.toThrow('BATCH_PROVENANCE_REQUIRED')
    expect(deps.readTokenSet).not.toHaveBeenCalled()
  })
  it('ignores OrganisationID equality and reuses exact client for observation, mutation and readback', async () => {
    const {client, deps} = fixture()
    const bound = await observeBatchTarget(manifest, identity, credentials, deps)
    expect(bound).toBe(client)
    expect(client.updateTenants).toHaveBeenCalledExactlyOnceWith(false)
    expect(client.accountingApi.getOrganisations).toHaveBeenCalledExactlyOnceWith(tenant)
    deps.readTokenSet.mockRejectedValue(Error('rotated token must not be read'))
    const transport = createXeroLiveDraftTransport(identity, {boundClient: bound, readTokenSet: deps.readTokenSet})
    const request = {
      operation: 'create',
      resource: 'invoices',
      payload: {status: 'DRAFT'},
      targetBinding: createTargetBinding(identity),
      planDigest: 'a'.repeat(64),
    }
    await transport.dispatch(request)
    await transport.readBack(request)
    expect(deps.readTokenSet).toHaveBeenCalledTimes(1)
    expect(deps.createClient).toHaveBeenCalledExactlyOnceWith(credentials.clientId)
    expect(deps.readClientId).not.toHaveBeenCalled()
    expect(client.accountingApi.createInvoices).toHaveBeenCalledTimes(1)
    expect(client.accountingApi.getInvoice).toHaveBeenCalledTimes(1)
  })
  it('tenant comparison ignores profile labels and refreshed timestamps', () => {
    const refreshed = createTargetIdentity({
      ...identity,
      profileName: 'synthetic-alias',
      observedAt: now + 1,
      freshUntil: now + 100000,
    })
    const bound = bindBatchManifestTenant(legacy, createTargetBinding(refreshed).tenantFingerprint)
    expect(bound.tenantFingerprint).toBe(manifest.tenantFingerprint)
    expect(() => requireBatchTenant(bound, tenant)).not.toThrow()
  })
  it.each([[], [{tenantId: tenant}, {tenantId: tenant}], [{}], [{tenantId: 'synthetic-other'}], null])(
    'refuses missing/ambiguous/mismatched connections %# before org read or mutation',
    async connections => {
      const {client, deps} = fixture()
      client.updateTenants.mockResolvedValue(connections)
      await expect(observeBatchTarget(manifest, identity, credentials, deps)).rejects.toThrow(
        'BATCH_PROVENANCE_UNVERIFIED',
      )
      expect(client.accountingApi.getOrganisations).not.toHaveBeenCalled()
      expect(client.accountingApi.createInvoices).not.toHaveBeenCalled()
    },
  )
  it.each([
    null,
    {body: {organisations: []}},
    {body: {organisations: [{}, {}]}},
    {body: {organisations: [null]}},
    {body: {organisations: [{}]}},
  ])('refuses malformed org access evidence %#', async response => {
    const {client, deps} = fixture()
    client.accountingApi.getOrganisations.mockResolvedValue(response)
    await expect(observeBatchTarget(manifest, identity, credentials, deps)).rejects.toThrow(
      'BATCH_PROVENANCE_UNVERIFIED',
    )
    expect(client.accountingApi.createInvoices).not.toHaveBeenCalled()
  })
  it('sanitises read failures and never retries', async () => {
    const {client, deps} = fixture()
    client.accountingApi.getOrganisations.mockRejectedValue(Error('private-provider-detail'))
    await expect(observeBatchTarget(manifest, identity, credentials, deps)).rejects.toThrow(
      /^BATCH_PROVENANCE_UNVERIFIED$/,
    )
    expect(client.accountingApi.getOrganisations).toHaveBeenCalledTimes(1)
    expect(client.accountingApi.createInvoices).not.toHaveBeenCalled()
  })
})

it('selects the profile tenant among multiple connections without using their order', async () => {
  for (const connections of [
    [{tenantId: 'synthetic-other'}, {tenantId: tenant}],
    [{tenantId: tenant}, {tenantId: 'synthetic-other'}],
  ]) {
    const {client, deps} = fixture()
    client.updateTenants.mockResolvedValue(connections)
    expect(await observeBatchTarget(manifest, identity, credentials, deps)).toBe(client)
    expect(client.accountingApi.getOrganisations).toHaveBeenCalledExactlyOnceWith(tenant)
    expect(deps.readTokenSet).toHaveBeenCalledTimes(1)
  }
})
it('refuses selected-profile drift even when the expected tenant remains connected', async () => {
  const {client, deps} = fixture()
  deps.readTokenSet.mockResolvedValue({
    accessToken: 'synthetic-token',
    tenantId: 'synthetic-drift',
    expiresAt: now + 600000,
  })
  client.updateTenants.mockResolvedValue([{tenantId: tenant}, {tenantId: 'synthetic-drift'}])
  await expect(observeBatchTarget(manifest, identity, credentials, deps)).rejects.toThrow('BATCH_PROVENANCE_UNVERIFIED')
  expect(client.updateTenants).not.toHaveBeenCalled()
  expect(client.accountingApi.getOrganisations).not.toHaveBeenCalled()
  expect(client.accountingApi.createInvoices).not.toHaveBeenCalled()
})
it('cannot use expected provenance to select a different connected tenant', async () => {
  const {client, deps} = fixture()
  const otherIdentity = createTargetIdentity({...identity, tenantId: 'synthetic-other'})
  const otherManifest = bindBatchManifestTenant(legacy, createTargetBinding(otherIdentity).tenantFingerprint)
  client.updateTenants.mockResolvedValue([{tenantId: tenant}, {tenantId: 'synthetic-other'}])
  await expect(observeBatchTarget(otherManifest, otherIdentity, credentials, deps)).rejects.toThrow(
    'BATCH_PROVENANCE_UNVERIFIED',
  )
  expect(client.accountingApi.getOrganisations).not.toHaveBeenCalled()
})
