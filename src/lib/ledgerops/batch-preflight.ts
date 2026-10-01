import {isBatchManifestUnexpired, parseBatchManifest} from './batch-manifest.js'
import {isPlanUnexpired, parseMutationPlan} from './plan.js'
import type {BatchPreflightDecision, BatchPreflightFailureCode} from './types.js'

/**
 * ADR-0011: before the first write-ahead record, the batch executor preflights
 * the complete member set over defensive parsed snapshots — the manifest
 * itself parses as a signed record and is unexpired, every supplied plan
 * verifies and matches its manifest entry's `{planId, planDigest}` exactly and
 * in order, every member's `profileName` equals the manifest's sealed
 * `profileName`, all members bind one tenant fingerprint, and no member is
 * expired. Any failure refuses the whole batch before anything dispatches.
 *
 * This function takes no receipt sink and no transport: it cannot write or
 * dispatch by construction. `plans` must be supplied aligned to
 * `manifest.entries` by index — a reordering is caught as a planId mismatch
 * at the first misaligned index, since the sealed member order is significant.
 */
export interface BatchPreflightInput {
  readonly manifest: unknown
  /** Raw plan records, aligned to `manifest.entries` by index. */
  readonly plans: readonly unknown[]
  readonly now?: number
}

export function preflightBatch(input: BatchPreflightInput): BatchPreflightDecision {
  if (!isObjectRecord(input) || !Array.isArray(input.plans)) {
    return failure('MANIFEST_INVALID')
  }
  const now = input.now ?? Date.now()

  const manifest = parseBatchManifest(input.manifest)
  if (!manifest) return failure('MANIFEST_INVALID')
  if (!isBatchManifestUnexpired(manifest, now)) return failure('MANIFEST_EXPIRED')

  if (input.plans.length !== manifest.entries.length) return failure('MEMBER_COUNT_MISMATCH')

  const plans = []
  let tenantFingerprint: string | undefined

  for (let index = 0; index < manifest.entries.length; index += 1) {
    const entry = manifest.entries[index]
    const plan = parseMutationPlan(input.plans[index])
    if (!plan) return failure('PLAN_INVALID', index)

    // Exact-byte, fail-closed: the manifest entry seals planId verbatim
    // (never trimmed), unlike the plan itself, which is trimmed at creation.
    // Never normalize either side before comparing.
    if (plan.planId !== entry.planId) return failure('PLAN_ID_MISMATCH', index)
    if (plan.planDigest !== entry.planDigest) return failure('PLAN_DIGEST_MISMATCH', index)
    if (plan.profileName !== manifest.profileName) return failure('PROFILE_MISMATCH', index)

    if (tenantFingerprint === undefined) {
      tenantFingerprint = plan.targetBinding.tenantFingerprint
    } else if (plan.targetBinding.tenantFingerprint !== tenantFingerprint) {
      return failure('TENANT_MISMATCH', index)
    }

    if (!isPlanUnexpired(plan, now)) return failure('PLAN_EXPIRED', index)

    plans.push(plan)
  }

  return {ok: true, manifest, plans: Object.freeze(plans)}
}

function failure(code: BatchPreflightFailureCode, index?: number): BatchPreflightDecision {
  return index === undefined ? {ok: false, code} : {ok: false, code, index}
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
