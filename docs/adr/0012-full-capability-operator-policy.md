# ADR-0012: Full Xero capability with operator-selected execution policy

**Status:** accepted · 2026-08-23
**Supersedes:** ADR-0006

## Context

LedgerOps exists to expose as much of the practical Xero API as possible through a fast,
scriptable CLI for humans and coding agents. ADR-0006 instead made a repository-wide policy
decision for every operator: agents could use only the guarded kernel, DRAFT was their ceiling,
and direct commands were permanently fenced off. That confused the tool's capability with one
operator's preferred authority policy and prevented the CLI from serving professional users who
deliberately grant broader authority to their own automation.

## Decision

- **Capability is complete by direction.** LedgerOps will expose the practical Xero API surface
  through readable, composable commands. A supported command is available to a human or an agent;
  the CLI does not classify a capability as human-only.
- **Policy belongs to the operator.** The user decides which profiles, scopes, commands, resources,
  and mutation classes a person or agent may use. LedgerOps supplies controls but does not impose a
  universal READ/DRAFT/WRITE ceiling.
- **Mutations preview by default.** The target LedgerOps interface shows the intended mutation and
  requires explicit `--execute` to dispatch it. ADR-0013 amends the original flag proposal:
  `--yes` only answers confirmation and never dispatches alone. JSON and non-TTY scripts
  execute once on `--execute` without prompting. All direct mutations now use this gate.
- **Guarded execution remains optional.** The digest-bound target identity, plan, confirmation,
  guard, one-dispatch executor, read-back, and receipt pipeline remains a high-assurance execution
  policy for users who choose it. It is not the only legitimate route to Xero.
- **The public command becomes `ledgerops`.** The earlier compatibility-alias proposal is retired.
  The public package installs only `ledgerops`.
- **Xero is the scope.** LedgerOps is a thin CLI over Xero rather than an MCP server or a generic
  multi-accounting-platform abstraction.

Useful safety mechanisms include explicit profiles, validation, dry runs, previews, confirmations,
bounded batches, idempotency, receipts, explainability, and read-only policies. They make powerful
operations easier to control; they do not remove those operations from the capability surface.

## Consequences

- Roadmaps and instructions must stop describing direct commands as a forbidden legacy surface or
  DRAFT as the product ceiling.
- Endpoint coverage, operator ergonomics, batch workflows, and stable machine-readable output become
  first-class product work.
- A clean-install Demo Company journey may safely demonstrate real mutations before a user connects a
  production organisation.
- Changes to the current safety kernel must preserve its invariants for operators who select guarded
  execution, even while direct and previewed command paths expand.
