# ADR-0013: Preview-by-default execution gate for direct mutations

**Status:** accepted · 2026-08-24
**Amends:** ADR-0012 (mutation dispatch flag semantics only); ADR-0011 (citation correction, see its amendment note)

## Context

ADR-0012 set the product direction — full Xero capability with operator-selected execution
policy — and named the target mutation interface: preview by default, dispatch on an explicit
flag. It left the exact contract open. The initial implementation added the first slice: one shared
execution-gate module behind `invoices create` and `payments create`. Review of that
implementation surfaced decisions the earlier records did not settle: whether `--yes` may
dispatch on its own, when a confirmation prompt may appear at all, how a previewed mutation
stays bound to what actually dispatches, and whether transport-level retries may replay a
mutation after an authentication failure.

## Decision

- **One shared gate owns the mutation lifecycle.** Commands describe a mutation in a
  `MutationDescriptor` (operation, resource, resolved target identity, human summary,
  payload). The gate materializes exactly **one defensive frozen snapshot** of that
  descriptor and builds the human preview, the machine previews, the confirmation text,
  and the dispatched request exclusively from it. Callers cannot drift the mutation after
  it has been shown.
- **The resolved target is part of the snapshot.** Profile name and client ID are resolved
  once before the gate; dispatch consumes the snapshot-bound target and never re-reads
  mutable profile or default-profile configuration, so a config change during an
  interactive wait cannot retarget a confirmed mutation.
- **Preview by default; zero dispatch.** Without `--execute` the commands make zero API
  calls. Human-readable output renders a text preview; structured output emits the stable,
  explicitly versioned `ledgerops.mutation-preview.v1` schema (`--json`), with CSV and TOON
  renderings of the same record kept deterministic.
- **`--execute` is the non-interactive dispatch flag.** With `--execute` the command makes
  exactly one mutation dispatch through a single-attempt transport: authentication failures
  fail closed with a session-expired error instead of refreshing credentials and replaying
  the mutation. Ordinary reads keep their existing retry behavior.
- **`--yes` never dispatches alone.** It only pre-answers a confirmation. A confirmation is
  presented only when output is human-readable **and** both stdin and stdout are terminals.
  Structured output (`--json`, `--csv`, `--toon`) and piped/non-TTY use therefore dispatch
  once on `--execute` without prompting. Prompts write to stderr; machine-readable output
  stays alone on stdout.
- **No command-local execution policy.** All flag semantics, preview emission, confirmation
  rules, snapshot binding, and exactly-once dispatch live in the shared gate module;
  remaining direct mutation commands migrate to it incrementally.

## Consequences

- The sentence in ADR-0012 requiring "an explicit `--execute` **or** `--yes`" to dispatch is
  superseded by this record: `--yes` alone must never dispatch. The public ADR-0012 text
  incorporates this amendment explicitly; this record remains its semantic authority.
- The citation correction to ADR-0011 — citing the guarded live adapter's DRAFT-only
  transport contract instead of the superseded ADR-0006 ceiling — stands as the documented
  exception recorded in ADR-0011's amendment note.
- The guarded kernel (verify → plan → CONFIRM → apply) remains an optional high-assurance
  policy; this gate is the default policy for direct mutations as they migrate.
