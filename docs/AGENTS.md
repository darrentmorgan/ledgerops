# Documentation guidance

The public repository contains the current product roadmap, architecture decisions,
a generated command inventory, and agent process guidance.

- `roadmap.md`: current public product direction.
- `demo-journey.md`: synthetic demonstration guidance.
- `xero-endpoint-inventory.md`: generated shipped command surface and planned capabilities;
  regenerate with `npm run inventory`, never edit by hand.
- `adr/`: architecture decisions; see `adr/AGENTS.md`.
- `agents/`: repository process guidance; see `agents/AGENTS.md`.

Use root `CONTEXT.md` for vocabulary. Describe current gated and immediate commands
truthfully; a future release policy is not evidence that a migration has shipped.
