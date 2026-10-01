# Changelog

## 0.1.0: ledgerops becomes the primary command

- The package installs the single `ledgerops` executable.
- Config discovery reads the historical `~/.config/xero-command-line`
  directory and prefers `~/.config/ledgerops` once it exists. Existing users
  keep their profiles. Legacy tokens without OAuth client binding require a fresh
  login; changing or removing a profile invalidates its cached tokens.
- Gated commands use preview-by-default execution semantics:
  `invoices create` and `payments create` print a preview and make zero API
  calls without `--execute`; `--execute` dispatches exactly one mutation;
  `--yes` only answers an interactive confirmation, presented only when output
  is human-readable and both stdin and stdout are terminals, while piped,
  non-TTY, and `--json` use of `--execute` dispatch once without prompting.
  All 20 direct mutations now use the gate; no immediate mutation remains.
  Invoice batches preview without dispatch and seal tenant provenance before
  execution, then use one freshly checked client for each member's mutation.
  Target planning and synthetic in-memory apply remain a separate offline model;
  explicitly live target verification and reads are API operations.
- Package identity moves to `ledgerops`; upstream attribution to
  [XeroAPI/xero-command-line](https://github.com/XeroAPI/xero-command-line)
  is preserved.
