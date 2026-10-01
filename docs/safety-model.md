# Safety model

LedgerOps exposes API capabilities. The operator decides which organisation,
commands and mutation classes a caller may use. A successful login, preview or
synthetic test is not permission to change accounting data.

## Gated direct commands

All 20 direct mutation commands preview by default. They resolve the named profile
and validate the payload before printing a preview. These payload previews make no
mutation dispatch and do not fetch a remote before-state. Update previews include
the record identifier in the digest; they describe submitted fields, not a fetched
diff. They cannot establish that an identifier exists or that the remote record has
not changed.

Execution needs `--execute`. `--yes` only answers an interactive confirmation.
The prompt appears only for human-readable execution when stdin and stdout are
terminals. The snapshot-bound preview and prompt go to stderr. JSON and piped
execution do not prompt. A direct mutation is attempted once, without mutation
retry. An uncertain result needs investigation and read-back, not blind replay.

Invoice batches seal member plans and tenant provenance into a manifest. One
confirmation binds the manifest digest. After confirmation and snapshot checks,
execution observes the selected tenant and checks organisation access using one
fixed client, before opening the receipt sink. Unrelated connections cannot select
the target. A refusal at this stage dispatches nothing. Execution is once per
member; a batch is not an atomic transaction or a promise of rollback.

## Offline target apply

The target planner loads supplied synthetic identity and plan inputs. Target apply
requires the exact confirmation, uses an in-memory synthetic transport, reads back,
and returns its receipt envelope. It does not write to Xero and is not an alternate
way to execute a direct API command. Local fixture receipts remain in memory.
See the executable synthetic plan/apply rehearsal in
[the automation guide](automation.md).

Target verification also has an explicit live Demo Company mode, and target reads
can use an explicit live adapter. Those are network reads with separate identity,
resource, query and receipt requirements. Do not call every target command offline.
Likewise, zero mutation dispatch is not a guarantee that login, token refresh,
identity checks or another step in a surrounding workflow makes no network request.

## Identity and output

Verify the organisation before live work, then use an explicit profile throughout.
Check referenced IDs, summarise the intended write and obtain the operator's
authority. Never substitute another profile to get past a refusal.

JSON preview, direct execution, batch execution and target receipts are distinct
contracts. Validate the expected schema/outcome and process exit status; do not
interpret parseable JSON as success. Keep stdout and stderr separate. Logs, tokens,
identities and receipts may contain private information and belong in private
storage, never the public repository.

The repository holds the engine and synthetic fixtures only; see [ADR-0007](adr/0007-public-engine-private-operations.md).
These decisions do not weaken the mutation gate or replay guarantees.
