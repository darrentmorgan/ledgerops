# Offline demonstration

Use Node.js 24. From the repository root, install dependencies once with
`npm ci` (installation may need network access), then run:

```sh
npm run demo:offline
```

The demonstration itself needs no network or credentials. It reads only the
checked-in synthetic identity and two invoice rows in `fixtures/offline-demo/`.
It uses the production invoice-batch planner and mutation preview gate used by
`invoices batch`, with a fixed synthetic clock for a repeatable manifest digest.
It does not invoke the CLI credential resolver or create a saved profile.

The JSON preview shows `profile: "synthetic-offline-demo"`, `operation:
"batch-create"`, both invoice rows, and `payload.manifestDigest` matching
`payloadDigest`. `willDispatch` is `false`; stderr reports `0 dispatches` and
the process exits successfully. No OAuth, browser, token store, receipt store,
or live transport is used. The harness accepts no arguments, including
`--execute`. The fixture identity is synthetic and is not live verification.

For repository checks, run `npm run build` and `npm test`.
Run `node bin/run.js --help` to show the CLI command surface.

Use synthetic fixture data for demonstrations. All direct mutation commands are gated and preview by
default. ADR-0012 assigns execution policy to the operator; ADR-0013 defines
`--execute` and confirmation semantics. Verify the selected
organisation and operator authority before any live action. Show the exact
preview and its target before requesting execution, then read back the result.
