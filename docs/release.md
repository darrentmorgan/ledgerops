# CI and releases

Every pull request runs `CI / Node 24 / ubuntu-latest`, `CI / Node 24 / macos-latest`,
and `CI / Node 24 / windows-latest`. Each checks formatting, lint (including warnings),
types, build, offline tests, generated inventory, production dependency audit, and
package contents including upstream attribution, then installs the packed tarball into
an isolated prefix and runs its `ledgerops --help` and `invoices create --help` with
credential and network access refused. Actions are pinned to full commit IDs.
Dependabot groups npm and GitHub Actions updates separately with a seven-day cooldown.

Release runs only for `v*` tags and requires the tag to equal `v` plus the package version.
The `npm-release` environment must require a reviewer before publishing. The workflow
also checks that protection exists and refuses if it cannot verify it. It uses GitHub
OIDC and `npm publish --provenance`; no stored npm token is used.

Before the first release, an operator must configure the npm trusted publisher for
`darrentmorgan/ledgerops`, workflow `release.yml`, environment `npm-release`, and verify
that the repository visibility supports npm provenance. See the
[npm trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/).
No release or trusted-publisher configuration is performed by the CI change.

## Release PR automation

`release-please.yml` runs on pushes to `main` and opens or updates a release PR.
The Node manifest starts from the current package version, `0.1.0`; the first
`v0.1.0` tag and npm publication remain a separate operator step. Later proposals
bump the version from that baseline and update `package.json`, `package-lock.json`,
the manifest, and the existing `CHANGELOG.md`. Conventional commit types from the
repository history (`feat`, `fix`, `docs`, `ci`, and `chore`) have explicit changelog
sections, along with performance, refactoring, test, and build changes.

Merging a release PR lets release-please create its GitHub release and `v*` tag on
the next `main` push run. The tag triggers the existing `release.yml`; npm publishing
still requires approval through `npm-release`. The release-please workflow has no
npm publication step and does not merge its PRs. Its generated PR body warns to hold
the first release PR until npm setup and the separate initial release are complete.

Before enabling automation, set the repository Actions secret `RELEASE_PLEASE_TOKEN`
to a fine-grained token restricted to `darrentmorgan/ledgerops`, with Contents,
Pull requests, and Issues read/write permissions (Issues is used for release labels).
Keep it out of the repository and maintain its expiry. The workflow grants the
automatic `GITHUB_TOKEN` no permissions. A missing or invalid secret fails the action;
there is no fallback to `GITHUB_TOKEN`, whose generated PRs and tags would suppress
CI and the publish workflow. This requirement follows the
[release-please action documentation](https://github.com/googleapis/release-please-action#other-actions-on-release-please-prs).
This change does not provision that token, configure npm, create tags, or publish.
