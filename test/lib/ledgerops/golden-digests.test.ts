import {describe, expect, it} from 'vitest'
import {
  confirmationDigestFor,
  confirmationTokenFor,
  createAuditReceipt,
  createBatchLink,
  createBatchManifest,
  createBatchReceipt,
  createReplayClaim,
  createMutationPlan,
  createReadBackExpectation,
  createReadReceipt,
  createTargetBinding,
  createTargetIdentity,
  createWriteAheadIntent,
  digestJson,
  executeMutation,
  InMemoryReceiptSink,
  type AuditReceipt,
  type BatchManifest,
  type ReplayClaim,
  type MutationPlan,
  type ReadBackExpectation,
  type TargetIdentityInput,
} from '../../../src/lib/ledgerops/index.js'
import {createDryRunTransport} from '../../../src/lib/ledgerops/dry-run-transport.js'

/**
 * Frozen wire contract. These digests were produced by the pre-signed-record
 * implementation; any change to canonicalization, field order, digest envelopes
 * or record shape that moves a value here is a breaking change to every plan,
 * expectation and receipt already issued. Regenerating them is never the fix.
 */
const GOLDEN = {
  expectationDigest: 'b32576e52a262238997747f5856a8623d84b68ee6ff562ce9ccd933804b3c133',
  planDigestBoundToObject: '57d74e93fb1a04e035f3ab8f6d42ce897d9d7709821df06bee44e9fade8888a3',
  planDigestWithoutObject: '3a3ec02975840ecc6f3289567458ce29a8d2fd0adffb584d7fdacecf9c685e7b',
  receiptIdWithReasonCode: '18ed3ee76c6ec3bcce7e56de8e7a1e5159672032468864c512c71b0416cb350e',
  receiptIdWithoutReasonCode: 'd3b00ce8c53579d02507a0425b3a812715b7293cc6c8cc900844f529d2a21150',
  sentinelTenantFingerprint: '0a431fd39d886360a5733bb8a15e7451c96d5aad2f1b14f44f31a034c4594b13',
  sentinelTargetFingerprint: 'e311c4056327bd2f6515c856b712d41a6827097b79fe169bc6b8019f3bb358bc',
  sentinelReceiptId: '1b3ab953acc11e2864b054478219d8ac06804eab2a9f083f5ae1c12ee875a556',
  degenerateTargetFingerprint: '112e8852173dbba29305330312f5ebf94ffb2ae97bcd57b85edb009424af5559',
  degenerateReceiptId: '7c20c8c81604c30f6ea43a9256f7e53413a545cb2a437b67054aadb36e82dfd0',
  writeAheadEntryId: '3f7d34dc9388d68fe14bec5440234c5b2081e2c06bd32fae06cdc9ed463d3d4b',
  readQueryDigest: 'afc7cfa003b472e343ad0737d0725d952961c0d7e36915895e2c67fc830fece7',
  readReceiptIdOk: '7b9ad6cedfd0d180be05e666149b9a12b1d46b13bdff16e24f70901c53fe091d',
  readReceiptIdStop: 'fb8a7cf88d61cd1ef79a1d233b3afe63e8289525c36bd95d7262086d4ae71184',
  batchManifestDigestHaltOnStop: '782fa772dcb602dab3d5f00ad3a18d3ba3c51c84d2eedb28ef5bf754f346e08d',
  batchManifestDigestContinueOnStop: '71760f7ac35e4dec1c6bf390f37e57495068c7bd037fbcf0ae44293b68a4e87f',
  batchLinkDigest: 'dfad7eba1cf46b9ae862e326773dc2157c9d3ae1359c34d4819a64020e5713b1',
  batchReceiptDigest: 'be6629a51e2b45291f9fd0e25b60d6da8314acf55206fb3046d12928d8d96bdd',
  replayClaimId: '8830b5d8d06cf52ee720f4af0c6e1fbc2fc99ad7a46a9af47a82ed9fee5f145f',
} as const

const GOLDEN_READ_RECEIPT_JSON =
  '{"schemaVersion":"ledgerops.read.v1","recordedAt":1786492801000,"profileName":"golden-profile","resource":"accounts","target":{"profileName":"golden-profile","resource":"accounts","tenantFingerprint":"5042146f6662ad5d64c99afee99593ba4a587b6c20a0a11496e2c284246fae38","targetFingerprint":"a679f35dbc7eba05f17ebd4c45dab42590f02762455b998a6b3b0f13992c9ada"},"queryDigest":"afc7cfa003b472e343ad0737d0725d952961c0d7e36915895e2c67fc830fece7","maxCalls":1,"callCount":1,"recordCount":2,"outcome":"OK","terminal":"CONTINUE","receiptId":"7b9ad6cedfd0d180be05e666149b9a12b1d46b13bdff16e24f70901c53fe091d"}'

const GOLDEN_WRITE_AHEAD_JSON =
  '{"schemaVersion":"ledgerops.write-ahead.v1","recordedAt":1786492801000,"profileName":"golden-profile","resource":"golden-resource","operation":"update","target":{"profileName":"golden-profile","resource":"golden-resource","tenantFingerprint":"5042146f6662ad5d64c99afee99593ba4a587b6c20a0a11496e2c284246fae38","objectFingerprint":"21a29161382e3851946fe2c86f0d6d0c40f53c14944b77dbada3dea1977f2df3","targetFingerprint":"26ac6124d1cc8e55dc799371f8335abc879e98dd90db53c79748ae5ea63e85b5"},"planDigest":"57d74e93fb1a04e035f3ab8f6d42ce897d9d7709821df06bee44e9fade8888a3","confirmationDigest":"04dc7abe14dc7f2ec3776389a9b13ca6137523332620a7dcbc25e64074155fed","entryId":"3f7d34dc9388d68fe14bec5440234c5b2081e2c06bd32fae06cdc9ed463d3d4b"}'

/** Full serialization, so property insertion order is pinned as well as content. */
const GOLDEN_PLAN_JSON =
  '{"schemaVersion":"ledgerops.plan.v1","planId":"golden-plan","profileName":"golden-profile","resource":"golden-resource","operation":"update","targetBinding":{"profileName":"golden-profile","resource":"golden-resource","tenantFingerprint":"5042146f6662ad5d64c99afee99593ba4a587b6c20a0a11496e2c284246fae38","objectFingerprint":"21a29161382e3851946fe2c86f0d6d0c40f53c14944b77dbada3dea1977f2df3","targetFingerprint":"26ac6124d1cc8e55dc799371f8335abc879e98dd90db53c79748ae5ea63e85b5"},"payload":{"amount":"10.01","lines":[{"code":"A","quantity":1}],"memo":null},"payloadDigest":"7b02b17b1a0218bf26e8a59d965c56bfec85ca50f929b0502187a9129330fde6","requiredCapability":"ledger.golden.write","requiredCapabilities":["ledger.golden.write"],"requiredScope":"ledger.golden.scope","requiredScopes":["ledger.golden.scope"],"capabilitiesFingerprint":"8c22f17f4bc03cd3b6fb547dcba6c472f7b56d529326bee5cdcb26d7538d2e8b","scopesFingerprint":"a2dd859b2fd2c3ed9ff0311b24e7e1bb0d867c5a37d1a8fdc5183acea599f0c8","readBackExpectation":{"schemaVersion":"ledgerops.readback.v1","resource":"golden-resource","targetBinding":{"profileName":"golden-profile","resource":"golden-resource","tenantFingerprint":"5042146f6662ad5d64c99afee99593ba4a587b6c20a0a11496e2c284246fae38","objectFingerprint":"21a29161382e3851946fe2c86f0d6d0c40f53c14944b77dbada3dea1977f2df3","targetFingerprint":"26ac6124d1cc8e55dc799371f8335abc879e98dd90db53c79748ae5ea63e85b5"},"expectedDigest":"a0df9b3ed46386a73f12c77575e7cdbd05746fd40a8badf0274683c5b735f013","maxMatches":1,"expectationDigest":"b32576e52a262238997747f5856a8623d84b68ee6ff562ce9ccd933804b3c133"},"objectCount":1,"maxObjects":1,"requiresDemoCompany":true,"createdAt":1786492800000,"expiresAt":1786493100000,"planDigest":"57d74e93fb1a04e035f3ab8f6d42ce897d9d7709821df06bee44e9fade8888a3"}'

const GOLDEN_RECEIPT_JSON =
  '{"schemaVersion":"ledgerops.audit.v1","recordedAt":1786492801000,"profileName":"golden-profile","resource":"golden-resource","operation":"update","target":{"profileName":"golden-profile","resource":"golden-resource","tenantFingerprint":"5042146f6662ad5d64c99afee99593ba4a587b6c20a0a11496e2c284246fae38","objectFingerprint":"21a29161382e3851946fe2c86f0d6d0c40f53c14944b77dbada3dea1977f2df3","targetFingerprint":"26ac6124d1cc8e55dc799371f8335abc879e98dd90db53c79748ae5ea63e85b5"},"planDigest":"57d74e93fb1a04e035f3ab8f6d42ce897d9d7709821df06bee44e9fade8888a3","confirmationDigest":"04dc7abe14dc7f2ec3776389a9b13ca6137523332620a7dcbc25e64074155fed","requiredCapabilityFingerprint":"8c22f17f4bc03cd3b6fb547dcba6c472f7b56d529326bee5cdcb26d7538d2e8b","requiredScopeFingerprint":"a2dd859b2fd2c3ed9ff0311b24e7e1bb0d867c5a37d1a8fdc5183acea599f0c8","objectCount":1,"maxObjects":1,"dispatchState":"not-dispatched","readBackClassification":"not-run","outcome":"STOP","terminal":"STOP","reasonCode":"PLAN_EXPIRED","receiptId":"18ed3ee76c6ec3bcce7e56de8e7a1e5159672032468864c512c71b0416cb350e"}'

const GOLDEN_SENTINEL_RECEIPT_JSON =
  '{"schemaVersion":"ledgerops.audit.v1","recordedAt":1786492801000,"profileName":"golden-profile","resource":"golden-resource","operation":"update","target":{"profileName":"golden-profile","resource":"golden-resource","tenantFingerprint":"0a431fd39d886360a5733bb8a15e7451c96d5aad2f1b14f44f31a034c4594b13","targetFingerprint":"e311c4056327bd2f6515c856b712d41a6827097b79fe169bc6b8019f3bb358bc"},"planDigest":"57d74e93fb1a04e035f3ab8f6d42ce897d9d7709821df06bee44e9fade8888a3","confirmationDigest":"04dc7abe14dc7f2ec3776389a9b13ca6137523332620a7dcbc25e64074155fed","requiredCapabilityFingerprint":"8c22f17f4bc03cd3b6fb547dcba6c472f7b56d529326bee5cdcb26d7538d2e8b","requiredScopeFingerprint":"a2dd859b2fd2c3ed9ff0311b24e7e1bb0d867c5a37d1a8fdc5183acea599f0c8","objectCount":1,"maxObjects":1,"dispatchState":"not-dispatched","readBackClassification":"not-run","outcome":"STOP","terminal":"STOP","reasonCode":"PLAN_TAMPERED","receiptId":"1b3ab953acc11e2864b054478219d8ac06804eab2a9f083f5ae1c12ee875a556"}'

/**
 * New schema (ADR-0011), frozen from its first release. Every field the batch
 * confirmation approves is inside these bytes: the ordered member identities,
 * the member count, the halt policy, the provenance block and the window.
 */
const GOLDEN_BATCH_MANIFEST_JSON =
  '{"schemaVersion":"ledgerops.batch-manifest.v1","batchId":"golden-batch","profileName":"golden-profile","provenance":{"sourceReceiptId":"18ed3ee76c6ec3bcce7e56de8e7a1e5159672032468864c512c71b0416cb350e","sourceManifestHashes":["afc7cfa003b472e343ad0737d0725d952961c0d7e36915895e2c67fc830fece7","b32576e52a262238997747f5856a8623d84b68ee6ff562ce9ccd933804b3c133"]},"entries":[{"planId":"golden-plan","planDigest":"57d74e93fb1a04e035f3ab8f6d42ce897d9d7709821df06bee44e9fade8888a3"},{"planId":"golden-plan-unbound","planDigest":"3a3ec02975840ecc6f3289567458ce29a8d2fd0adffb584d7fdacecf9c685e7b"}],"memberCount":2,"haltPolicy":"halt-on-stop","createdAt":1786492800000,"expiresAt":1786493100000,"manifestDigest":"782fa772dcb602dab3d5f00ad3a18d3ba3c51c84d2eedb28ef5bf754f346e08d"}'

/**
 * New schema (issue #55, ADR-0011), frozen from its first release. Every
 * batch-link record ties one manifest member's index, plan identity and
 * outcome back to `manifestDigest`; `ledgerops.audit.v1` stays untouched.
 */
const GOLDEN_BATCH_LINK_JSON =
  '{"schemaVersion":"ledgerops.batch-link.v1","batchId":"golden-batch","manifestDigest":"782fa772dcb602dab3d5f00ad3a18d3ba3c51c84d2eedb28ef5bf754f346e08d","index":0,"planId":"golden-plan","planDigest":"57d74e93fb1a04e035f3ab8f6d42ce897d9d7709821df06bee44e9fade8888a3","outcome":"accepted","receiptId":"d3b00ce8c53579d02507a0425b3a812715b7293cc6c8cc900844f529d2a21150","linkDigest":"dfad7eba1cf46b9ae862e326773dc2157c9d3ae1359c34d4819a64020e5713b1"}'

/**
 * New schema (issue #55, ADR-0011), frozen from its first release. The
 * closing batch receipt: derived per-outcome counts, per-item outcome and
 * receipt refs, and the same provenance block as the manifest it closes.
 */
const GOLDEN_BATCH_RECEIPT_JSON =
  '{"schemaVersion":"ledgerops.batch-receipt.v1","batchId":"golden-batch","manifestDigest":"782fa772dcb602dab3d5f00ad3a18d3ba3c51c84d2eedb28ef5bf754f346e08d","provenance":{"sourceReceiptId":"18ed3ee76c6ec3bcce7e56de8e7a1e5159672032468864c512c71b0416cb350e","sourceManifestHashes":["afc7cfa003b472e343ad0737d0725d952961c0d7e36915895e2c67fc830fece7","b32576e52a262238997747f5856a8623d84b68ee6ff562ce9ccd933804b3c133"]},"items":[{"planId":"golden-plan","outcome":"accepted","receiptId":"d3b00ce8c53579d02507a0425b3a812715b7293cc6c8cc900844f529d2a21150"},{"planId":"golden-plan-unbound","outcome":"not-attempted"}],"counts":{"accepted":1,"stopped":0,"dispatchedUnverified":0,"uncertain":0,"notAttempted":1},"recordedAt":1786492801000,"batchReceiptDigest":"be6629a51e2b45291f9fd0e25b60d6da8314acf55206fb3046d12928d8d96bdd"}'

/**
 * Generic replay schema, frozen independently from earlier record kinds.
 * The write-ahead append of this record IS the replay claim; the
 * durable bytes are the whole safety property, so they are frozen exactly
 * like every other golden constant. Regenerating them is never the fix.
 */
const GOLDEN_REPLAY_CLAIM_JSON =
  '{"schemaVersion":"ledgerops.replay-claim.v1","recordedAt":1786492801000,"operationId":"afc7cfa003b472e343ad0737d0725d952961c0d7e36915895e2c67fc830fece7","planDigest":"57d74e93fb1a04e035f3ab8f6d42ce897d9d7709821df06bee44e9fade8888a3","claimId":"8830b5d8d06cf52ee720f4af0c6e1fbc2fc99ad7a46a9af47a82ed9fee5f145f"}'

const CREATED_AT = Date.parse('2026-08-12T00:00:00.000Z')
const EXPIRES_AT = CREATED_AT + 300_000
const RECORDED_AT = CREATED_AT + 1_000

const PROFILE = 'golden-profile'
const RESOURCE = 'golden-resource'
const CAPABILITY = 'ledger.golden.write'
const SCOPE = 'ledger.golden.scope'
const PAYLOAD = {amount: '10.01', lines: [{code: 'A', quantity: 1}], memo: null}
const EXPECTED = {amount: '10.01', status: 'DRAFT'}

const TARGET_WITH_OBJECT: TargetIdentityInput = {
  profileName: PROFILE,
  tenantId: 'golden-tenant',
  resource: RESOURCE,
  objectId: 'golden-object',
  isDemoCompany: true,
  observedAt: CREATED_AT,
  freshUntil: EXPIRES_AT,
  capabilities: [CAPABILITY],
  scopes: [SCOPE],
}

const TARGET_WITHOUT_OBJECT: TargetIdentityInput = {
  profileName: PROFILE,
  tenantId: 'golden-tenant',
  resource: RESOURCE,
  isDemoCompany: true,
  observedAt: CREATED_AT,
  freshUntil: EXPIRES_AT,
  capabilities: [CAPABILITY],
  scopes: [SCOPE],
}

function goldenExpectation(): ReadBackExpectation {
  return createReadBackExpectation({resource: RESOURCE, target: TARGET_WITH_OBJECT, expected: EXPECTED})
}

function goldenPlan(): MutationPlan {
  return createMutationPlan({
    planId: 'golden-plan',
    profileName: PROFILE,
    resource: RESOURCE,
    operation: 'update',
    target: TARGET_WITH_OBJECT,
    payload: PAYLOAD,
    requiredCapabilities: [CAPABILITY],
    requiredScopes: [SCOPE],
    readBackExpectation: goldenExpectation(),
    createdAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
  })
}

function goldenPlanWithoutObject(): MutationPlan {
  return createMutationPlan({
    planId: 'golden-plan-unbound',
    profileName: PROFILE,
    resource: RESOURCE,
    operation: 'create',
    target: TARGET_WITHOUT_OBJECT,
    payload: PAYLOAD,
    requiredCapabilities: [CAPABILITY],
    requiredScopes: [SCOPE],
    readBack: {expected: EXPECTED},
    createdAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
  })
}

function goldenReceipt(reasonCode?: 'PLAN_EXPIRED'): AuditReceipt {
  const plan = goldenPlan()
  return createAuditReceipt({
    recordedAt: RECORDED_AT,
    profileName: PROFILE,
    resource: RESOURCE,
    operation: 'update',
    target: createTargetBinding(TARGET_WITH_OBJECT),
    planDigest: plan.planDigest,
    confirmationDigest: confirmationDigestFor(confirmationTokenFor(plan)),
    requiredCapabilityFingerprint: plan.capabilitiesFingerprint,
    requiredScopeFingerprint: plan.scopesFingerprint,
    dispatchState: 'not-dispatched',
    readBackClassification: 'not-run',
    outcome: 'STOP',
    terminal: 'STOP',
    ...(reasonCode === undefined ? {} : {reasonCode}),
  })
}

function goldenBatchManifest(haltPolicy?: 'continue-on-stop'): BatchManifest {
  return createBatchManifest({
    batchId: 'golden-batch',
    profileName: PROFILE,
    // The member identities are the frozen golden plans, so a manifest golden
    // also breaks if a member plan's digest ever moves.
    entries: [
      {planId: 'golden-plan', planDigest: goldenPlan().planDigest},
      {planId: 'golden-plan-unbound', planDigest: goldenPlanWithoutObject().planDigest},
    ],
    provenance: {
      sourceReceiptId: GOLDEN.receiptIdWithReasonCode,
      sourceManifestHashes: [GOLDEN.readQueryDigest, GOLDEN.expectationDigest],
    },
    ...(haltPolicy === undefined ? {} : {haltPolicy}),
    createdAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
  })
}

function goldenBatchLink(): ReturnType<typeof createBatchLink> {
  return createBatchLink({
    batchId: 'golden-batch',
    manifestDigest: GOLDEN.batchManifestDigestHaltOnStop,
    index: 0,
    planId: 'golden-plan',
    planDigest: GOLDEN.planDigestBoundToObject,
    outcome: 'accepted',
    receiptId: GOLDEN.receiptIdWithoutReasonCode,
  })
}

function goldenBatchReceipt(): ReturnType<typeof createBatchReceipt> {
  return createBatchReceipt({
    batchId: 'golden-batch',
    manifestDigest: GOLDEN.batchManifestDigestHaltOnStop,
    provenance: {
      sourceReceiptId: GOLDEN.receiptIdWithReasonCode,
      sourceManifestHashes: [GOLDEN.readQueryDigest, GOLDEN.expectationDigest],
    },
    items: [
      {planId: 'golden-plan', outcome: 'accepted', receiptId: GOLDEN.receiptIdWithoutReasonCode},
      {planId: 'golden-plan-unbound', outcome: 'not-attempted'},
    ],
    recordedAt: RECORDED_AT,
  })
}

function goldenReplayClaim(): ReplayClaim {
  return createReplayClaim({
    recordedAt: RECORDED_AT,
    operationId: GOLDEN.readQueryDigest,
    planDigest: GOLDEN.planDigestBoundToObject,
  })
}

describe('golden record digests', () => {
  it('reproduces the read-back expectation digest', () => {
    expect(goldenExpectation().expectationDigest).toBe(GOLDEN.expectationDigest)
  })

  it('reproduces the plan digest for a binding with an object fingerprint', () => {
    expect(goldenPlan().planDigest).toBe(GOLDEN.planDigestBoundToObject)
  })

  it('reproduces the plan digest for a binding without an object fingerprint', () => {
    expect(goldenPlanWithoutObject().planDigest).toBe(GOLDEN.planDigestWithoutObject)
  })

  it('reproduces the receipt id with a reason code', () => {
    expect(goldenReceipt('PLAN_EXPIRED').receiptId).toBe(GOLDEN.receiptIdWithReasonCode)
  })

  it('reproduces the receipt id without a reason code', () => {
    expect(goldenReceipt().receiptId).toBe(GOLDEN.receiptIdWithoutReasonCode)
  })

  it('keeps plan property order byte-identical', () => {
    expect(JSON.stringify(goldenPlan())).toBe(GOLDEN_PLAN_JSON)
  })

  it('keeps receipt property order byte-identical', () => {
    expect(JSON.stringify(goldenReceipt('PLAN_EXPIRED'))).toBe(GOLDEN_RECEIPT_JSON)
  })

  it('reproduces the write-ahead intent entry id and byte order', () => {
    const plan = goldenPlan()
    const intent = createWriteAheadIntent({
      recordedAt: RECORDED_AT,
      profileName: PROFILE,
      resource: RESOURCE,
      operation: 'update',
      target: plan.targetBinding,
      planDigest: plan.planDigest,
      confirmationDigest: confirmationDigestFor(confirmationTokenFor(plan)),
    })
    expect(intent.entryId).toBe(GOLDEN.writeAheadEntryId)
    expect(JSON.stringify(intent)).toBe(GOLDEN_WRITE_AHEAD_JSON)
  })

  it('reproduces the read receipt ids and byte order', () => {
    const target = createTargetBinding({
      profileName: PROFILE,
      tenantId: 'golden-tenant',
      resource: 'accounts',
      isDemoCompany: false,
      observedAt: CREATED_AT,
      freshUntil: EXPIRES_AT,
    })
    const queryDigest = digestJson({kind: 'ledgerops.read-query.v1', resource: 'accounts', query: {}})
    expect(queryDigest).toBe(GOLDEN.readQueryDigest)

    const ok = createReadReceipt({
      recordedAt: RECORDED_AT,
      profileName: PROFILE,
      resource: 'accounts',
      target,
      queryDigest,
      maxCalls: 1,
      callCount: 1,
      recordCount: 2,
      outcome: 'OK',
      terminal: 'CONTINUE',
    })
    expect(ok.receiptId).toBe(GOLDEN.readReceiptIdOk)
    expect(JSON.stringify(ok)).toBe(GOLDEN_READ_RECEIPT_JSON)

    const stop = createReadReceipt({
      recordedAt: RECORDED_AT,
      profileName: PROFILE,
      resource: 'accounts',
      target,
      queryDigest,
      maxCalls: 1,
      callCount: 1,
      recordCount: 0,
      outcome: 'STOP',
      terminal: 'STOP',
      reasonCode: 'OUTPUT_UNSAFE',
    })
    expect(stop.receiptId).toBe(GOLDEN.readReceiptIdStop)
  })

  it('reproduces the batch manifest digest and byte order', () => {
    const record = goldenBatchManifest()
    expect(record.manifestDigest).toBe(GOLDEN.batchManifestDigestHaltOnStop)
    expect(JSON.stringify(record)).toBe(GOLDEN_BATCH_MANIFEST_JSON)
  })

  it('reproduces a distinct batch manifest digest for the continue-on-stop policy', () => {
    expect(goldenBatchManifest('continue-on-stop').manifestDigest).toBe(GOLDEN.batchManifestDigestContinueOnStop)
  })

  it('reproduces the batch link digest and byte order', () => {
    const record = goldenBatchLink()
    expect(record.linkDigest).toBe(GOLDEN.batchLinkDigest)
    expect(JSON.stringify(record)).toBe(GOLDEN_BATCH_LINK_JSON)
  })

  it('reproduces the batch receipt digest and byte order', () => {
    const record = goldenBatchReceipt()
    expect(record.batchReceiptDigest).toBe(GOLDEN.batchReceiptDigest)
    expect(JSON.stringify(record)).toBe(GOLDEN_BATCH_RECEIPT_JSON)
  })

  it('reproduces the replay claim id and byte order', () => {
    const record = goldenReplayClaim()
    expect(record.claimId).toBe(GOLDEN.replayClaimId)
    expect(JSON.stringify(record)).toBe(GOLDEN_REPLAY_CLAIM_JSON)
  })
})

describe('golden sentinel digests', () => {
  /**
   * The executor's safeTarget fallback fabricates a sentinel binding from the
   * ledgerops.invalid-target.* vocabulary when the plan's own binding is
   * broken. Those digests are receipt content, so they are frozen exactly like
   * every other golden constant. Regenerating them is never the fix.
   */
  it('reproduces the invalid-target sentinel receipt byte-for-byte', async () => {
    const identity = createTargetIdentity(TARGET_WITH_OBJECT)
    const plan = goldenPlan()
    const tampered = {...plan, targetBinding: {}} as unknown as MutationPlan
    const sink = new InMemoryReceiptSink()

    const result = await executeMutation({
      request: {
        profileName: PROFILE,
        resource: RESOURCE,
        operation: 'update',
        payload: PAYLOAD,
        objectCount: 1,
        readBackExpectation: plan.readBackExpectation,
      },
      plan: tampered,
      confirmation: confirmationTokenFor(plan),
      context: {profileName: PROFILE, identity, receiptSink: sink, now: RECORDED_AT},
      transport: createDryRunTransport(identity),
      now: RECORDED_AT,
    })

    expect(result.outcome).toBe('STOP')
    expect(result.dispatchState).toBe('not-dispatched')
    expect(result.receipt.reasonCode).toBe('PLAN_TAMPERED')
    expect(result.receipt.target).toEqual({
      profileName: PROFILE,
      resource: RESOURCE,
      tenantFingerprint: GOLDEN.sentinelTenantFingerprint,
      targetFingerprint: GOLDEN.sentinelTargetFingerprint,
    })
    expect(result.receipt.receiptId).toBe(GOLDEN.sentinelReceiptId)
    expect(JSON.stringify(result.receipt)).toBe(GOLDEN_SENTINEL_RECEIPT_JSON)
  })

  it('reproduces the unknown-* fallback labels when the plan carries no usable names', async () => {
    const identity = createTargetIdentity(TARGET_WITH_OBJECT)
    const plan = goldenPlan()
    const tampered = {
      ...plan,
      profileName: '',
      resource: '',
      operation: '',
      targetBinding: {},
    } as unknown as MutationPlan
    const sink = new InMemoryReceiptSink()

    const result = await executeMutation({
      request: {
        profileName: PROFILE,
        resource: RESOURCE,
        operation: 'update',
        payload: PAYLOAD,
        objectCount: 1,
        readBackExpectation: plan.readBackExpectation,
      },
      plan: tampered,
      confirmation: confirmationTokenFor(plan),
      context: {profileName: PROFILE, identity, receiptSink: sink, now: RECORDED_AT},
      transport: createDryRunTransport(identity),
      now: RECORDED_AT,
    })

    expect(result.outcome).toBe('STOP')
    expect(result.receipt.reasonCode).toBe('PROFILE_MISMATCH')
    expect(result.receipt.profileName).toBe('unknown-profile')
    expect(result.receipt.resource).toBe('unknown-resource')
    expect(result.receipt.operation).toBe('unknown-operation')
    expect(result.receipt.target).toEqual({
      profileName: 'unknown-profile',
      resource: 'unknown-resource',
      tenantFingerprint: GOLDEN.sentinelTenantFingerprint,
      targetFingerprint: GOLDEN.degenerateTargetFingerprint,
    })
    expect(result.receipt.receiptId).toBe(GOLDEN.degenerateReceiptId)
  })
})
