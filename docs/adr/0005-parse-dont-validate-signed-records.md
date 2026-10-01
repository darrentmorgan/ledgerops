# ADR-0005: Parse, don't validate — signed records return snapshots

**Status:** accepted · 2026-08-23

## Context

`SignedRecord.verify` was a boolean type guard: it checked the caller's object and
the caller kept using that same object afterwards. Three blind-review rounds on the
foundation PR demonstrated the same defect class three ways: an object whose
properties are accessor-backed (a getter, and ultimately a getter nested inside a
`canonicalValue` payload) can answer the signed value while `verify` reads it and a
different, unsigned value when the executor later dispatches it. Two descriptor
tightenings (reject enumerable accessors, then all non-data own properties) closed
the top level but could not close nested values or Proxies — no implementation can
make a boolean guard bind a digest to future reads of an object the caller controls.
The flaw was in the interface, not the implementation.

## Decision

The descriptor gains `parse(value): TRecord | undefined`. Parse snapshots the input
once through canonical JSON — every property, however deeply nested, is read exactly
once — then runs every check (field checks, derivations, invariants, signature)
against the snapshot and returns the deep-frozen snapshot itself. The digested bytes
and the returned bytes are the same bytes; nothing the input does after the single
read can change what was verified or what gets used.

`verify` remains as `parse(value) !== undefined` for membership tests, but every
kernel path that acts on a record acts on the parsed snapshot:

- `evaluateMutationGuard` parses the plan and read-back expectation; every guard
  comparison reads the snapshots, and the success decision carries the parsed plan.
- `executeMutation` dispatches, reads back, and writes allow-path receipts from
  `guard.plan`, never from the caller's plan object.
- `classifyReadBack` classifies against the parsed expectation.
- `loadOfflinePlan` returns the parsed plan, so offline apply executes the
  snapshot of the file it verified.

## Consequences

- The nested-accessor and Proxy class is closed by construction: hostile inputs
  either fail to parse or yield an honest frozen copy. The top-level descriptor
  sweeps in `isPlainRecord` remain as belt-and-braces rejections.
- `MutationGuardSuccess` now carries `plan`; anything constructing a success
  decision by hand must supply the parsed plan.
- Parsed records are deep-frozen; callers cannot mutate them, which is the point.
- Golden digests are untouched — parse changes who holds the bytes, not the bytes.
