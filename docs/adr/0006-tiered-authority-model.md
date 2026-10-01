# ADR-0006: Tiered authority — READ free after identity, DRAFT is the ceiling, WRITE is a designed slot

**Status:** superseded by ADR-0012 · 2026-08-23

> Note: the tier model below is one optional operator policy, not a requirement of LedgerOps. Other operators may choose different authority rules.

## Context

The initial guarded execution design built a kernel that can prove identity, preview one mutation, and execute it
under guard — but the requirements record left the actual authority question open: what
are agents allowed to do in a real organisation, and who decides? A given operator may want
agents to save time on business ops (drafting invoices and bills, matching transactions,
auditing, reporting reads) without ever holding unsupervised posting authority, while
keeping a path to loosen specific low-risk actions later.

## Decision

Authority is expressed as three tiers, decided per organisation:

- **Tier 0 — READ.** After a fresh, bounded target-identity proof, agents may perform
  allowlisted redacted reads and exports. Reads still run through the kernel: bounded,
  receipted, through the transport seam.
- **Tier 1 — DRAFT.** Agents may create objects only in a state a human must approve
  inside the Xero UI (DRAFT invoices, DRAFT bills, draft journals). The Xero approval
  click is the final gate, on top of the kernel's plan/confirmation/guard chain. This was
  the ceiling under this superseded policy.
- **Tier 2 — WRITE.** Direct posting for action classes the operator explicitly marks
  low-risk, opted in per class, never by default. This tier is designed for — receipts,
  guards, and plans must not assume DRAFT-only — but no Tier 2 action is scheduled or
  authorized by this record.

The legacy raw CLI surface (ADR-0001's "legacy surface") sits outside every tier: agents
never invoke it, and Tier 2, when it arrives, arrives through the kernel — never by
unlocking legacy commands. The legacy surface remains available for direct human use.

## Consequences

- Correction authority, replay risk, and incident handling stay an order of magnitude
  simpler while the ceiling is DRAFT: a wrong draft is deleted in the Xero UI, not
  compensated in the ledger.
- Every new endpoint declares its tier in the roadmap's endpoint matrix; a read decision
  never implies draft authority, and a draft decision never implies write authority.
- SKILL.md and AGENTS.md must state the agent-facing fence: kernel commands only, legacy
  surface forbidden, DRAFT ceiling.
- ADR-0012 replaces this ceiling with operator-selected execution policy. The restrictions
  above describe the historical decision and are not current agent instructions.
