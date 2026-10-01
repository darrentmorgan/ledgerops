@AGENTS.md

## Claude Code adapter

- When this repository is used as the `ledgerops` skill, read `SKILL.md` together
  with the source and tests, and prefer commands demonstrated by the implementation.
- For any request that may reach Xero, report the exact selected profile and organisation
  before a write and wait for explicit approval; never infer identity from prior context.
- Keep Claude-facing examples aligned with `README.md` and `package.json`; never copy
  token, passphrase, or other credential values into prompts, fixtures, or tracked files.
