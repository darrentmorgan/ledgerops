# Security Policy

## Supported versions

LedgerOps CLI is an alpha; the current package version is `0.1.0`.

| Version | Security support |
| --- | --- |
| Latest `main` commit (currently `0.1.0`) | Supported; fixes land here |
| Older commits and releases | Unsupported; update to the latest `main` |

This policy does not imply that a release has been published.

## Reporting a vulnerability

Do not open a public issue for a security problem.

Use GitHub private vulnerability reporting on this repository:
[Report a vulnerability privately](https://github.com/darrentmorgan/ledgerops/security/advisories/new)
(Security tab → Report a vulnerability). If the form is unavailable, open a public
issue asking for a private contact, without any vulnerability details.

Include:

- The exact command you ran and what happened.
- The affected commands or component.
- Your OS and Node version.
- A minimal reproduction if you can.

Do not include real access tokens, refresh tokens, passphrases, or customer
accounting data in a report. Redact tenant IDs and organisation names as well.
Use an offline, synthetic reproduction where possible; do not access an
organisation or system without its owner’s authorisation.

## What we promise

This is best-effort maintenance of an alpha project. There is no response-time target,
no bug bounty, and no guaranteed fix date. Reports are reviewed as maintainer availability
allows; any follow-up happens privately, and reporters can request credit.

## Scope notes

In scope:

- Token storage and encryption at rest under the local configuration directory (`~/.config/ledgerops/`, with
  historical `~/.config/xero-command-line/` discovery where applicable).
- The OAuth PKCE flow and its local callback server.
- Credential leakage between profiles.
- Command injection or unsafe file handling in CLI commands.

Out of scope:

- Xero's own API, services, and infrastructure. Report those to Xero.
- Other software on the machine running the CLI.
- Social engineering.
