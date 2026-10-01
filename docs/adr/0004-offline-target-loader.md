# ADR-0004: Offline target loader

**Status:** accepted · 2026-08-22

## Context

Three commands — `target plan`, `target apply`, `target verify` — each read offline JSON files
and each rebuilt the same incantation,
`createTargetIdentity(identityInputFrom(readJsonObject(path), profile, resource))`, over a
module (`offline-files.ts`) shallow enough to be a pair of helpers rather than a seam. The
errors they raised were ordinary `Error`s with ad-hoc prose, plus one string constant
(`DATA_HYGIENE: …`) that only the plan command knew about.

Apply was the hole. It cast the plan file `as unknown as MutationPlan` without validating
anything, checked only that profile and resource matched the flags, and then derived the
execution request from that unvalidated object. A hand-crafted plan file with a secret-shaped
payload sailed straight through. The guard caught a tampered digest — but as a late
`PLAN_TAMPERED` STOP receipt, after the executor was already involved, which describes a
refused mutation attempt rather than a file that should never have been loaded.

## Decision

`offline-target.ts` replaces `offline-files.ts` and owns the whole offline load path: reading,
validation, request derivation, and one error vocabulary.

- Five codes, one error class: `FILE_UNREADABLE`, `IDENTITY_INVALID`, `PLAN_INVALID`,
  `TARGET_MISMATCH`, `DATA_HYGIENE_REJECTED`, raised as `OfflineTargetError` with the message
  format `CODE: short reason`. Messages name the field or file role that failed, never the
  value: an offline file holds tenant identifiers and payloads, and neither belongs in an
  error string.
- `loadOfflinePlan` runs `verifyPlanIntegrity` — the plan's own signed-record verifier — so
  plan-shape and digest validation is the kernel's, never hand-rolled. It then runs the
  data-hygiene check on the payload. This is a deliberate tightening of what apply accepts.
- Apply's contract is plan-as-intent: execute exactly this verified plan. `applyRequestFor`
  derives the request from the plan, so the load seam — digest verification plus data
  hygiene — is the CLI's real gate.
- The loader is CLI-side and is not exported from the kernel barrel, the same placement rule
  as `dry-run-transport.ts`. Commands import it directly.
- Command bodies stay thin but keep their execution wiring visible: the `executeMutation`,
  `createMutationPlan`, and `confirmationTokenFor` calls remain in the command, because what a
  command does to the world should be readable in the command.

## Consequences

- The guard's request-vs-plan checks (`OPERATION_MISMATCH`, `PAYLOAD_MISMATCH`,
  `READBACK_EXPECTATION_MISMATCH`) are vacuous at this call site by design: the request is
  derived from the plan, so it cannot disagree with it. They are retained as kernel
  belt-and-braces for programmatic callers that build a request independently. This is not a
  bug and must not be "fixed" by weakening either side.
- The guard also re-runs `verifyPlanIntegrity` (`PLAN_TAMPERED`). As with `guard.ts` and
  `executor.ts`, the duplication is deliberate: the seam should not depend on one side being
  correct.
- Re-supplying `--input` at apply was considered and declined. It would mean two files to keep
  in sync, and a mismatch between them would surface as a late guard STOP rather than a clear
  load error — worse diagnostics for no additional safety.
- Plan expiry stays guard-side. An expired plan is a legitimate refused attempt, not an
  unreadable file, and earns its `PLAN_EXPIRED` STOP receipt.
- Barrel-exposure audit: `MutationRequest` and `TargetIdentity` remain genuine kernel API —
  the executor's input and the guard's context — and stay in the barrel. Transport-facing
  vocabulary remains exactly `TargetBinding`, `Digest`, `JsonValue`, `MutationOperation`. No
  `types.ts` split until a real live mutation adapter demonstrates the need. The loader and
  the dry-run adapter are imported directly, never via the barrel, and the dry-run adapter
  touches none of the raw identity types.
- No digested record shape changed; the golden digests are untouched.
- The executor's re-checks of guard-established facts are deliberate layering, not drift:
  the guard-decision shape check and the identity re-check are unreachable-by-design
  belt-and-braces; the transport-binding pre-dispatch check is genuinely executor-owned
  (the guard knows nothing about adapters); and the `safeTarget`/`safeDigest` fallbacks
  exist because failure-path receipts must still be written when the plan itself is the
  broken input. Their sentinel digests are receipt-visible frozen vocabulary, pinned in
  the golden-digest gate.
