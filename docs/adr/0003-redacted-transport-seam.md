# ADR-0003: Redacted transport seam

**Status:** accepted · 2026-08-13

## Context

The kernel spends its whole pipeline turning a target into fingerprints — a binding carries a
tenant fingerprint precisely so a raw tenant identifier never reaches a plan, a confirmation or
a receipt — and then handed the full `TargetIdentity`, the caller's `MutationRequest` and the
signed plan to the transport on every dispatch and every read-back. The single value the
adapter needed to act, the payload, arrived four times over, wrapped in the one thing the
redaction exists to withhold. An adapter with a network connection could authenticate as the
tenant the executor was merely describing to it.

The seam was also shaped by its only implementation. `InMemorySyntheticTransport` was a class
with six helper methods that nothing called, a dispatch identifier nothing read, and no notion
of which target it belonged to: one instance would accept a dispatch for any binding at all and
answer read-backs from the same map. A synthetic double wearing production clothes is a poor
description of the contract a real Xero write adapter will have to meet, and nothing in the port
said what an adapter owed the kernel.

## Decision

The port states what crosses it and what an adapter owes the kernel, and nothing more:

- The crossing sets are redacted and minimal. Dispatch takes `operation`, `payload`,
  `targetBinding` and `planDigest`; read-back takes `targetBinding` and `planDigest`. An adapter
  is told what to write, never who to write it as. Read-back still returns raw records, because
  classifying them against the plan's expectation is kernel work.
- The fingerprint is the authorization. A binding names a target without naming the tenant, so
  the redacted form is sufficient to act on, not merely sufficient to log.
- An adapter is constructed bound to exactly one target and publishes it as `binding`. The
  executor structurally validates that binding and compares it field-for-field to the guard's
  before it dispatches; a mismatch is a pre-dispatch `STOP` with reason code
  `TRANSPORT_BINDING_MISMATCH` and nothing is sent.
- On any internal binding or credential mismatch an adapter throws. Returning
  `{accepted: false}` would claim the remote answered and rejected, which is a different fact
  about the world.
- `dispatchId` is gone. The kernel could not verify it, nothing read it, and a value the kernel
  cannot check does not belong in a fail-closed contract.
- `dry-run-transport.ts` replaces the synthetic class: a factory, roughly forty lines, storing
  payloads by plan digest so one instance stays correct under interleaved executions. It is not
  exported from the kernel barrel — the barrel is kernel vocabulary and an adapter is not.

## Consequences

- `TRANSPORT_BINDING_MISMATCH` is an executor-level reason code, not a `GuardFailureCode`. The
  guard evaluates a request against an identity and knows nothing about adapters; the check
  belongs to the executor, which is what holds one.
- The kernel and the adapter both check the binding. As with `guard.ts` and `executor.ts`, the
  duplication is deliberate: the seam should not depend on one side being correct.
- The seam has one implementation, so it is still a design assertion rather than a proven
  abstraction. The Xero write adapter — constructed bound to one target, holding real
  credentials — is the second implementation that will make it real, and the first place the
  throw-on-mismatch rule protects something.
- No digested record shape changed; the golden digests are untouched.
- Declined surface, each additive later if a caller appears: an `admitBinding` port method for
  adapters that discover their target rather than receiving it, and any locator round-trip that
  would let an adapter hand back a remote identifier for the read-back to use.
