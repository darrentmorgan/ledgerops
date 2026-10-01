# ADR-0001: No legacy compatibility surface

**Status:** accepted · 2026-08-12

## Context

`src/lib/ledgerops/legacy.ts` carried a complete parallel contract hierarchy
(`LegacyPlan`, `LegacyConfirmation`, `LegacyIdentity`, `LegacyGuardResult`,
`LegacyIdentityReceipt`) alongside the strict kernel. Its executor was a tombstone that
always returned STOP; its guard was 54 lines of divergent policy including a fixture
escape hatch that accepted `ledger.synthetic.scope` as proof of scope. Both strict entry
points (`evaluateMutationGuard`, `executeMutation`) were overloaded on it, so every strict
call paid a runtime duck-typing probe. No command reached it; the barrel's 26 compatibility
aliases had one referenced member, and only from the legacy test file.

The removed layer was an earlier unpublished implementation; it is not a public API.

## Decision

The strict kernel is the only contract. Legacy-shaped inputs are rejected, not adapted:
no parallel type hierarchy, no conversion adapter, no compatibility aliases in the barrel.
`legacy.ts`, the overload probes, and all 26 aliases are deleted; the canonicalization tests
move to `test/lib/ledgerops/canonical.test.ts`.

## Consequences

- `evaluateMutationGuard` and `executeMutation` are plain functions over strict inputs.
- The `ledger.synthetic.scope` escape hatch no longer exists anywhere.
- The barrel exports one vocabulary; there is no second name for anything.
- Historical phase evidence is not part of the public documentation.
- Future architecture reviews must not re-propose a compatibility surface; a producer of
  legacy-shaped plans would need a new ADR reversing this one.
