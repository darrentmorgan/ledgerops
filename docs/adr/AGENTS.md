<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-23 | Updated: 2026-08-23 -->

# adr

## Purpose

Architecture decision records for LedgerOps product and kernel design. These are living authority:
code must conform, and any agent output that contradicts one must surface the conflict explicitly
rather than silently override it.

## Key Files

| File | Description |
|------|-------------|
| `0001-no-legacy-compatibility-surface.md` | The strict kernel is the only contract; `legacy.ts`, overloads, and aliases were deleted — never re-propose a compatibility surface |
| `0002-descriptor-driven-signed-records.md` | One descriptor per signed record; the digest covers exactly the declared fields; golden digests are a permanent contract |
| `0003-redacted-transport-seam.md` | Transports receive only operation/payload/binding/planDigest — never `TargetIdentity` or raw tenant; adapters are target-bound |
| `0004-offline-target-loader.md` | `offline-target.ts` owns offline JSON read + verify + request derivation with one `OfflineTargetError` vocabulary; apply is plan-as-intent |
| `0005-parse-dont-validate-signed-records.md` | Signed-record descriptors parse into defensive snapshots; boolean `verify`-then-use of caller objects is retired |
| `0006-tiered-authority-model.md` | Superseded historical policy that made DRAFT the agent ceiling; replaced by ADR-0012 |
| `0007-public-engine-private-operations.md` | Public MIT repo holds the kernel and synthetic fixtures only; client/personal config, tokens, mappings, receipts live outside the repo, always |
| `0008-bulk-as-single-plan-loops.md` | Bulk work is a loop of single plans — one digest, confirmation, dispatch, receipt per item; batch confirmation is superseded by ADR-0011 |
| `0009-write-ahead-receipt-sink.md` | `ReceiptSink.writeAhead` persists a signed intent before dispatch (fail-closed `RECEIPT_SINK_UNAVAILABLE`); durable store is append-only JSONL under `~/.config/ledgerops/` |
| `0010-bounded-read-contract.md` | Reads skip the plan/confirmation chain but are identity-bound, allowlisted, call-bounded, receipted (`ledgerops.read.v1`); live adapter is target-bound and redacted at the ADR-0003 seam |
| `0011-batch-manifests-over-single-plans.md` | Batch manifests group independently guarded single-plan members and prove coverage without replacing per-item receipts; carries a documented citation amendment |
| `0012-full-capability-operator-policy.md` | LedgerOps exposes the practical Xero capability surface to humans and agents; operators select direct, previewed, read-only, bounded, or guarded execution policy |
| `0013-preview-by-default-execution-gate.md` | Direct mutations preview by default through one shared gate; `--execute` dispatches once via single-attempt transport; `--yes` only answers confirmations; amends ADR-0012's flag semantics |
| `0014-stable-operation-identity-and-replay-semantics.md` | One timestamp-independent `operationId` is both the local dedup key and the Xero idempotency key; an additive generic replay-claim append is the durable claim and a burned claim is never auto-resumed |
| `0016-update-previews-are-payload-only.md` | Accepted and implemented: update previews are payload-only with no API calls; each single mutation invocation is one digest-bound dispatch, including its path identifier |

| `0019-batch-live-tenant-provenance.md` | Accepted: live batch command seals v2 tenant provenance, observes access after confirmation, and reuses one fixed client; preview remains offline and historical v1 goldens remain unchanged |

## For AI Agents

### Working In This Directory

- ADRs are append-only in spirit: supersede with a new numbered ADR rather than rewriting an accepted one.
- Changing kernel behavior covered by an ADR requires touching (or adding) the ADR in the same change.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
