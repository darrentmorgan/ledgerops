# ADR-0014: Stable operation identity and durable replay claims

**Status:** accepted · 2026-08-25
**Related:** ADR-0002, ADR-0003, ADR-0009, ADR-0011

## Context

A plan digest includes timestamps. Replanning the same business operation can therefore
produce a different digest. Durable deduplication needs a stable operation identity
independent of individual plan lifetimes. Workflow derivation and integration
belong in the operator's own code; this engine provides generic primitives.

## Decision

`deriveOperationId` hashes canonical JSON containing `tenantFingerprint`, `resource`,
`operation`, and a caller-supplied `origin`. The origin identifies the business operation;
it must not be a timestamp, retry counter, or newly generated nonce. Profile names are
not part of identity: two profiles for one organisation must not create distinct operations.
The public engine does not prescribe a workflow-specific origin schema.

`ledgerops.replay-claim.v1` is an additive signed record with `recordedAt`, `operationId`,
`planDigest`, and digest field `claimId`. Its generic schema also supplies the digest
preamble. The existing `ledgerops.write-ahead.v1` descriptor and golden digest stay
unchanged. `FileReceiptSink.writeReplayClaim` validates and durably appends the generic
claim to the same private JSONL journal as intents, receipts, and batch records.

`claimOperation` holds one exclusive lock across journal lookup and durable append:

1. Create the adjacent `.lock` file exclusively at mode `0600`, recording pid, hostname,
   operation ID, and acquisition time as diagnostics.
2. Read the journal. Malformed JSON or an unreadable journal fails closed.
3. Refuse an existing generic claim for the same operation ID with `DUPLICATE_OPERATION`,
   even when the new plan digest differs. Other journal record kinds are not claims.
4. Append and fsync the validated generic claim, then return `CLAIMED` and release the lock.

Only a successful claim permits the caller to proceed. A lookup, lock, or append failure
returns `RECEIPT_SINK_UNAVAILABLE` with `dispatchState: 'not-dispatched'`. The claim is the
real durable ownership record; there is no separate readiness probe.

A retained lock is never broken automatically. Confirm that no process owns it, inspect
its diagnostics, and check the journal for the matching generic claim before a human
removes it. A claim found after a crash remains burned: use read-back and human
reconciliation, never automatic retry. A crash before a claim append leaves no claim,
but any retained lock still requires that manual investigation.

## Integration boundary

The public primitives do not automatically wire every command or batch into replay
protection. Callers must derive a stable origin and claim before dispatch. Where provider idempotency is supported, the same stable `operationId` must be both
the local deduplication key and the Xero idempotency key; LedgerOps does not assert provider retention or replay guarantees.
Direct mutation-gate commands retain their existing per-invocation behavior.

ADR-0011's batch resume rule remains unchanged: a new manifest covers only the
not-attempted remainder, with fresh confirmation. Never auto-resume a burned operation
or an uncertain dispatch.

## Evidence

- `test/lib/ledgerops/operation-identity.test.ts`: stable generic identity derivation.
- `test/lib/ledgerops/replay-guard.test.ts`: durable claims, duplicates, retained locks,
  malformed journals, and failed appends.
- `test/lib/ledgerops/file-receipt-sink.test.ts`: generic claim validation and append-only
  persistence across sink instances.
- `test/lib/ledgerops/golden-digests.test.ts`: generic claim digest and existing record pins.

The journal remains authoritative. Any future index must be rebuildable from it and
must fail closed when unavailable or inconsistent.
