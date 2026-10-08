## Problem and result

What problem does this solve, and what changes for the operator?

## Command and output changes

List changed commands, flags, output formats, storage locations, or security
behavior (or write "none"). Update README.md and SKILL.md when the command surface
changes.

## Checks and safety

- [ ] Ran the [contributor checks](https://github.com/darrentmorgan/ledgerops/blob/main/CONTRIBUTING.md#checks-before-every-pull-request); list results or explain any checks not run below.
- [ ] Added or updated offline tests for behavior changes, or explain why none are needed.
- [ ] Used only synthetic data; included no real organisation data, identifiers, credentials, or key material.
- [ ] Verified affected mutation gates: preview makes zero API calls, `--execute` dispatches, and `--yes` alone never dispatches; preserved fail-closed `target verify`, `target plan`, and `target apply` behavior (or explain why not applicable).

Check results and safety verification (including any not-applicable items):
