# LedgerOps repository guidance

## Scope

- This repository is LedgerOps CLI: a Node.js CLI exposing the practical Xero API through
  PKCE OAuth for humans and coding agents.
- `README.md` is the user-facing command reference; `src/` is the implementation and
  `test/` contains the offline test suite.
- `SKILL.md` is the agent-facing CLI adapter and must remain consistent
  with the supported CLI surface.

## Development

- The published CLI runs on Node.js 24 or newer (`engines` in `package.json`).
- To develop, use Node.js 24, then run
  `npm ci` for a clean dependency install; the Vitest 4 test stack rejects older
  runtimes and odd majors.
- `npm run build` type-checks and emits `dist/`; `npm test` runs the Vitest suite.
- `npm run dev -- <command> [args]` runs the CLI from source without a build.
- Keep tests and fixtures offline and synthetic. Never put tenant data, access tokens,
  client IDs, passphrases, or key material in the repository.

## Xero identity and execution policy

- Any command that reaches Xero can read or change accounting data. Before a live call,
  verify the selected profile with `ledgerops org details` and read back the organisation.
- Use an explicit `--profile <name>` after the target organisation is confirmed. Do not
  silently rely on environment-selected profiles or change the default profile.
- Direct Xero commands are supported capabilities for humans and agents (ADR-0012). The
  operator decides which profiles, commands, and mutation classes a caller may use.
- Mutation contract: `invoices create` and `payments create` preview by default and make
  zero API dispatches without `--execute`; pass `--execute` to dispatch exactly one
  mutation, and `--yes` only answers an interactive confirmation when one is presented
  (it never dispatches alone). A confirmation is presented only when output is
  human-readable and both stdin and stdout are terminals; `--json` execution and piped or
  non-TTY use dispatch exactly once on `--execute` without prompting, prompts write to
  stderr, and machine JSON stays alone on stdout. The interactive `--execute` path renders
  the snapshot-bound preview (target profile, payload digest, summary) to stderr before the
  confirmation, so a user never confirms blind, and the confirmation accepts only an exact
  `yes` (case-insensitive, trimmed). Target resolution precedes payload validation: the
  command resolves the Xero target first (every preview is target-bound), then validates
  the payload; both failure modes are fail-closed and dispatch nothing. All 20 direct mutation commands now use the shared gate; none executes immediately.
  Before any live write,
  verify referenced IDs, summarize the exact mutation and organisation, and obtain the
  authority required by the user's chosen workflow.
- `target verify`, `target plan`, and `target apply` provide optional guarded execution.
  Preserve their fail-closed invariants; do not force unrelated direct commands through
  that policy.
- `invoices batch` runs a CSV batch through the same shared gate: it previews with zero
  dispatches, binds its one confirmation to the sealed `manifestDigest`, and dispatches
  exactly one mutation per member through the ADR-0011 batch executor. A preflight refusal
  or a stale manifest refuses the whole batch with nothing dispatched.
- Read `docs/roadmap.md` for product direction and ADR-0012 for
  the capability-versus-policy decision.
- Keep token storage in the user's local configuration and use the repository only for
  code, documentation, and synthetic fixtures.

## Checks

- For source changes, run `npm run build`, `npm test`, and `git diff --check`.
- Keep command examples aligned with `package.json`, `README.md`, and the implementation;
  do not treat placeholder GUIDs in documentation as live identifiers.
