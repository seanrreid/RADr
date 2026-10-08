# AGENTS.md

Instructions for anyone, human or AI agent, changing this repository. Read this before writing
code. [README.md](README.md) covers using radr; [PRD.md](PRD.md) is the design of record.

## What RADr is

RAD Review (`radr`, "Read, Address, Debug") is a deterministic code-review CLI for consulting
engagements. **It ships determinism, not intelligence:** pinned tools decide every finding, the
rubric decides every severity, people decide every disposition and gate. An LLM may only
explain and propose, and only when an engagement allows it.

## Commands

```bash
nvm use                          # Node 24 (.nvmrc)
npm ci --ignore-scripts          # always --ignore-scripts (supply-chain rule)
npm run build                    # tsc → dist/
npm run lint                     # eslint, strict type-checked + determinism bans
npm test                         # build + unit tests (fast; no real tools)

# Real-tool e2e (needs a RADR_HOME where `node bin/radr.js tools install` ran):
RADR_E2E_TOOLS=$RADR_HOME npm test
# Sandbox e2e (Podman or Docker running, stack images built):
RADR_E2E_TOOLS=$RADR_HOME RADR_E2E_SANDBOX=1 npm test
# Real-agent eval (opt-in, costs money; see README "The LLM lane"):
RADR_E2E_AGENT=1 RADR_AGENT_CMD='[...]' npm test
# Rule pack check (CI runs it):
OPENGREP="$(ls $RADR_HOME/tools/opengrep/*/opengrep_* | head -1)" node dist/scripts/check-rules.js
```

Before you finish a change: `npm run build && npm run lint && npm test` all pass.

## Repository map

| Path | What |
|---|---|
| `src/core/` | determinism (`canonicalJson`, `hash`, `stableSort`), injected clock, exec (no shell), errors |
| `src/engagement/` | engagement folder, `engagement.yml`, scope, source mirror and read-only worktree |
| `src/lanes/` | the lanes (census, lint, secrets, sca, history, tests, types, coverage, sast, maint, license, iac, hygiene) |
| `src/normalize/` | tool output → findings (pure adapters) |
| `src/findings/` | findings store, dispositions, judgment findings, package grouping |
| `src/rubric/` | severity: the only place a severity is computed |
| `src/review/` | the review runner, coverage gaps, readiness, scope snapshots |
| `src/address/` | scorecard, report templates, remediation plan, Gate 2, PDF render |
| `src/llm/` | the LLM lane: one gate (`policy.ts`), redaction, triage, drafting |
| `src/debug/` | the Debug workflow (repro, bisect, hypotheses, guard) |
| `src/verify/`, `src/diff/` | `radr verify`; the PR-review (`diff`) tier, baseline, SARIF |
| `src/state/` | hash-chained event log, gates, fingerprint, folds |
| `policy/` | `matrix.yml` (lane outcome → action), `gates.yml` |
| `rubric/` | `v0.yml`, `v1.yml`, `v2.yml` (published rubrics are never edited) |
| `rules/` | vendored and authored Opengrep rules, with fixtures and provenance |
| `toolchain/` | pinned tool manifests, sandbox images, configs (generated, see below) |
| `themes/` | report themes (Typst) |
| `docs/mN-plan.md` | milestone plans with "As built" sections and open items |

## Non-negotiable conventions

**Determinism.** Same scope, same findings: byte-identical across machines, timezones, locales.
- Serialize with `canonicalJson`, hash with `hash`/`hashBytes`, sort with
  `stableSort`/`compareCodePoints` (all in `src/core/determinism.ts`).
- Time comes from the injected `Clock`, never `Date.now()` or `new Date()`.
- No floats in hashed or reported content: integers, basis points, tenths, or decimal strings.
- ESLint bans `localeCompare`, `Intl`, `createHash`, `JSON.stringify`, and `Date.now` outside
  their owning modules. Don't disable the rule; use the helper.

**Authority.**
- Every lane outcome resolves through `policy/matrix.yml`, with no default fallthrough. A new
  lane or outcome fills its whole row or column.
- Gates are folds over the hash-chained `events.jsonl`. **Event schemas are additive only:** a
  new field is optional, an existing field never changes type or becomes required.
- Severity comes only from the rubric (`src/rubric/rubric.ts`). Every (tool, tool_severity) pair
  is mapped explicitly; an unmapped pair throws. A published rubric file is never edited: a
  change ships as a new version (`v3.yml`) and new scopes opt in.
- The LLM never decides. Code under `src/llm/` can't import the findings store, dispositions,
  rubric, or gates, and can't append a decision event (ESLint enforces this).

**Tools and evidence.**
- Every tool runs with radr's own configuration, never the client's: client config files and
  inline suppressions (`eslint-disable`, `noqa`, `nosemgrep`, `gitleaks:allow`,
  `.gitleaksignore`) can't hide a finding.
- Processes run through `src/core/exec.ts`: no shell, an environment allowlist, a timeout and
  an output cap, hashed output.
- Adapters are pure functions of tool output, golden-tested (`test/golden/`, regenerate with
  `UPDATE_GOLDEN=1` and review the diff), and throw `ParseError` on anything unexpected.
- Raw tool output is kept under the engagement's `raw/` and never edited.
- A check that ran and saw nothing is "not assessed", never "good": lanes record what they
  covered, and the report says what wasn't assessed.

**Client-facing text.** Reports state facts neutrally. Consultant how-to-fix hints go to the
CLI (lane details), not the client report. Placeholder prose never reaches a client (Gate 2).

**Dependencies.** At most 8 runtime dependencies, each justified in
`docs/dependencies.md`. Prefer Node built-ins.

**Generated files.** Pins are produced by scripts, never typed by hand:
`scripts/pin-toolchain.ts` → `toolchain/manifest.yml`; `scripts/pin-images.ts` →
`toolchain/sandbox-images.yml`; `scripts/pin-sandbox-tools.ts` →
`toolchain/sandbox-tools.yml`; `scripts/pin-rubocop.sh` → RuboCop's `Gemfile.lock`;
`scripts/pin-pytools.ts` → `toolchain/py-tools/requirements.txt`; `scripts/pack-rules.ts` →
`rules/`. Files under `rules/lgpl/` are never modified (hash-checked).

## Tests

- `test/unit/`: fast, no real tools. Helpers in `test/helpers/`: a fake toolchain
  (`fake-toolchain.ts`), deterministic fixture repos (`fixture-repo.ts`), a scripted fake LLM
  agent (`fake-agent.ts`), a host stand-in for the sandbox (`local-sandbox.ts`, no isolation).
- `test/e2e/`: real tools and real sandboxes, opted into by environment variable.
- `test/fixtures/` and `rules/**` fixtures contain deliberately vulnerable code. Leave it.
- Golden reports per engagement type live in `test/golden/reports/`.
- When a test helper creates temp directories, create them at module level, not inside a
  `before()` hook (the cleanup hook would fire before the tests run).

## Workflow

- New work starts as a plan in `docs/mN-plan.md` (goal, decisions, acceptance criteria,
  waves), agreed with the project owner before building. After building, add an "As built"
  section: AC status, decisions made while building, open items.
- One commit per wave: `feat(mN/wave-K): …`, `fix(scope): …`, `docs(…): …`. Commit messages
  explain why, not just what. Write multi-line messages to a file and use `git commit -F`.
- Decisions the owner has made are recorded in the plans; don't reopen them without asking.

## Gotchas

- **Opengrep:** crashes under `LC_ALL=C` (use `C.UTF-8`); use `--no-rewrite-rule-ids`, or rule
  IDs embed absolute paths; one invalid rule aborts a whole batch test; concurrent runs need
  their own `HOME`.
- **osv-scanner:** the v2 offline DB layout is `<dir>/osv-scalibr/<Ecosystem>/all.zip`; a
  missing ecosystem is a generic exit 127 (the sca lane names it); always pass
  `--no-call-analysis=all --no-resolve`.
- **macOS:** `/var` resolves to `/private/var`, so lanes use the worktree's realpath; Podman
  machines share the home directory, not `/tmp` (put sandbox mounts under the engagement).
- **Build tools:** Maven and Gradle resolvers hang on file locks over virtiofs mounts (warm into
  container-local storage, then copy); `go test` runs vet by default (tests pass `-vet=off`).
- **Analyzers:** lizard drops byte-identical files when given a directory (pass a sorted file
  list); ScanCode must skip lockfiles; PHPStan resolves `excludePaths` relative to its config;
  jscpd 5 uses `--exit-code`, its entry point is `run-jscpd.js`, and it must skip lockfiles,
  docs and tests; Checkov reads `.checkov.yaml` from `-d DIR` and its cwd.
- **Downloads:** fetch Maven from Maven Central (verified against Apache's sha512); the Debian
  apt snapshot in `src/toolchain/image.ts` must not predate the base image.
- **`.gitignore`** ignores `*.log` except under `test/golden/`, where logs are fixtures.
