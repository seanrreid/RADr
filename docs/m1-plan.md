# M1 Plan: Deterministic core + first lanes

**Status:** draft
**Source:** [PRD.md](../PRD.md) §19 (M1), §15 (implementation), §7–§8 (gates, data model)
**Date:** 2026-10-07

## Goal

One deterministic, end-to-end pipeline on a **TS/JS + Python** codebase, with no LLM:

```
radr init → radr scope --source <fork> → radr approve scope → radr review
          → radr findings → radr disposition → radr status
```

When it works, running the same approved scope twice (in fresh `RADR_HOME`s, under
different `TZ`/`LANG`) produces the **same findings-set hash**.

## In scope

- TypeScript project skeleton, CI, dependency budget
- Determinism utilities (§15) and property tests
- Event log, matrix, Gate 1, scope fingerprint
- Source snapshot (mirror clone + read-only worktree)
- Host-mode toolchain: manifest, verified install, `doctor`, OSV DB snapshot
- Lanes: `census` (scc), `lint` **baseline mode** (eslint, ruff), `secrets`
  (gitleaks, full history), `sca` (osv-scanner offline + syft)
- SARIF/JSON normalization, fingerprinting, dedupe, stable IDs
- Rubric **v0** (tool-severity passthrough table, so `severity` is populated)
- Single-finding dispositions; `findings`, `status`
- LLM policy `off` only, enforced by a trap test

## Out of scope (later milestones)

- Build sandbox, `types`, lint project mode, `coverage` (M2)
- Rubric v1, auto-confirm, bulk disposition, `triage` tier, Address, Gate 2,
  PDF (M2)
- Container image and the other lanes and stacks (M3)
- LLM lane (M4), Debug (M5), `diff` tier and `verify` (M6)

---

## Conventions

- **`RADR_HOME`** (default `~/radr`): `engagements/`, `tools/`, `snapshots/`.
- **Exit codes:**
  - `0` ok
  - `1` refused or check failed (gate, fingerprint, drift)
  - `2` usage or config error
  - `3` internal error

  Every non-zero exit prints one line to stderr naming the reason.
- **Actor identity:** `RADR_ACTOR`, else `git config user.email`. If neither is
  set, gate and disposition commands refuse to run.
- **No ambient time:** `clock` is injected. Timestamps appear only in events and run
  metadata, never in hashed content.
- **Secrets are never persisted in clear:** gitleaks always runs with `--redact`.
  Findings store a redacted snippet plus a salted hash of the match, used for
  dedupe. The salt is per engagement and lives in the engagement folder.

## Repo layout

```
src/
  cli/main.ts, cli/commands/*.ts        # one file per command; thin
  core/determinism.ts                   # canonicalJson, stableSort, hash, normalizePath, normalizeSnippet
  core/clock.ts, core/errors.ts, core/exec.ts
  state/events.ts                       # append, read, verify chain, fold
  state/gates.ts, state/fingerprint.ts
  matrix/matrix.ts, matrix/matrix.yml
  engagement/init.ts, scope.ts, source.ts, detect.ts
  toolchain/manifest.ts, install.ts, doctor.ts, db-sync.ts
  lanes/lane.ts, lanes/runner.ts, lanes/{census,lint,secrets,sca}/
  normalize/sarif.ts, normalize/adapters/{eslint,scc}.ts
  findings/store.ts, findings/ids.ts, findings/disposition.ts
  rubric/rubric.ts
  llm/policy.ts                         # M1: off only
schemas/*.schema.json                   # event, finding, engagement, matrix, rubric, manifest
toolchain/manifest.yml                  # tool versions + per-platform URL + sha256
toolchain/configs/{eslint,ruff}/        # radr baseline configs (pinned)
toolchain/node-tools/                   # package.json + lockfile for eslint baseline (installed --ignore-scripts)
rubric/v0.yml
test/unit/, test/golden/<tool>/, test/e2e/, test/fixtures/
scripts/check-deps.ts, scripts/make-fixture-repo.sh
docs/dependencies.md
```

---

## Acceptance criteria

- **AC1:** `npm ci --ignore-scripts && npm run build && npm test` passes from a clean
  clone. TS runs with `strict`, `noUncheckedIndexedAccess`, and
  `exactOptionalPropertyTypes`.
- **AC2:** CI fails if there are more than 8 runtime dependencies, if any runtime
  dependency is undocumented in `docs/dependencies.md`, or if any lockfile entry has
  an install script that isn't allowlisted.
- **AC3:** Determinism property tests pass: shuffled keys, shuffled arrays fed to
  `stableSort`, CRLF vs LF, and differing `TZ`/`LANG` all produce identical hashes.
  `canonicalJson` rejects `undefined`, `NaN`, `Infinity`, and non-plain objects.
- **AC4:** A lint rule blocks `localeCompare`, `Intl.Collator`, and
  `JSON.stringify` inside hashing code outside `core/determinism.ts`.
- **AC5:** The event log is append-only and hash-chained (each event carries
  `prev`). `radr` refuses to fold a log whose chain is broken or edited (exit 1).
- **AC6:** The matrix rejects unknown `(lane, outcome)` pairs (it throws). A test
  asserts every declared outcome has an entry.
- **AC7:** `radr scope --source <path>` creates the mirror clone and a read-only
  worktree at the chosen SHA, detects TS/JS and Python, and writes a
  schema-valid `engagement.yml`.
- **AC8:** `radr approve scope` writes a `scope-approved` event containing the
  fingerprint, which covers every field in PRD §7 that is present in M1.
  Changing any of those fields makes `radr review` refuse with exit 1.
- **AC9:** Before every lane, `radr review` re-checks three things: that the gate
  exists, that the fingerprint matches, and that the worktree HEAD equals the
  approved SHA.
- **AC10:** `radr tools install` downloads only manifest-listed artifacts and
  verifies each sha256. `radr doctor` detects a missing tool and version or checksum
  drift, which surfaces as a `version-drift` or `tool-missing` outcome.
- **AC11:** `radr db sync` writes an OSV snapshot for npm and PyPI and records its
  hash and date in `snapshots.lock`. The `sca` lane runs with `--offline` against
  it.
- **AC12:** Each lane stores its untouched tool output under `raw/<lane>/` and emits
  `lane-started` and `lane-completed` events carrying the outcome, exit code, and
  output hash.
- **AC13:** Normalization produces schema-valid findings. Every finding has a
  `raw_ref` that resolves into `raw/`, a deterministic fingerprint, and a stable
  `F-NNNN` ID: an ID is assigned once per fingerprint, in sorted fingerprint order,
  and reused on re-runs.
- **AC14:** Rubric v0 maps every `(tool, tool_severity)` emitted by M1 tools to a
  radr severity. An unmapped pair is an error, never a default.
- **AC15:** The disposition state machine accepts only the transitions in the
  table, requires a reason for `dismissed` and `waived`, and records the actor.
- **AC16:** With LLM policy `off`, the full pipeline never executes the agent
  command. Tested with a trap `RADR_AGENT_CMD` that fails the test if invoked.
- **AC17:** In the e2e test on the fixture repo, findings include:
  - a planted secret that exists only in history
  - a known-vulnerable npm package and a known-vulnerable PyPI package
  - eslint and ruff findings

  No unredacted secret value appears anywhere under the engagement folder.
- **AC18:** Determinism eval: two full runs in separate `RADR_HOME`s with different
  `TZ`/`LANG` produce identical findings-set hashes (`radr findings --hash`).

---

## Wave plan

Tasks within a wave are independent. Each wave depends on the one before it.

### Wave 0: Foundations
- **T0.1 Skeleton.** package.json (ESM, `engines`), tsconfig, eslint, `node:test`
  runner on `dist/`, `.nvmrc`, and a GitHub Actions workflow (install, build, lint,
  test). Validate: AC1.
- **T0.2 Dependency budget.** `scripts/check-deps.ts` and `docs/dependencies.md`,
  seeded with ajv and yaml, wired into CI. Validate: AC2. Edge cases: dev deps
  excluded, a missing doc entry, an install script in a transitive dependency.
- **T0.3 Determinism module.** `core/determinism.ts` plus property tests (fast-check
  as a dev dependency). Validate: AC3, AC4 (custom lint rule or
  `no-restricted-syntax` config).
- **T0.4 Exec wrapper.** `core/exec.ts`:
  - uses `spawn`, never `shell: true`
  - takes argv as an array, an env allowlist, a timeout, and an output size cap
  - returns `{exitCode, stdoutHash, stderrHash, timedOut}`

  Edge cases: binary missing (maps to `tool-missing`), timeout, huge output, a
  non-zero exit that is still valid (e.g., gitleaks exits 1 when it finds leaks).

### Wave 1: State
- **T1.1 Schemas + validation.** JSON Schemas for event, finding, engagement,
  matrix, rubric, and manifest, with ajv compiled once. Validate: invalid fixtures
  are rejected with a field-level message.
- **T1.2 Event log.** Append with fsync and a `prev` hash chain; read with chain
  verification; plus a generic fold. Validate: AC5. Edge cases: empty log, truncated
  last line, edited middle line, concurrent append (lockfile).
- **T1.3 Matrix.** Load `matrix.yml`, resolve, and throw on unknown pairs. Validate:
  AC6.
- **T1.4 Gates.** Fold for `scope-approved`, plus fingerprint comparison. Validate:
  AC8 (unit level).

### Wave 2: Engagement + source
- **T2.1 `radr init`.** Creates the folder layout, the per-engagement salt, and an
  `engagement-created` event. Edge cases: the folder exists, an invalid slug.
- **T2.2 Source snapshot.** `engagement/source.ts`:
  - `git clone --mirror` from a path or URL
  - checkout of the SHA into `source/worktree/`, then chmod the tree read-only
  - SHA verification
  - `radr source fetch`

  Validate: AC7, AC9. Edge cases: dirty source working copy (irrelevant, since we
  mirror), unknown SHA, shallow source (refuse: history is required), submodules
  (record them and don't follow them in M1).
- **T2.3 Stack detection.** Manifests and lockfiles for TS/JS (package.json,
  lockfiles) and Python (pyproject, requirements*, Pipfile.lock, poetry.lock).
  Output is stable-sorted.
- **T2.4 `radr scope` + fingerprint.** Generates `engagement.yml` (tier `standard`,
  M1 lanes, network mode, LLM policy `off`); `state/fingerprint.ts` hashes the PRD §7
  fields. Validate: AC7, AC8.
- **T2.5 `radr approve scope`.** Resolves the actor, writes the event, prints the
  fingerprint. Validate: AC8.
- **T2.6 LLM policy guard.** `llm/policy.ts` exposes `invokeAgent()`, which throws
  under `off`, plus the trap test harness. Validate: AC16.

### Wave 3: Toolchain
- **T3.1 Manifest.** `toolchain/manifest.yml` covering scc, gitleaks, osv-scanner,
  syft, ruff (platform binaries, URL, sha256) and the eslint node-tools lockfile.
  **Each version is pinned and its checksum taken from upstream release assets;
  re-verify the licenses in PRD Appendix A at this step.**
- **T3.2 `radr tools install`.** Downloads, verifies the sha256, installs into
  `$RADR_HOME/tools/<tool>/<version>/`, and runs `npm ci --ignore-scripts` for
  node-tools. Validate: AC10. Edge cases: checksum mismatch (delete and exit 1),
  unsupported platform.
- **T3.3 `radr doctor` + lock.** Writes `toolchain.lock` (versions plus binary
  hashes); the host-lock hash feeds the fingerprint. Validate: AC10.
- **T3.4 `radr db sync`.** Downloads the OSV npm and PyPI databases into
  `$RADR_HOME/snapshots/osv/<date>/` and writes `snapshots.lock`. Validate: AC11.

### Wave 4: Lanes
- **T4.1 Lane runner.** Lane interface `{id, tools, run(ctx) → outcome}`. The runner
  does the pre-lane checks (AC9), writes the events, stores raw output, and resolves
  through the matrix. Validate: AC9, AC12.
- **T4.2 `census`.** `scc --format json` produces a metrics record (not findings).
- **T4.3 `lint` baseline.**
  - **eslint:** run with `--no-config-lookup -c <radr config>`, the typescript-eslint
    parser, and syntax-only rules, emitting JSON.
  - **ruff:** run with `--isolated --config <radr config>`, emitting SARIF.

  Client configs are ignored by design. Edge cases: files that fail to parse
  (recorded as findings, not crashes), no TS/JS files present.
- **T4.4 `secrets`.** gitleaks in `git` mode over `source/mirror.git` with
  `--log-opts="<approved-sha>"`, which scans the full ancestry of the approved SHA
  only. It must not scan all refs: refs change on every `source fetch`, which would
  make the scope non-reproducible. Runs with `--redact`, emitting SARIF.
  Validate: AC17 (history-only secret).
- **T4.5 `sca`.** `osv-scanner --offline --offline-vulnerabilities` against the
  snapshot, emitting SARIF, plus `syft` producing an SPDX JSON SBOM stored as an
  artifact. Validate: AC11, AC17.

### Wave 5: Findings
- **T5.1 Normalization.** SARIF → Finding (gitleaks, ruff, osv-scanner) and JSON
  adapters (eslint). Each gets a golden test: a fixed raw input in
  `test/golden/<tool>/` must produce byte-identical normalized output. Validate:
  AC13.
- **T5.2 Fingerprint, dedupe, IDs.** Fingerprint =
  `hash(tool family, rule_id, normalizePath(file), normalizeSnippet-hash)`. Line
  numbers are excluded so a finding survives shifted code. Prefer engine
  fingerprints where one is provided. Stable ID assignment. Validate: AC13, AC18.
- **T5.3 Rubric v0.** `rubric/v0.yml` passthrough table. Validate: AC14.
- **T5.4 Findings store + `radr findings`.** Append-only `findings.jsonl`, plus
  queries by severity, lane, tool, rule, path, and state. `--hash` prints the
  findings-set hash over the canonical sorted set, excluding run metadata.
- **T5.5 Disposition.** State machine plus `radr disposition <id> <state> --reason`.
  Validate: AC15.
- **T5.6 `radr status`.** Shows the gate state, fingerprint match or drift, the last
  run's lane outcomes, and counts by severity and state.

### Wave 6: End-to-end proof
- **T6.1 Fixture repo generator.** `scripts/make-fixture-repo.sh` builds a git repo
  with **fixed author/committer dates and identities**, so its SHAs are
  deterministic. It contains:
  - a TS file with lint issues and a Python file with ruff issues
  - a fake AWS-format key, committed and then removed
  - a lockfile pinning a known-vulnerable npm package, and a `requirements.txt`
    pinning a known-vulnerable PyPI package
- **T6.2 Fixture OSV DB.** A minimal offline DB containing only the advisories the
  fixture needs, so tests never hit the network.
- **T6.3 E2E test.** Runs the full command sequence against the fixture and asserts
  the expected findings and the absence of the clear-text secret. Validate: AC17.
- **T6.4 Determinism eval.** Two full runs (separate `RADR_HOME`s, `TZ=UTC` vs.
  `TZ=Asia/Kolkata`, `LANG=C` vs. `LANG=de_DE.UTF-8`) must produce equal
  findings-set hashes. Validate: AC18.
- **T6.5 README quickstart.** Covers install, `tools install`, `db sync`, and the
  M1 command sequence.

---

## Risks and checks to do early

1. **Offline osv-scanner DB format.** T6.2 assumes we can build a minimal offline DB
   that osv-scanner accepts. Spike this first in Wave 3. If it fails, use a recorded
   real snapshot checked into test fixtures (and watch its size).
2. **gitleaks determinism on history.** Result order and multi-ref traversal may
   vary. Normalization sorts results, but confirm that the *set* is stable across
   runs (T6.4 will catch it).
3. **eslint without type info** limits the baseline to syntax rules. That's
   acceptable for M1; project mode (M2) adds typed rules.
4. **Read-only worktree vs. tools that write caches** (ruff, eslint). Point every
   cache dir into the engagement's `cache/` via flags or env, and never write into
   the worktree.
5. **Host mode can't enforce offline.** M1 records
   `network_enforcement: declared` (PRD §14.1). Enforced offline arrives with the
   container in M3.

## Exit criteria

All 18 ACs pass in CI on macOS and Linux runners, and `radr findings --hash` matches
across the T6.4 runs.
