---
name: ledgerops
description: Use the LedgerOps CLI through named profiles, documented JSON outputs and explicit execution policy.
---

# LedgerOps CLI adapter

Use Node.js 24 or newer and the single `ledgerops` executable. Run a command with
`--help` before composing arguments. The table below contains exactly the 59
shipped paths; planned inventory capabilities are not commands. Do not import
internal modules or assume a supported TypeScript SDK.

## Identity and authority

Verify the selected organisation with the organisation-details command before
live work, then pass the same explicit `--profile <name>` on every API command.
Do not change the default profile implicitly. Verify referenced IDs, describe the
precise mutation and organisation, and obtain the operator's authority before a
live write. Login, live verification and reads access an account; help does not.
Keep credentials in local configuration, never in the repository.

Login uses browser PKCE OAuth only when authorised. Tokens are bound to the profile
and OAuth client ID. Legacy unbound caches and removed/replaced profiles require
fresh login. Do not relabel tokens or substitute another profile after a refusal.

## Output and execution groups

| Group | JSON contract | Execution |
|---|---|---|
| Array | `--json` returns a resource array, including an empty array | Live read; no mutation execution flag |
| Object | `--json` returns one raw resource object | Live read; missing resources may refuse |
| Report | `--json` returns the raw report object | Live read; do not infer success from absent output |
| PDF | No JSON/CSV/TOON; these options explicitly refuse before the API | Live read; writes a file, or raw bytes with `--out -` |
| Mutation | Versioned preview; execution returns one resource, or `null` with exit 1 when unverified | Preview by default; `--execute` attempts one mutation |
| Batch | Versioned batch preview/result described below | Preview by default; execution once per member |
| Local/auth | Human-readable messages; do not rely on JSON output | Local profile/token changes or browser authentication |
| Target | JSON by default, with distinct envelopes below | No `--json` or `--execute`; explicit target-specific modes |

Resource and report objects expose provider data, not a new normalised schema.
Do not guess their fields from a list-table display. Structured reads also offer
CSV/TOON presentation, but use JSON for machine handling. PDF file completion
messages are not the downloaded bytes; keep binary stdout out of a JSON parser.
Local/auth commands do not become machine contracts merely because a common flag
may be accepted by the parser.

All 20 direct mutations and the invoice batch are gated. A payload preview makes
no mutation dispatch and does not fetch a remote before-state. Update previews
bind the record identifier into the digest and show submitted fields, not a fetched
diff. A surrounding workflow's login, token refresh or explicitly live identity/read
step can still make network calls. Synthetic examples are not live verification.

`--execute` is required for mutation dispatch. `--yes` only answers confirmation
and never dispatches alone. Human-readable execution prompts only when stdin and
stdout are terminals. The snapshot-bound preview and prompt go to stderr; JSON
and non-TTY execution do not prompt. Direct mutations are not retried. A batch
checks fresh selected-tenant provenance using one fixed client before its receipt
sink opens, and may stop partway through; it is not an atomic transaction.

Capture stdout/stderr separately. Require the expected exit status, schema and
outcome. Valid JSON, an empty stderr stream or a top-level success-like field alone
does not prove a completed write. Stop on refusal, malformed/missing output or
uncertainty; do not automatically replay a write.

## Shared envelopes

A direct JSON preview has `schemaVersion: "ledgerops.mutation-preview.v1"`,
`operation`, `resource`, `profile`, `payloadDigest`, `payload` and
`willDispatch: false`. Direct digests have a `sha256:` prefix. The executed direct
JSON response is the one raw resource object the provider returned, not a receipt or preview
envelope. A response that lacks exactly one resource or a non-empty ID (matching
the target on updates), or that carries a provider validation failure, is
UNCERTAIN: stdout is `null`, stderr explains, and the exit code is 1. The write may
have happened; verify it with a live read before any retry.

The batch preview uses the same versioned envelope with `operation: "batch-create"`.
Its payload includes the manifest digest and every planned member. Batch manifest
digests are bare SHA-256 hex, not the prefixed direct-payload digest format.
Execution JSON has `schemaVersion: "ledgerops.batch-result.v1"`, `batchId`,
`manifestDigest`, `runState`, `halted`, `counts`, `items` and optional
`haltedAtIndex`. Inspect each item's outcome and optional reason/receipt ID.
`runState: "UNCERTAIN"` is not success; a closed run still needs member inspection.

Target commands emit JSON without an output flag:
- Verification with an offline input returns a redacted identity. Explicit live
  Demo verification returns its own receipt and requires the Demo expectations
  shown by help; it is not a generic live organisation probe.
- Planning returns `{plan, exactConfirmation}` from offline identity/input files.
- Apply requires the exact `--confirm` token and returns `{result, receipts}`.
  It uses only the in-memory synthetic transport, never writes to the API, and does
  not replace direct mutation execution.
- Read requires exactly one of fixture `--records` or `--live`. It returns the
  bounded read result: `status`, `outcome`, `stop`, `records`, `callCount`,
  `recordCount`, `receiptWriteFailed`, and optional `reasonCode`/`receipt`.
  A stop sets a nonzero exit code. Query JSON must be an object; receipt-path
  override requires live mode. Fixture receipts remain in memory. Live reads
  persist receipts before releasing records.

## Shipped command paths

### Target input and receipt files

Offline identity input is one JSON object with matching `profileName` and
`resource`, a nonempty synthetic `tenantId`, explicit `isDemoCompany`,
numeric `observedAt` (epoch milliseconds), optional `freshUntil`/`objectId`,
and string arrays `capabilities`/`scopes`. The kernel validates freshness and
authority; a supplied identity does not attest live access. Verification redacts
tenant/object IDs into fingerprints and includes freshness and authority
fingerprints. Never turn that redacted output back into raw identity by guessing IDs.

Plan input is a JSON object with `operation`, `payload`, optional `expected`
(defaults to payload), `requiredCapabilities`, `requiredScopes`, and optional
`planId`, `createdAt`, `expiresAt`. Save the returned `plan` object unchanged
for apply and use the returned `exactConfirmation`; do not construct or modify
its digest. Fixture records are one JSON array and query input is one JSON object.
Secret-shaped fixture content refuses rather than being silently redacted.

Apply's `result` includes `status`, `outcome`, `terminal`, `stop`,
`dispatched`, `dispatchState`, `readBackClassification`, `guard`, `receipt`
and `receiptWriteFailed`. A synthetic `dispatched` value is not a live write.
The public read receipt uses `schemaVersion: "ledgerops.read.v1"`,
`receiptId`, `recordedAt`, `profileName`, `resource`, `target`,
`queryDigest`, `maxCalls`, `callCount`, `recordCount`, `outcome`,
`terminal` and optional `reasonCode`. It contains no record digest; do not
infer stronger record-binding guarantees from the version label.
Live identity receipts use `ledgerops.identity.receipt.v1`; successful output
contains the profile/resource, target fingerprint, Demo flag, freshness and
capability/scope fingerprints. Refused live verification returns a STOP receipt,
not a usable identity. Keep the full receipt for diagnosis without treating it as
permission for another operation.

### Commands

Prefix each path with `ledgerops`. Inputs below list command-specific arguments
and options, not a claim that every option is required or may be combined. Consult
built help for required values, alternatives, defaults and supported enum values.
Array/Object/Report/PDF/Mutation/Batch commands use the explicit profile rule.
For mutations, use validated JSON via the file option where offered or the listed
field flags. Never infer file field names by stripping hyphens from flag names.

| Command path | Group | Command-specific inputs |
|---|---|---|
| `accounts list` | Array | No command-specific input |
| `accounts update` | Mutation | --file, --account-id, --name, --code, --description, --status, --tax-type, --enable-payments-to-account |
| `login` | Local/auth | --profile, --client-id, --scope |
| `logout` | Local/auth | --profile |
| `bank-transactions create` | Mutation | --file, --type, --bank-account-id, --contact-id, --date, --reference, --description, --quantity, --unit-amount, --account-code, --tax-type |
| `bank-transactions get` | Object | --bank-transaction-id |
| `bank-transactions list` | Array | --bank-account-id, --bank-transaction-id, --page |
| `bank-transactions update` | Mutation | --file, --bank-transaction-id, --contact-id, --type, --date, --reference |
| `contact-groups list` | Array | --group-id |
| `contacts create` | Mutation | --file, --name, --email, --phone |
| `contacts get` | Object | --contact-id, --contact-number |
| `contacts list` | Array | --search, --page |
| `contacts update` | Mutation | --file, --contact-id, --name, --email, --phone, --first-name, --last-name |
| `credit-notes create` | Mutation | --file, --contact-id, --reference, --description, --quantity, --unit-amount, --account-code, --tax-type |
| `credit-notes list` | Array | --contact-id, --credit-note-number, --page |
| `credit-notes pdf` | PDF | --credit-note-id, --out |
| `credit-notes update` | Mutation | --file, --credit-note-id, --contact-id, --date, --reference |
| `currencies list` | Array | No command-specific input |
| `invoices batch` | Batch | --file, --identity, --account-code, --invoice-type, --tax-type, --batch-id, --halt-policy, --ttl-ms, --source-receipt-id, --source-manifest-hash, --receipts |
| `invoices create` | Mutation | --file, --contact-id, --type, --description, --quantity, --unit-amount, --account-code, --tax-type, --item-code, --date, --reference |
| `invoices get` | Object | --invoice-id, --invoice-number |
| `invoices list` | Array | --contact-id, --invoice-number, --page, --page-size |
| `invoices pdf` | PDF | --invoice-id, --out |
| `invoices update` | Mutation | --file, --invoice-id, --contact-id, --date, --due-date, --reference |
| `items create` | Mutation | --file, --code, --name, --description, --sale-price, --purchase-price |
| `items list` | Array | --page |
| `items update` | Mutation | --file, --item-id, --code, --name, --description, --sale-price, --purchase-price |
| `manual-journals create` | Mutation | --file |
| `manual-journals list` | Array | --manual-journal-id, --modified-after, --page |
| `manual-journals update` | Mutation | --file |
| `org details` | Array | No command-specific input |
| `payments create` | Mutation | --file, --invoice-id, --account-id, --amount, --date, --reference |
| `payments list` | Array | --invoice-id, --invoice-number, --payment-id, --reference, --page |
| `profile add` | Local/auth | &lt;name&gt;, --client-id, --force |
| `profile list` | Local/auth | No command-specific input |
| `profile remove` | Local/auth | &lt;name&gt; |
| `profile set-default` | Local/auth | &lt;name&gt; |
| `purchase-orders pdf` | PDF | --purchase-order-id, --out |
| `quotes create` | Mutation | --file, --contact-id, --title, --summary, --terms, --reference, --date, --description, --quantity, --unit-amount, --account-code, --tax-type |
| `quotes get` | Object | --quote-id |
| `quotes list` | Array | --contact-id, --quote-number, --page |
| `quotes pdf` | PDF | --quote-id, --out |
| `quotes update` | Mutation | --file, --quote-id, --contact-id, --title, --summary, --terms, --reference, --date, --expiry-date |
| `reports aged-payables` | Report | --contact-id, --report-date, --from-date, --to-date |
| `reports aged-receivables` | Report | --contact-id, --report-date, --from-date, --to-date |
| `reports balance-sheet` | Report | --date, --periods, --timeframe, --payments-only, --standard-layout, --tracking-option-id-1, --tracking-option-id-2 |
| `reports profit-and-loss` | Report | --from, --to, --periods, --timeframe, --payments-only, --standard-layout |
| `reports trial-balance` | Report | --date, --payments-only |
| `target apply` | Target | --profile, --resource, --identity, --plan, --confirm |
| `target plan` | Target | --profile, --resource, --identity, --input |
| `target read` | Target | --profile, --resource, --identity, --records, --live, --query, --max-calls, --receipts |
| `target verify` | Target | --profile, --resource, --input, --live-demo, --expect-demo-company |
| `tax-rates list` | Array | No command-specific input |
| `tracking categories create` | Mutation | --name |
| `tracking categories list` | Array | --include-archived |
| `tracking categories update` | Mutation | --category-id, --name, --status |
| `tracking options create` | Mutation | --category-id, --name |
| `tracking options update` | Mutation | --category-id, --option-id, --name, --status |
| `users list` | Array | --user-id |

## Offline examples

The `target plan` / `target apply` pair is an opt-in, conservative lane that only
creates DRAFT invoices and manual journals. The direct commands (for example
`invoices create`, with preview by default and `--execute` to dispatch) are the
general path.

Account and tax codes (such as `200` above) are organisation-specific. Look up
your own with `ledgerops accounts list` and `ledgerops tax-rates list`.

These commands are checked against the built CLI with isolated config and a
network-forbidden preload. The synthetic profile has no tokens and must not execute.

```sh example:skill-profile
ledgerops profile add synthetic-skill --client-id synthetic-skill-client
```

```sh example:skill-preview
ledgerops invoices create --profile synthetic-skill --type ACCREC --contact-id 00000000-0000-0000-0000-000000000001 --description Synthetic --quantity 1 --unit-amount 10 --account-code 200 --tax-type NONE --json
```

```sh example:skill-read-help
ledgerops contacts list --profile synthetic-skill --json --help
```

The last example checks read syntax without calling the API. For the offline
target planning/apply rehearsal and zero-dispatch batch demonstration, follow
[automation](docs/automation.md) and [the demo journey](docs/demo-journey.md).
Preserve the fail-closed target invariants and use offline synthetic fixtures for
tests. See [AGENTS.md](AGENTS.md) for the repository's identity and execution policy.
