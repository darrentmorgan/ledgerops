# LedgerOps domain glossary

This is the public repository. These are the domain terms; use them exactly.
Decisions live in `docs/adr/`; product direction lives in `docs/roadmap.md`.

## Terms

- **Target** — the resolved profile + resource pair an operation binds to. Direct commands
  can resolve a configured default profile; operators and automation must pass an explicit
  verified profile for live work. The mutation gate binds the resolved target into its
  snapshot. Guarded `target` commands require an explicit profile and resource.
- **Target identity** — a verified, freshness-bounded snapshot of a target: profile, resource,
  tenant fingerprint, capability and scope fingerprints. A cached value is not identity proof.
- **Target binding** — the five-field redacted binding (`profileName`, `resource`,
  `tenantFingerprint`, optional `objectFingerprint`, `targetFingerprint`) that ties a plan,
  confirmation, or receipt to one target. Raw identifiers never appear in a binding.
  Two bindings are the same only when all five fields match; the target fingerprint alone
  is never treated as proof of sameness. One kernel predicate owns this comparison.
- **Canonical digest** — SHA-256 over canonical JSON. The identity of a plan, confirmation,
  or receipt is its digest; verification is re-canonicalize and re-digest.
- **Signed record** — a digest-bound, deep-frozen record created and verified through the
  descriptor-driven signed-record module. The descriptor is the single statement of what a
  record's digest covers; plans, read-back expectations, and receipts are signed records.
- **Plan** (mutation plan) — a digest-bound, expiring, single-resource preview of exactly one
  mutation. A plan authorizes nothing by itself.
- **Confirmation** — the exact `CONFIRM <planDigest>` token binding a human approval to one
  plan. Approval is per-digest, never reusable.
- **Guard** — the fail-closed check set in front of execution. Returns allowed or a
  `GuardFailureCode`; nothing dispatches without passing it.
- **Executor** — guarded one-dispatch/no-retry execution with exactly one read-back and an
  allowlisted receipt. Terminal outcomes are STOP or UNCERTAIN.
- **Mutation transport** (port) — the one seam between the kernel and a remote system. Four
  things cross on dispatch — operation, payload, target binding, plan digest — so an adapter is
  told what to write, never who to write it as. An adapter is constructed bound to a single
  target and must throw, not report a refusal, when handed any other.
- **Dry-run adapter** — the in-memory, target-bound transport behind offline `target apply`:
  it accepts one dispatch and reads the same payload back. An adapter is not kernel vocabulary,
  so callers import the module directly rather than through the barrel.
- **Offline target loader** — the CLI-side module that turns offline identity and plan JSON
  files into verified kernel values and owns the offline error vocabulary. Not kernel
  vocabulary; commands import it directly rather than through the barrel.
- **Read-back** — the single post-dispatch verification read, checked against the expectation
  recorded in the plan.
- **Receipt** (audit receipt) — the allowlisted, redacted record of an execution outcome.
  The file sink persists append-only JSONL in the operator's private store
  (ADR-0009); offline commands may use an in-memory sink.
- **STOP** — a terminal fail-closed outcome. A STOP is never retried.
- **UNCERTAIN** — dispatch happened but the outcome is unproven. Requires reconciliation,
  never replay.
- **Live identity gate** — the bounded one-shot Demo Company identity read
  (`target verify --live-demo`) used by the optional guarded execution policy.
- **Live context (resource-bound)** — a fresh, Demo-Company-verified identity projected into
  a redacted binding for one resource, such as `invoices`. Built by reusing the live
  identity gate's freshness and Demo Company checks, never by re-deriving them; adapters
  stay raw-record dumb at the ADR-0003 seam.
- **Capability surface** — the practical Xero operations LedgerOps exposes through commands.
  Capability is not classified by whether the caller is a human or an agent.
- **Direct command** — a thin command over a Xero operation, such as `invoices create` or
  `payments create`. Direct commands are part of the supported capability surface, not a
  forbidden legacy surface.
- **Execution policy** — the operator-selected controls applied when using a capability, such as
  direct, previewed, read-only, bounded, or guarded execution. Policy constrains an invocation;
  it does not remove the underlying command.
- **Preview** — a non-dispatching representation of the exact mutation a command would send.
  The target interface previews mutations by default and requires explicit execution intent.
  A preview makes no API call of any kind; an update preview shows the outbound payload, not
  a diff against the current record (ADR-0016).
- **Mutation gate** — the shared preview-by-default execution path for gated commands: target resolution, payload validation, digest-bound preview, one dispatch on
  `--execute` (ADR-0013). _Avoid_: shared contract, execution gate.
- **Gated command** — a direct mutation command that runs through the mutation gate. All 20 direct mutation commands and `invoices batch` are gated commands. _Avoid_: migrated command, safe command.
- **Immediate command** — a direct mutation command that dispatches without the mutation gate.
  No currently shipped direct mutation command is immediate.
  _Avoid_: legacy command, raw command.
- **Guarded execution** — the optional high-assurance policy implemented by the target identity,
  plan, confirmation, guard, executor, read-back, and receipt pipeline.
- **Repository boundary** — the engine and synthetic fixtures live in the repository (MIT); every
  real profile, mapping, approval, receipt, and organisation value lives outside it. See
  ADR-0007.
