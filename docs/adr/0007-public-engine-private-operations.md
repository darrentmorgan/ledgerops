# ADR-0007: Public engine, private operations

**Status:** accepted · 2026-08-23

## Context

LedgerOps is an MIT-licensed fork of XeroAPI/xero-command-line.
Real identifiers, tokens, mappings, and financial data must remain outside Git; the
test suite is offline and synthetic by design.

## Decision

The repository boundary is permanent and explicit:

- **In the public repo:** the kernel, CLI, synthetic fixtures, ADRs, and public roadmap.
  Organisation-specific workflows belong in the operator's own repositories. MIT licensed.
- **Outside the repo, always:** client and personal configuration, profiles and tokens,
  accounting mappings, approval records, receipts, retained inputs, and real operational values.
  Their home is the operator's local private store (`~/.config/ledgerops/` and private
  notes), never Git, logs, or fixtures. Transient display of an allowlisted redacted
  receipt on stdout (as `target verify`/`target apply` already do) is permitted — the
  boundary governs durable storage and raw values, not the redacted command result;
  the persisted copy lives only in the private sink.
- Public examples use synthetic labels; binding real values remain in private records.

## Consequences

- Public-facing docs (README, SKILL.md) are part of the product surface and must track
  the CLI truthfully.
- Any contribution or automation that would introduce a real identifier fails review by
  rule, not judgement.
- The durable receipt sink (ADR-0009) writes under `~/.config/ledgerops/`, which this
  boundary already classifies as private.
