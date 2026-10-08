# LedgerOps

> v0.1, alpha. Feedback welcome via GitHub issues.
>
> LedgerOps is a fork of [XeroAPI/xero-command-line](https://github.com/XeroAPI/xero-command-line),
> the MIT-licensed Xero CLI built by Regan Ashworth ([@TheRegan](https://github.com/TheRegan))
> and the Xero API team. Thanks to them for the foundation; see NOTICE.

A command-line interface for the practical Xero API using PKCE OAuth and named
connection profiles. Requires Node.js 24 or newer. This is an alpha; the version
does not imply a published release.

## Quick install

Prerequisites: Git, Node.js 24+ and npm, with npm's global bin directory on your
`PATH` and a writable global install location. LedgerOps is not published to npm;
install the local tarball built from this repository:

```sh
git clone https://github.com/darrentmorgan/ledgerops.git
cd ledgerops
npm ci
npm run build
npm pack
npm install --global --ignore-scripts ./ledgerops-0.1.0.tgz
ledgerops --help
```

`npm pack` names the tarball `ledgerops-<version>.tgz` from the `version` in
`package.json`; adjust the install line if the version differs from `0.1.0`.

Confirm it works: `ledgerops --help` prints the command list without credentials
or a Xero call. The package installs only `ledgerops`. Dependency installation
may use the npm registry; `npm pack` creates a local file and does not publish.
If you prefer to run from the checkout, use `node bin/run.js --help` after the
build and replace `ledgerops` with `node bin/run.js` in the examples below.
Run `npm test` from the checkout for the offline synthetic test suite.
[CI and releases](docs/release.md) describes the checks every change runs.

## Install for AI agents

For Claude Code, Codex, Cursor or another agent with shell access, use Git,
Node.js 24+ and npm. From a writable parent directory, these non-interactive
steps install dependencies, build the CLI and verify it without global install
permissions, credentials or Xero access. A private repository requires Git
authentication to be configured beforehand; terminal Git prompts are disabled.

```sh
GIT_TERMINAL_PROMPT=0 git clone https://github.com/darrentmorgan/ledgerops.git
cd ledgerops
npm ci --no-audit --no-fund
npm run build
node bin/run.js --help
node bin/run.js contacts list --help
```

Run subsequent commands from this checkout, replacing `ledgerops` in the command
reference with `node bin/run.js`. For a global executable, use the tarball install
in [Quick install](#quick-install) instead.

Point the agent at the absolute path printed by this command:

```sh
echo "$PWD/SKILL.md"
```

In the agent's task instructions, ask it to read that [SKILL.md](SKILL.md) and
[AGENTS.md](AGENTS.md) before using the CLI; Claude Code should also read
[CLAUDE.md](CLAUDE.md). Keep the checkout available: the skill links to repository
docs, source and tests. The npm tarball does not include the skill or those guides,
and this repository provides no separate agent-skill installer. Pointing at the
file supplies instructions; it does not automatically register a skill in an agent.

Installation and help checks do not authorise login or accounting operations.
Login requires authorised browser PKCE OAuth. Before live calls, verify the
organisation and use its explicit named profile as described below; obtain
authority for each live write. Never change the default profile implicitly.

## First use

Create a named profile with your OAuth client ID, then log in using that profile.
Login opens browser PKCE OAuth. Check the returned organisation with the organisation
details command before another live call. Pass that same explicit profile on every
subsequent call. Never change the default profile implicitly in automation.
These setup help requests need no credentials:

```sh example:setup-help
ledgerops profile add --help
ledgerops login --help
ledgerops org details --help
```

Choose a read command from the reference below and pass your verified profile.
Structured reads accept JSON output; PDF commands write files. Help output and
synthetic identities do not verify a live organisation.

## Preview and execute

All 20 direct mutations and the invoice batch are gated: a preview dispatches no
mutation. Current direct payload previews do not fetch the remote record. Updates
show submitted fields, not a fetched before/after diff. Target resolution and
payload validation can still refuse a preview. Live identity verification and
explicitly live reads are separate API operations: zero mutation dispatch does
not mean a surrounding workflow made no network calls.

For a safe local rehearsal, create a synthetic profile and preview one invoice:

```sh example:synthetic-profile
ledgerops profile add synthetic-docs --client-id synthetic-docs-client
```

```sh example:invoice-preview
ledgerops invoices create --profile synthetic-docs --type ACCREC --contact-id 00000000-0000-0000-0000-000000000001 --description Synthetic --quantity 1 --unit-amount 10 --account-code 200 --tax-type NONE --json
```

The versioned JSON preview contains the profile, payload, payload digest and
`willDispatch: false`. This synthetic profile has no tokens and must not execute.
Replace synthetic inputs only after checking the real target, IDs and authority.

Account and tax codes (such as `200` above) are organisation-specific. Look up
your own with `ledgerops accounts list` and `ledgerops tax-rates list`.

For an authorised real write, add `--execute` to the reviewed command. A direct
mutation dispatches once without retrying it. A batch dispatches once per member;
fresh tenant provenance is checked before opening the receipt sink. Preflight
or stale-manifest refusal dispatches nothing. `--yes` only answers a confirmation
and never dispatches alone.

Human-readable execution prompts only when stdin and stdout are both terminals.
JSON and non-TTY execution do not prompt; `--execute` remains required. Prompts go
to stderr so JSON stays alone on stdout. Direct JSON execution returns the written
resource, not the preview envelope; an unverified result prints `null`, reports
UNCERTAIN on stderr and exits 1. Batch and target commands have separate
result/receipt envelopes. Check exit status and outcome, not just valid JSON.

See [the safety model](docs/safety-model.md) and [automation](docs/automation.md).

## Command reference

Each shipped path appears once in this reference. Prefix it with `ledgerops`;
append `--help` for arguments and flags. The 59 paths are checked against the
generated [inventory](docs/xero-endpoint-inventory.md) and built help.
Planned inventory capabilities are not commands. Plugin help is separate.

| Command path | Effect | Description |
|---|---|---|
| `accounts list` | Live read | List all accounts in Xero |
| `accounts update` | Gated mutation | Update an account in Xero (payload-only preview by default; pass --execute to dispatch once) |
| `login` | Local setup or authentication | Log in to Xero via browser (PKCE OAuth) |
| `logout` | Local setup or authentication | Log out from Xero (clear cached tokens) |
| `bank-transactions create` | Gated mutation | Create a bank transaction in Xero (preview by default; pass --execute to dispatch) |
| `bank-transactions get` | Live read | Get a single bank transaction from Xero |
| `bank-transactions list` | Live read | List bank transactions in Xero |
| `bank-transactions update` | Gated mutation | Update a bank transaction in Xero (preview by default; pass --execute to dispatch) |
| `contact-groups list` | Live read | List contact groups in Xero |
| `contacts create` | Gated mutation | Create a contact in Xero (preview by default; pass --execute to dispatch) |
| `contacts get` | Live read | Get a single contact from Xero by ID or contact number |
| `contacts list` | Live read | List contacts in Xero |
| `contacts update` | Gated mutation | Update a contact in Xero (preview by default; pass --execute to dispatch) |
| `credit-notes create` | Gated mutation | Create a credit note in Xero (preview by default; pass --execute to dispatch) |
| `credit-notes list` | Live read | List credit notes in Xero |
| `credit-notes pdf` | Live read | Download a credit note as a PDF from Xero (binary output; --json/--csv/--toon are not supported) |
| `credit-notes update` | Gated mutation | Update a draft credit note in Xero (preview by default; pass --execute to dispatch) |
| `currencies list` | Live read | List currencies in Xero |
| `invoices batch` | Gated batch | Plan a CSV batch of DRAFT invoices and run it (preview by default; pass --execute to dispatch) |
| `invoices create` | Gated mutation | Create an invoice in Xero (preview by default; pass --execute to dispatch) |
| `invoices get` | Live read | Get a single invoice from Xero by ID or number |
| `invoices list` | Live read | List invoices in Xero |
| `invoices pdf` | Live read | Download an invoice as a PDF from Xero (binary output; --json/--csv/--toon are not supported) |
| `invoices update` | Gated mutation | Update an invoice in Xero (preview by default; pass --execute to dispatch) |
| `items create` | Gated mutation | Create an item in Xero (preview by default; pass --execute to dispatch) |
| `items list` | Live read | List items in Xero |
| `items update` | Gated mutation | Update an item in Xero (preview by default; pass --execute to dispatch) |
| `manual-journals create` | Gated mutation | Create a manual journal in Xero (preview by default; pass --execute to dispatch) |
| `manual-journals list` | Live read | List manual journals in Xero |
| `manual-journals update` | Gated mutation | Update a manual journal in Xero (preview by default; pass --execute to dispatch) |
| `org details` | Live read | Show organisation details from Xero |
| `payments create` | Gated mutation | Create a payment against an invoice in Xero (preview by default; pass --execute to dispatch) |
| `payments list` | Live read | List payments in Xero |
| `profile add` | Local setup or authentication | Add a new Xero connection profile |
| `profile list` | Local setup or authentication | List all configured profiles |
| `profile remove` | Local setup or authentication | Remove a Xero connection profile |
| `profile set-default` | Local setup or authentication | Set the default Xero profile |
| `purchase-orders pdf` | Live read | Download a purchase order as a PDF from Xero (binary output; --json/--csv/--toon are not supported) |
| `quotes create` | Gated mutation | Create a quote in Xero (preview by default; pass --execute to dispatch) |
| `quotes get` | Live read | Get a single quote from Xero by ID |
| `quotes list` | Live read | List quotes in Xero |
| `quotes pdf` | Live read | Download a quote as a PDF from Xero (binary output; --json/--csv/--toon are not supported) |
| `quotes update` | Gated mutation | Update a draft quote in Xero (preview by default; pass --execute to dispatch) |
| `reports aged-payables` | Live read | Generate aged payables report for a contact |
| `reports aged-receivables` | Live read | Generate aged receivables report for a contact |
| `reports balance-sheet` | Live read | Generate a balance sheet report from Xero |
| `reports profit-and-loss` | Live read | Generate a profit and loss report from Xero |
| `reports trial-balance` | Live read | Generate a trial balance report from Xero |
| `target apply` | Offline synthetic apply | Exercise the guarded apply path using the in-memory dry-run transport only |
| `target plan` | Offline plan | Create a deterministic one-resource mutation preview from offline JSON |
| `target read` | Fixture read; explicit live option | Run one bounded Tier 0 read (foundation, reporting, or matching lane) through the kernel |
| `target verify` | Offline identity check; explicit live option | Verify a supplied offline fixture or one live Demo organisation identity |
| `tax-rates list` | Live read | List tax rates in Xero |
| `tracking categories create` | Gated mutation | Create a tracking category in Xero (preview by default; pass --execute to dispatch) |
| `tracking categories list` | Live read | List tracking categories in Xero |
| `tracking categories update` | Gated mutation | Update a tracking category in Xero (preview by default; pass --execute to dispatch) |
| `tracking options create` | Gated mutation | Create one tracking option in Xero (preview by default; pass --execute to dispatch) |
| `tracking options update` | Gated mutation | Update one tracking option in Xero (preview by default; pass --execute to dispatch) |
| `users list` | Live read | List users in Xero |

## Offline demonstration

The `target plan` / `target apply` pair is an opt-in, conservative lane that only
creates DRAFT invoices and manual journals. The direct commands (for example
`invoices create`, with preview by default and `--execute` to dispatch) are the
general path.

```sh example:offline-demo
npm run demo:offline
```

This uses checked-in synthetic fixtures and reports zero dispatches. It accepts no
execution option. See the [demo journey](docs/demo-journey.md).

## Troubleshooting and support

- Use Node 24 or newer; rerun the clean install if dependencies do not load.
- Missing profiles require setup. Legacy unbound tokens, a changed OAuth client ID,
  a removed/replaced profile or an unreadable key require login. Never relabel old
  tokens or copy them between profiles.
- If callback port 8742 is busy, the browser fails or login times out, fix the cause
  and start a fresh login. Do not share callback URLs or credentials.
- Keep config, tokens, keys and receipt stores private. Current config uses
  `~/.config/ledgerops`; historical discovery may use `~/.config/xero-command-line`.
  Back up private state before moving it.
- Use synthetic reproductions in issue forms. Redact tenant IDs, organisation names,
  client IDs, tokens and private paths.

Report vulnerabilities through [SECURITY.md](SECURITY.md). See
[CONTRIBUTING.md](CONTRIBUTING.md) for checks and review requirements and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for community reporting.

## Licence and attribution

LedgerOps builds on the MIT-licensed
[XeroAPI/xero-command-line](https://github.com/XeroAPI/xero-command-line)
project by Regan Ashworth and Xero API. See [LICENSE](LICENSE) and [NOTICE](NOTICE)
for copyright notices and MIT licence terms. LedgerOps is not affiliated with or
endorsed by Xero.
