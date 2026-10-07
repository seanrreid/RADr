# Runtime dependencies

Budget: **at most 8 runtime dependencies** (PRD §15). `scripts/check-deps.ts` fails CI
if a runtime dependency is missing from this file, if the budget is exceeded, or if any
locked package declares an install script that isn't in
`scripts/install-script-allowlist.json`.

Every entry states why a Node built-in isn't enough, and what pins it. Dev dependencies
are not listed (they don't ship), but they follow the same `npm ci --ignore-scripts`
rule.

Entries are added in the same commit that adds the dependency to `package.json`.

## Planned

- **ajv**: JSON Schema validation for events, findings, `engagement.yml`, and LLM
  output (Wave 1). There's no built-in JSON Schema validator.
- **yaml**: YAML parsing for engagement, rubric, matrix, and manifest files (Wave 1).
  Node has no YAML parser.

## Current

_None yet._
