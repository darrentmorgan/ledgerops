# ADR-0009: Write-ahead receipt readiness and the append-only file store

**Status:** accepted · 2026-08-23

## Context

`evaluateMutationGuard` treated the presence of a `write` method as receipt-sink
availability. A sink that fails at write time (permissions, storage, network) was
only discovered in the executor's `finish`, after dispatch — the mutation landed
`UNCERTAIN` with no persisted receipt. A pre-dispatch probe write was considered and rejected: a probe that
succeeds and a receipt write that later fails are separated by a TOCTOU window,
so a probe proves nothing about the write that matters.

Separately, `InMemoryReceiptSink` was the only sink, so no receipt survived the
process. This decision fixes the durable store as
a local append-only file under `~/.config/ledgerops/` — the private side of the
ADR-0007 boundary, never the repository.

## Decision

- `ReceiptSink` gains a required `writeAhead(intent)` method. Before the
  transport is touched, the executor persists a `ledgerops.write-ahead.v1`
  signed record (descriptor-driven per ADR-0002: profile, resource, operation,
  target binding, `planDigest`, `confirmationDigest`, `recordedAt`, digest field
  `entryId`). The write that proves readiness is a real journal write, not a
  probe — there is no window between proof and use on the pre-dispatch side.
- A `writeAhead` failure is terminal: the executor STOPs with reason code
  `RECEIPT_SINK_UNAVAILABLE`, `dispatchState: 'not-dispatched'`. The guard's
  `RECEIPT_SINK_REQUIRED` check now also requires the `writeAhead` method.
- The post-dispatch audit receipt finalizes the intent; readers join the two
  records on `planDigest` (and `confirmationDigest`). An intent line with no
  matching receipt line is the durable trace of an interrupted dispatch.
- `FileReceiptSink` is the durable sink: append-only JSONL at
  `$XDG_CONFIG_HOME/ledgerops/receipts.jsonl` (default `~/.config/ledgerops/`),
  directory mode `0700`, file mode `0600`, one canonical-JSON signed record per
  line, fsync before success. Nothing in the sink truncates, rewrites, or
  deletes; corrections are new records, never edits.

## Consequences

- The residual uncertainty window shrinks to its irreducible core: a sink that
  dies between a successful `writeAhead` and the final `write` still yields
  `RECEIPT_WRITE_FAILED`/`UNCERTAIN`, but the persisted intent now proves a
  dispatch was attempted, for which target, and under which plan digest.
- Existing STOP paths are untouched; the change only adds a STOP before
  dispatch. Sink implementations must implement both methods — a write-only
  sink is rejected by the guard (ADR-0001: no compatibility surface).
- Receipts never enter the repository; the store location is per-user
  configuration (ADR-0007).
