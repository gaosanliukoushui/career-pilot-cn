# CareerPilot CN GitHub Actions

CareerPilot CN keeps only workflows that are valid for this private derivative
repository and do not require upstream-only secrets or publishing authority.

## Active checks

- Project tests
- Web typecheck and build
- User-data/privacy scanning
- Dependency review and repository maintenance checks

## Intentionally disabled upstream workflows

- `gh-events-feed`: requires the upstream project's Discord webhook.
- `release-please`: publishes the upstream npm package and requires permission
  to create release pull requests.
- `CodeQL`: private-repository SARIF uploads require Code Scanning/GitHub
  Advanced Security to be enabled for this repository.

Reintroduce these workflows only after the corresponding CareerPilot CN secret,
release policy, or GitHub security entitlement has been configured.
