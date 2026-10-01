# Automation through the CLI

Keep automation and its private inputs outside the public repository. Invoke the
installed CLI as a child process with an argument array, capture stdout and stderr
separately, and check its exit status. Use documented commands and JSON contracts;
there is no supported TypeScript SDK or permission to import internal modules.

Choose the explicit profile after confirming its organisation. Pass that profile
on each live command. Never rely on an environment-selected default, replace a
profile during a run, or retry an uncertain write automatically.

## Synthetic preview

After creating the synthetic profile in the README, this command is a local
payload preview. It does not authenticate or write:

```sh example:automation-preview
ledgerops invoices create --profile synthetic-docs --type ACCREC --contact-id 00000000-0000-0000-0000-000000000001 --description Synthetic --quantity 1 --unit-amount 10 --account-code 200 --tax-type NONE --json
```

Require `schemaVersion: "ledgerops.mutation-preview.v1"`,
`willDispatch: false`, the expected profile and payload. Store the digest with the
reviewed input. Direct execution returns a resource or null, not this envelope.
Execution flags do not turn synthetic IDs into valid live inputs.

For real work, the caller obtains authority for the precise target and payload
before requesting execution. Machine JSON execution does not prompt. A fresh
process may observe changed configuration or remote state; comparing a previously
saved digest alone is not a cross-process authorisation or replay protocol.

## Offline plan and apply rehearsal

The repository's `test/commands/target.test.ts` constructs fresh synthetic identity
and plan files, invokes the built target planner, and passes its exact confirmation
to the built in-memory apply tracer. It asserts a verified result, one receipt,
redacted tenant output and zero network attempts for every child process. Run it
after building:

```sh example:target-rehearsal
npx --no-install vitest run test/commands/target.test.ts
```

This exercises the offline contract only. For the exact supported target flags:

```sh example:target-help
ledgerops target verify --help
ledgerops target plan --help
ledgerops target apply --help
ledgerops target read --help
```

The explicit live read modes are different operations. They require a real
verified identity and authorised access; this guide does not run them.

## Boundary and failure handling

Keep credentials, accounting inputs and receipts in private storage. Redact tokens,
tenant IDs and organisation names before sharing diagnostics. Treat nonzero exit,
missing output, malformed JSON, unexpected schema or a refused/uncertain outcome
as a stop requiring review. Do not infer success from an empty stderr stream.
