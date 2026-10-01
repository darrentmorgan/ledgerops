# CI and releases

Every pull request runs `CI / Node 24 / ubuntu-latest`, `CI / Node 24 / macos-latest`,
and `CI / Node 24 / windows-latest`. Each checks formatting, lint (including warnings),
types, build, offline tests, generated inventory, production dependency audit, and
package contents including upstream attribution. Actions are pinned to full commit IDs.
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
