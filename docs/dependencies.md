# Runtime dependencies

Budget: **at most 8 runtime dependencies** (PRD §15). `scripts/check-deps.ts` fails CI
if a runtime dependency is missing from this file, if the budget is exceeded, or if any
locked package declares an install script that isn't in
`scripts/install-script-allowlist.json`.

Every entry states why a Node built-in isn't enough, and what pins it. Dev dependencies
are not listed (they don't ship), but they follow the same `npm ci --ignore-scripts`
rule.

Entries are added in the same commit that adds the dependency to `package.json`.

## Current (2 of 8)

### ajv

- **Version:** 8.20.0 (exact)
- **Why:** JSON Schema validation for events, findings, `engagement.yml`, policy files,
  and (M4) LLM output. Node has no JSON Schema validator, and hand-written checks for
  every record type would be larger and harder to review than declarative schemas.
- **Transitive:** fast-deep-equal, fast-uri, json-schema-traverse,
  require-from-string. None has an install script.
- **Use:** strict mode. No `ajv-formats`: string formats are written as regex patterns.

### yaml

- **Version:** 2.9.1 (exact)
- **Why:** parsing `engagement.yml`, `policy/*.yml`, the rubric, rule targets, and the
  toolchain manifest. Node has no YAML parser.
- **Transitive:** none.
- **Use:** YAML 1.2 core schema, unique keys required, aliases rejected.
