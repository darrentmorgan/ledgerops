# ADR-0008: Bulk work is a loop of single plans

**Status:** accepted · 2026-08-23 · superseded in part by ADR-0011 (confirmation-cost
rule only; the single-plan dispatch rule stands)

## Context

Accounting workflows can involve bulk shapes — a reconciled statement can imply dozens of
draft bills; matching runs touch many transactions. The kernel deliberately binds one
resource to one plan, one confirmation, one dispatch, one read-back, one receipt. Bulk
pressure is exactly where that bound would erode quietly: a "small" widening of the plan
to carry N items changes confirmation semantics, receipt granularity, and failure
handling all at once.

## Decision

In this original decision, bulk work is expressed as a loop of single plans: each item gets
its own digest-bound plan, confirmation, guarded dispatch, and receipt. No kernel type
gains multiplicity.

Batch plans — one manifest, one digest, one confirmation covering N items, per-item
receipts — are a real future design, and they require their own ADR before any
implementation. Partial-failure semantics, per-item STOP/UNCERTAIN handling, and what a
single human confirmation over N items actually approves must be decided there, not
improvised in a workflow.

## Consequences

- Per-item confirmation increases operator work; under a DRAFT-only policy the consequences of a
  mid-loop failure are drafts that already exist, individually receipted.
- Workflows may generate many plans from one source manifest, but each plan stands
  alone; a shared manifest hash in receipt cores is the provenance link.
- Any PR that adds multiplicity to plan, confirmation, guard, or executor contracts
  without a superseding ADR is out of bounds.

ADR-0011 now supplies the batch design described above while preserving single-plan dispatch.
