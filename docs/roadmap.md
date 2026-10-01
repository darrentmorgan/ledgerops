# LedgerOps roadmap

LedgerOps is a standalone open-source CLI for Xero, forked from
[XeroAPI/xero-command-line](https://github.com/XeroAPI/xero-command-line). Credentials,
profiles, receipts and other operational data stay outside the repository.

Priorities are a consistent preview-by-default mutation gate, truthful command
documentation, durable receipts and replay protection, bounded read coverage,
and a tested Node.js 24 package. All 20 direct mutation commands are gated; no immediate command remains.
The optional guarded target pipeline remains a distinct operator-selected policy.

Update previews describe the submitted payload only; they do not claim to show
a fetched before/after comparison. Release requires independent privacy,
licensing, command-parity, and offline validation.
