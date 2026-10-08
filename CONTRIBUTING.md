# Contributing to LedgerOps CLI

This guide covers setup, testing, issues and pull requests.

LedgerOps CLI builds on [XeroAPI/xero-command-line](https://github.com/XeroAPI/xero-command-line)
by Regan Ashworth and Xero API (MIT). That upstream attribution stays visible in
[`LICENSE`](LICENSE), [`NOTICE`](NOTICE), [`README.md`](README.md), and
[`package.json`](package.json) — please keep it intact.

Participation follows the [Contributor Covenant](CODE_OF_CONDUCT.md).

Keep organisation-specific workflows in your own repositories and drive LedgerOps
through its CLI. Keep real organisation names, identifiers, credentials, and
internal records out of contributions.

## Prerequisites

- Node.js 24

## Setup

```bash
git clone https://github.com/darrentmorgan/ledgerops.git
cd ledgerops
npm ci          # clean install from package-lock.json
npm run build   # type-check and emit dist/
```

To run the CLI from source without a build step:

```bash
npm run dev -- <command> [args]
```

## Tests

The suite runs offline against synthetic fixtures:

```bash
npm test            # single run (Vitest)
npm run test:watch  # watch mode
```

Two rules for tests:

- Keep them offline and synthetic. Never commit tenant data, access tokens, client IDs,
  passphrases, or key material.
- Add or update tests for any behaviour change you make.

## Checks before every pull request

```bash
npm run format
npm run lint
npm run typecheck
npm run build
npm test
npm run inventory:check
npm audit --omit=dev
npm run pack:check
npm run pack:smoke
git diff --check   # no whitespace errors
```

Biome is the single formatter and linter. Use `npm run format:write` to apply
formatting, then inspect the diff. All checks above must pass. CI checks Node 24 on
Linux, macOS, and Windows (see [.github/workflows/ci.yml](.github/workflows/ci.yml)).

## Reporting issues

1. Search [existing issues](https://github.com/darrentmorgan/ledgerops/issues) first.
2. When opening a new issue, include:
   - The exact command you ran (`ledgerops ...`).
   - What you expected and what actually happened.
   - Your CLI version or commit, OS, and Node version.
3. Redact anything sensitive: tokens, organisation names, tenant IDs, tenant data, client IDs. Use synthetic reproductions only.

Report vulnerabilities privately through
[SECURITY.md](SECURITY.md). Never open a public issue
for a vulnerability.

## Pull requests

1. Branch from `main` with a short conventional name, e.g. `fix/38-token-refresh-race`.
2. Keep the change small and focused.
3. Include tests for behaviour changes.
4. Describe operator-visible changes: new or changed commands, flags, output formats,
   storage locations, or security posture. Update `README.md` and `SKILL.md` whenever
   the documented command surface changes.
5. Preserve the mutation gate: a gated command previews without API calls and
   dispatches only with `--execute`; `--yes` alone never dispatches. Do not introduce
   an immediate command. Preserve the separate fail-closed offline `target verify`,
   `target plan`, and `target apply` contracts. See [ADR-0013](docs/adr/0013-preview-by-default-execution-gate.md),
   and [ADR-0016](docs/adr/0016-update-previews-are-payload-only.md).
6. Run the checks above, then open the pull request against `main`.

Every path requires maintainer review before merge, including documentation and
repository configuration. [CODEOWNERS](.github/CODEOWNERS) names the maintainer.
This is a contribution policy: CODEOWNERS assigns ownership but does not itself
enforce approval. GitHub enforcement depends on the repository ruleset.
As the maintainer's own workflow, an independent reviewer (the maintainer or a delegate) verifies the final change.
Contributors need only address review findings and rerun affected checks after edits. Do not merge your own unreviewed contribution.

Commit subjects follow Conventional Commits style (`feat:`, `fix:`, `docs:`, `chore:`),
matching the existing history.

## License

By contributing you agree that your contributions are licensed under the MIT License in
[`LICENSE`](LICENSE).

Preserve the upstream copyright line, the maintainer copyright line, and the
MIT licence text. Retain upstream attribution to XeroAPI/xero-command-line and
Regan Ashworth in LICENSE, NOTICE, README, and package metadata. Keep the statement
that LedgerOps is not affiliated with or endorsed by Xero, and do not add Xero logos.
