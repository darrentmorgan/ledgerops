# ADR-0016: Update previews are payload-only and every mutation is one digest-bound dispatch

**Status:** accepted and implemented · status recorded 2026-09-13
**Amends:** ADR-0013 (extends the gate to `update` and nine more resources)

Originally proposed on 2026-09-09. All 20 direct mutation commands now use the
shared gate. This status update records the shipped implementation; the decision
and its original context below are preserved.

## Context

ADR-0013 defined the preview-by-default gate for `create` on invoices and payments. The public
mutation surface extends that contract to updates and the remaining resources.
Updates raise two questions the create contract never faced: whether a preview may read the
current record to show a diff, and how the path identifier (the URL's record ID) is bound to
what the operator confirmed.

## Decision

- **A preview makes no API call.** An update preview shows the outbound payload, not a diff.
  Reading the record first would need a client, token load, and possible refresh before any
  confirmation, and the command tests already count a read as a dispatch. The gap this leaves
  (an operator confirming against a stale belief about the record) is documented, not hidden.
- **The summary names the changed fields and any status transition.** Free-text summaries are
  not enough for irreversible updates such as archiving an account or voiding an invoice.
- **The path identifier lives inside the digested payload.** A command that sends the ID only
  in the URL (for example, `tracking categories update`) moves it into the payload so the confirmed
  digest covers which record changes as well as what changes.
- **One invocation, one dispatch.** The two looping tracking-option commands take one option
  per call until a sealed batch-update contract exists (ADR-0011 shape). Wrapping a loop in the
  gate's single-dispatch guard would pass the guard while sending N requests.
- **The gate keeps closed unions.** Operation gains `update`; resource gains the nine remaining
  names. A shared base-command helper removes the per-command plumbing. The gate never branches
  on resource or operation, so a per-command descriptor object would relocate nothing.
- **Migrated commands use the single-attempt client path**, never the retry wrapper, so a 401
  during dispatch is never replayed.

## Consequences

- Every public mutation command has a command-boundary test proving zero-dispatch preview,
  one-dispatch execute, `--yes` alone never dispatching, non-TTY JSON, and interactive
  confirmation. A command that fails those tests at release review is omitted, never shipped
  hidden.
- Batch update of tracking options requires a separate sealed batch design. Each current
  tracking-option invocation accepts one option and dispatches at most once.
- Diff previews for updates are a possible later feature behind an explicit read flag; they do
  not change the default.
