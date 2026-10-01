# ADR-0002: Descriptor-driven signed records

**Status:** accepted · 2026-08-12

## Context

Four record modules each hand-maintained the same field list several times over: the
interface in `types.ts`, the `unsigned` literal that gets digested, the rebuild literal
inside the verifier, and a sorted key allowlist. Counting the target binding, which is
re-checked in `readback.ts`, `plan.ts` and `audit.ts` with three separately written
copies of the same predicate, that is roughly seventeen parallel lists describing five
records. Every one of them had to be edited in lockstep to add a field.

Most drift fails closed and is caught immediately: a field in the build literal but not
the allowlist makes verification reject its own records. One shape fails open. A field
attached to the record outside the `unsigned` literal — added to the interface and the
allowlist, forgotten in the digest input — is carried on every record, passes the
allowlist, and is covered by no digest. Nothing in the type system or the tests notices;
the record verifies, and the field can be edited in flight.

## Decision

One in-process signed-record module (`signed-record.ts`) owns record assembly, digesting
and verification. A record is declared once as a descriptor, and everything else is
derived from it:

- Descriptors are interface-authoritative. `types.ts` stays the hand-written vocabulary;
  the descriptor's field map is a mapped type over the interface, so a missing field, a
  stray field, a wrong optionality marker or a mistyped check is a compile error.
- The digest covers exactly the declared fields. There is no second literal to forget,
  so the fail-open shape above cannot be written.
- Cross-field domain rules are named invariants registered in the descriptor, which both
  `create` and `verify` run. Verification is therefore the complete validity check, not
  a digest check that happens to sit next to some rules.
- Derived fields (payload digests, capability and scope fingerprints, first-element
  coherence) are computed once from supplied fields and re-derived mechanically during
  verification; a stored value that disagrees with its derivation is rejected even when
  the record is re-signed.
- Byte-identical digests are a permanent contract. `test/lib/ledgerops/golden-digests.test.ts`
  pins the digest of every record kind, plus full `JSON.stringify` snapshots, against
  values produced before this change.

## Consequences

- `create` and `verify` no longer speak different validation dialects. The differences
  resolved fail closed: receipt reason codes are enumerated rather than "any string",
  empty-string labels are rejected by `isAuditReceipt`, and a target binding carrying
  extra keys is rejected instead of being silently re-projected by a sanitizer.
- `create` throws `TypeError` for structural failures; `verify` never throws and returns
  a boolean. Domain errors raised before record assembly (TTL ordering, one-resource
  bounds, read-back agreement) stay where they are, with their existing types.
- `guard.ts` and `executor.ts` keep re-validating what they consume. The belt-and-braces
  duplication is deliberate: the kernel's fail-closed boundary should not depend on a
  single implementation being correct.
- Declined surface, each additive later if a real need appears: an `explain()` entry
  point, version registries, global descriptor registration, and function-valued digest
  envelopes. None had a caller.
