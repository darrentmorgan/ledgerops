import {digestJson} from './canonical.js'
import {getCachedTokenSet} from '../auth.js'
import {parseBatchManifest} from './batch-manifest.js'
import {resolveLiveClient, type XeroLiveSessionDependencies} from './xero-live-session.js'
import type {BatchManifest, TargetIdentity} from './types.js'
import {createLiveDraftClient, type XeroLiveDraftClient} from './xero-live-draft.js'

interface BatchLiveClient extends XeroLiveDraftClient {
  updateTenants(full?: boolean): Promise<unknown>
  readonly accountingApi: XeroLiveDraftClient['accountingApi'] & {
    getOrganisations(tenantId: string): Promise<unknown>
  }
}

export function requireBatchTenant(manifest: BatchManifest, tenantId: unknown): void {
  const parsed = parseBatchManifest(manifest)
  if (parsed?.schemaVersion !== 'ledgerops.batch-manifest.v2' || !parsed.tenantFingerprint) {
    throw new Error('BATCH_PROVENANCE_REQUIRED')
  }
  if (
    typeof tenantId !== 'string' ||
    !tenantId.trim() ||
    parsed.tenantFingerprint !== digestJson({kind: 'ledgerops.tenant.v1', tenantId})
  ) {
    throw new Error('BATCH_PROVENANCE_MISMATCH')
  }
}

/** Execute-only seam: one fixed client, no retry, no sink, no mutation. */
export async function observeBatchTarget(
  manifest: BatchManifest,
  identity: TargetIdentity,
  credentials: {profileName: string; clientId: string},
  dependencies: XeroLiveSessionDependencies<BatchLiveClient> = {},
): Promise<BatchLiveClient> {
  // Legacy or mismatched planning evidence refuses before credential/API access.
  requireBatchTenant(manifest, identity.tenantId)
  try {
    // The profile token records the selected tenant independently of the manifest.
    // Capture that same token read used to authenticate this fixed client.
    let selectedTenant: string | undefined
    const readTokenSet =
      dependencies.readTokenSet ?? ((profileName: string) => getCachedTokenSet(profileName, credentials.clientId))
    const client = await resolveLiveClient({
      profileName: credentials.profileName,
      tenantId: identity.tenantId,
      dependencies: {
        ...dependencies,
        readClientId: () => credentials.clientId,
        readTokenSet: async profileName => {
          const token = await readTokenSet(profileName)
          selectedTenant = token?.tenantId
          return token
        },
      },
      createDefaultClient: clientId => createLiveDraftClient(clientId) as BatchLiveClient,
    })
    const connections = await client.updateTenants(false)
    if (!Array.isArray(connections) || !selectedTenant) throw new Error('missing selected tenant')
    const selected = connections.filter(connection => connection?.tenantId === selectedTenant)
    if (selected.length !== 1) throw new Error('missing or ambiguous selected connection')
    const tenantId = selected[0].tenantId
    requireBatchTenant(manifest, tenantId)
    const response = await client.accountingApi.getOrganisations(tenantId)
    const organisations = (response as {body?: {organisations?: unknown}})?.body?.organisations
    if (
      !Array.isArray(organisations) ||
      organisations.length !== 1 ||
      !organisations[0] ||
      typeof organisations[0] !== 'object' ||
      Array.isArray(organisations[0]) ||
      Object.keys(organisations[0]).length === 0
    )
      throw new Error('invalid organisation response')
    // OrganisationID is not tenant identity. This read proves access/liveness only.
    return client
  } catch {
    // Provider messages and identifiers never escape this boundary.
    throw new Error('BATCH_PROVENANCE_UNVERIFIED')
  }
}
