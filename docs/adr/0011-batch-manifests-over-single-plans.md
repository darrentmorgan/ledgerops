# ADR-0011: Batch manifests — one confirmation over N single plans

**Status:** accepted · 2026-08-23

**Amended by:** [ADR-0019](0019-batch-live-tenant-provenance.md): live batch command
execution uses v2 tenant provenance and a fixed-client access check after confirmation.
Historical v1/offline contracts below remain unchanged.

## Context

ADR-0008 fixed bulk work as a loop of single plans and required a dedicated ADR before
any batch design. A generic statement workflow can yield up to 50 signed DRAFT plans, each individually confirmed and
dispatched. The mechanics held — provenance via shared source-manifest hashes, per-plan
receipts, idempotent dispatch — but the confirmation cost is linear: a human (or an
approving caller) mints one confirmation per plan, which at statement scale is the slow
step and invites exactly the "small widening" pressure ADR-0008 warned about.

This record designs the widening so it is never improvised. It settles the three open
questions ADR-0008 named: partial-failure semantics, per-item STOP/UNCERTAIN handling,
and what one human confirmation over N items actually approves.

## Decision

Batches are expressed as **signed manifests over unchanged single plans**. No kernel
type gains multiplicity: plan, guard, dispatch, read-back, and receipt all remain
strictly one-resource. Multiplicity lives in exactly two new pieces — a manifest schema
and a batch executor that loops the existing kernel.

### The manifest

A `ledgerops.batch-manifest.v1` signed record enumerates the batch:

- `batchId`, `profileName`, `createdAt`/`expiresAt` (bounded like plans);
- an **ordered** list of 1 to 50 entries, each `{planId, planDigest}`, with both
  `planId`s and `planDigest`s unique across the manifest — the manifest names exact
  plan identities, never plan templates, and an empty manifest is invalid;
- the provenance the member plans share (for example, a reconciliation receipt
  identifier and source-manifest hashes), so the batch is traceable to the same sealed source
  as its members;
- a `haltPolicy` (see below), sealed into the digest;
- `manifestDigest` over the whole core, computed like every other signed record
  (ADR-0002/0005).

Nested manifests are forbidden. Mixed resources are allowed only when every member
plan binds the same tenant fingerprint (the `TARGET_TENANT_MISMATCH` rule at the manifest boundary).

### What one confirmation approves

A batch confirmation binds the `manifestDigest` — and therefore every digest-covered
field of the manifest core: the N enumerated plan digests and ids, their order, the
member count, the halt policy, `batchId`, `profileName`, the timestamps, and the
provenance block. It approves only that sealed enumeration — never "the workflow's
output", and never a count or query *alone*. Any change to any member plan changes its
digest, which changes the manifest digest, which voids the confirmation.

Before the first write-ahead record, the batch executor **preflights the complete
member set** over defensive parsed snapshots (ADR-0005): the manifest itself parses as
a signed record and is unexpired at preflight time; every supplied plan verifies as a
signed record and matches its manifest entry's `{planId, planDigest}` exactly and in
order; and the set is coherent — every member's `profileName` equals the manifest's
sealed `profileName`, all members bind one tenant fingerprint, and no member is
expired. Any preflight failure refuses the whole batch before anything dispatches.

At execute time the batch executor derives one per-item confirmation per member by
binding the batch confirmation to that member's `planDigest`; each dispatch then runs
the unchanged single-plan chain — guard, write-ahead intent, one dispatch, one
read-back, one receipt. The kernel never learns that a batch exists.

### Partial failure and per-item STOP/UNCERTAIN

Execution is sequential, in manifest order, fail-closed. Every
`MutationExecutionResult` outcome the executor can return maps to exactly one batch
member state:

- **VERIFIED**: recorded `accepted`; execution proceeds to the next member.

> **Amendment (2026-08-25, the design review):** this record used `accepted` without saying how
> strong the VERIFIED behind it is, and a blind review of the design review found the gap: a
> read-back expectation may carry a `projection` (the design review), and the kernel imposes no
> minimum on it. A caller may declare `projection: ["reference"]` and reach VERIFIED for
> an invoice whose total, contact, and line items all differ from the plan.
>
> The decision is to **scope the claim, not to floor the projection**. VERIFIED means
> *the declared projection matched, and no authority key moved* — nothing more. It is not
> an assertion that the live record equals the planned payload, except in the
> projection-absent case, where the declared fields are the whole record and the two
> coincide. A per-resource floor is rejected because this kernel is deliberately
> resource-agnostic (ADR-0007): `resource` is an opaque label, so there is no
> non-arbitrary field set to require, and encoding Xero resource semantics in the kernel
> to enforce one would trade a real architectural boundary for a guarantee the caller is
> better placed to make. The sufficiency of a projection is therefore the declaring
> caller's responsibility, and is documented as such on `createReadBackExpectation`,
> `classifyReadBack`, and `ReadBackExpectation.projection`.
>
> Two consequences for this record's mapping, both already true and now stated:
> `accepted` inherits exactly the scope of the projection that produced it, and the human
> table must not word it more strongly than that — the batch renderer's label reads
> "accepted — read back and matched what the plan checked" rather than a bare `accepted`.
> The machine `ledgerops.batch-result.v1`, `ledgerops.batch-link.v1`, and
> `ledgerops.batch-receipt.v1` bytes are untouched (ADR-0002): the wire token stays
> `accepted` and every golden digest still holds. No mechanics of this record change; the
> contract downstream consumers build on is now pinned, and pinned executably
> by `test/lib/ledgerops/readback-projection.test.ts` ("VERIFIED is scoped to the declared
> projection, never to the whole record"). Should a floor ever be wanted, it belongs to
> the caller that builds the plan — a workflow may require its own minimum projection —
> and must arrive as its own decision, failing that test first.

- **Pre-dispatch STOP** (guard refusal before any dispatch — expired plan, capability
  or scope gap, confirmation mismatch, hygiene): recorded `stopped`. The default
  `haltPolicy: "halt-on-stop"` halts the batch and all remaining members are recorded
  `not-attempted`. A manifest may opt into `continue-on-stop` at planning time only —
  the choice is sealed and confirmed, never made mid-flight, and it applies **only**
  to pre-dispatch STOPs.
- **UNCERTAIN**: always halts the batch, regardless of policy. Uncertainty is never
  looped over. Under the current contract this includes transport-thrown refusals
  (`DUPLICATE_DISPATCH`, `PAYLOAD_NOT_DRAFT`, `PAYLOAD_UNSAFE`): `executeMutation`
  maps every dispatch exception to UNCERTAIN, so they halt even under
  `continue-on-stop`. Reclassifying any of them as pre-dispatch STOPs is a kernel
  change a future implementation may propose, but until then this record adopts the
  contract as it stands.
- **Post-dispatch STOP** (dispatch accepted, read-back classified `MISMATCH`,
  `MISSING`, or `AMBIGUOUS`): recorded `dispatched-unverified` — a mutation may exist
  that the plan cannot vouch for — and always halts the batch, regardless of policy.
- There is no rollback. Under the guarded live adapter's DRAFT-only transport contract —
  the `createXeroLiveDraftTransport` allowlist retained as one selectable execution
  mechanism after ADR-0012 replaced ADR-0006's product-wide ceiling — the consequence of
  a mid-batch halt is drafts that already exist, individually receipted; a human voids
  unwanted drafts in the Xero UI.

> **Amendment (2026-08-24, the design review):** the citation above originally read "At the DRAFT
> ceiling (ADR-0006)". Correcting that superseded-policy citation — not any decision of this
> record — is an explicit deliverable of the design review and is recorded here as a documented
> exception to the append-only rule. The mechanics of this ADR are unchanged; see ADR-0013
> for the superseding execution-contract decision that authorizes it.
- Resume is a **new** manifest over the not-attempted remainder, requiring a fresh
  confirmation. Accepted members are never re-enumerated; the transport's
  digest-burn/idempotency rules (ADR-0009, the design review) continue to refuse re-dispatch of
  an accepted plan digest.

### Receipts

Per-item receipts are the existing `ledgerops.audit.v1` records, **unchanged**: that
schema's descriptor key set is exact and its golden digests are frozen, so batch
context must not be smuggled into it. The batch executor instead appends one
`ledgerops.batch-link.v1` record per member — `{batchId, manifestDigest, index,
planId, planDigest, outcome, receiptId?}` — through the same write-ahead sink
(ADR-0009) as the receipts it links.

A closing `ledgerops.batch-receipt.v1` summarizes the run — counts and per-item
`{planId, outcome, receiptId}` for `accepted`, `stopped`, `dispatched-unverified`,
`uncertain`, and `not-attempted` — and carries the same provenance block as the
manifest. It is appended through the same durable sink; if that append fails, or the
process dies before it is written, the batch's outcome is UNCERTAIN and the run is
reconstructed from what is durable — write-ahead intents, per-item receipts, and
batch-link records — before any resume manifest is built. The batch receipt attests
coverage ("every member is accounted for"), never replaces the per-item receipts.

## Consequences

- ADR-0008 is superseded **only** in its confirmation-cost rule: one confirmation may
  now cover N plans, via a manifest. Its dispatch rule stands unchanged — every item is
  still one plan, one guarded dispatch, one read-back, one receipt.
- This record specifies the architecture; the public engine implements the manifest,
  batch executor, and batch receipt. Implementation evidence lives in the corresponding
  offline tests, rather than in this decision alone.
  Stable replay identity is specified in ADR-0014; provenance remains sealed into the
  manifest and its member plans.
- Workflows keep emitting plain plan lists; building a manifest is the approving
  caller's step, so planning stays transport-free and operator-selected authority boundaries stay put.
- Any PR that adds multiplicity to plan, confirmation, guard, executor, or transport
  contracts — rather than the manifest layer described here — remains out of bounds.
