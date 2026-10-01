# ADR-0010: Bounded READ contract and the live read adapter

**Status:** accepted · 2026-08-23

## Context

The kernel's mutation chain (plan → confirmation → guard → one dispatch →
receipt) is deliberately heavyweight. Bounded kernel reads are identity-bound,
allowlisted, call-bounded, and receipted, and cross the same redacted transport
seam as mutations (ADR-0003). Direct read commands remain supported separately
under ADR-0012; this record defines the optional bounded kernel contract.

## Decision

- `executeRead(request, context, transport)` in `read.ts` is the bounded kernel read
  path. There is no plan, confirmation, or executor chain; instead every
  execution enforces, in order: a verified (`IDENTITY_INVALID`) and fresh
  (`IDENTITY_STALE`) target identity matching the requested profile and
  resource exactly; membership of `READ_RESOURCES`, the read allowlist; the
  resource's kernel capability (`read.<resource>`); its Xero scope groups —
  each group lists the least-privilege `.read` scope first and accepts the
  write-capable scope because at Xero it grants the same read; a transport
  call bound `maxCalls` (default 1, hard ceiling 10); and a query that is
  canonical JSON free of secret-shaped data.
- The read half of the ADR-0003 seam is `ReadTransport`: constructed bound to
  one target, publishes its binding (re-checked by the kernel before the first
  call), throws on any internal mismatch, and returns only plain-JSON record
  pages. The kernel hygiene-checks and canonically clones every record; one
  unsafe record withholds the entire result (`OUTPUT_UNSAFE`).
- Every post-guard execution ends in a `ledgerops.read.v1` signed record
  (descriptor-driven per ADR-0002; digest field `receiptId`; invariants pin
  the target/profile/resource match, allowlist membership, call bounds, and
  outcome/terminal coherence) persisted through `writeRead` before any record
  is released. A failed receipt write is terminal (`RECEIPT_WRITE_FAILED`):
  no records, and the unpersisted receipt does not circulate. Guard-phase
  STOPs return no receipt — no verified binding exists to attest to and no
  transport call was made.
- `createXeroLiveReadTransport(identity, deps)` in `xero-live-read.ts` is the
  live Tier 0 adapter, mirroring the `xero-live-identity` dependency-injected
  shape: config/token presence, decryption, expiry safety window, and a token
  tenant that must equal the bound tenant. Each resource maps to one
  read-only SDK call with an exact query-key schema — a key the fetcher would
  ignore is rejected (`QUERY_INVALID`), because the receipt signs the query.
  An absent record collection is `RESPONSE_INVALID`, never a successful empty
  read. Fetchers answer one page per execution; pagination advances via
  explicit query parameters across separate receipted reads.
- Only the two live adapters may import `xero-node` inside the kernel;
  workflows and the contract never touch the SDK (regression-tested).

## Consequences

- Tier 0 reads carry the same audit spine as mutations — a durable JSONL line
  per execution in the ADR-0009 store — without diluting the mutation chain.
- The allowlist is the unit of growth: adding a resource means one
  `READ_RESOURCES` entry, one fetcher with a query schema, and its scope
  group. Journals joined in the reporting-reads milestone; the gated
  `accounting.journals.read` scope stays a `--scope` opt-in for eligible
  (Advanced-tier, certified) app registrations rather than a login default.
- A receipt consumer can trust that any verifying `ledgerops.read.v1` record
  names an allowlisted resource and a target the read was actually bound to.
