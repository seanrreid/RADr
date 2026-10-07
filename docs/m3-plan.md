# M3 Plan: Container toolchain, security + health lanes, all stacks

**Status:** in progress
**Source:** [PRD.md](../PRD.md) §19 (M3), §14 (toolchain, rule pack, supply chain), Appendix A/B
**Builds on:** [M2](m2-plan.md) (as built)
**Date:** 2026-10-07

## Goal

1. **Enforced offline.** Every static lane runs inside a locally built, checksum-verified
   toolchain image with `--network=none`. `network.enforcement: container` becomes real.
2. **Security and health lanes:**
   - `sast` (Opengrep + the curated rule pack)
   - `maint` (complexity + duplication)
   - `license`
   - `iac`
   - `hygiene`
3. **All PRD stacks:** Go, Rust, JVM (Java/Kotlin), PHP, Ruby, and .NET, alongside TS/JS and
   Python.

## Decisions

- **Image built locally, never pulled from a vendor.** PRD §14.3: `radr tools build-image`
  generates a Containerfile from `toolchain/manifest.yml`, downloads every Linux asset, and
  verifies its sha256 *inside the build*. Python tools install from a hash-locked
  requirements file (`--require-hashes`). The image ID is recorded in `toolchain.lock`.
- **Same-path mounts.** Container mode mounts the worktree, mirror, raw-output dirs, and
  snapshots at their *host* paths. Tools report the same absolute paths in both modes, so
  adapters and fingerprints are mode-independent. Determinism is tested across the two
  modes.
- **New stacks, in this order:**
  - **First,** census, `sca` (osv-scanner already covers Go, crates.io, Maven, Packagist,
    RubyGems, and NuGet; only `db sync` ecosystems change) and `sast` rules.
  - **Then,** per-stack lint/types/coverage in pinned sandbox images, Go first.
- **Rule pack:** permissive seed (Appendix B) with per-file license headers verified by CI;
  `rules/lgpl/` sub-pack unmodified (hash-checked), pending counsel; mandatory fixtures
  (`opengrep test`); a support-bar report against `rules/targets.yml`.

## Acceptance criteria

- **AC1:** `radr tools build-image` builds the toolchain image offline-verifiable: every
  binary's sha256 is checked in the build, Python tools are installed with
  `--require-hashes`, and node-tools with `npm ci --ignore-scripts`. A checksum mismatch
  fails the build.
- **AC2:** With `toolchain.mode: container`, every static lane runs in the image with
  `--network=none`. A lane that tries the network fails, and an eval proves it (PRD
  invariant 9). `network.enforcement: container` is accepted and fingerprinted.
- **AC3:** Host mode and container mode produce identical findings-set hashes on the fixture.
- **AC4:** `sast` runs Opengrep with the versioned pack (hash fingerprinted). Findings carry
  their CWE/OWASP metadata, and the rubric maps them.
- **AC5:** Every rule in the pack carries a license header and provenance. CI rejects
  copyleft or non-redistributable rules outside `rules/lgpl/`, rejects any modification to
  `rules/lgpl/`, and fails on any rule without passing fixtures.
- **AC6:** `radr rules coverage` reports, per stack, which top-10 CWE targets have a rule
  with fixtures (the "supported / partial" label in the methodology section).
- **AC7:** `maint` produces function-complexity findings and repo-level complexity and
  duplication metrics. The scorecard's grey complexity and duplication rows now get values.
- **AC8:** `license` reports dependency and source license findings mapped by rubric v1 §4
  (due-diligence overrides included).
- **AC9:** `iac` runs Checkov and hadolint on IaC/Dockerfiles when present (fully offline).
- **AC10:** `hygiene` runs OpenSSF Scorecard in `--local` mode (offline subset), marked
  optional.
- **AC11:** Go, Rust, JVM, PHP, Ruby, and .NET are detected; `sca` and `sast` work for each.
  Each has a fixture e2e.
- **AC12:** Per-stack sandboxed lint/types/coverage, with pinned images and recipes, for
  each stack where the toolchain allows (see W5 for the matrix).

## Waves

- **W0 — Container toolchain:** Python tool lock; Containerfile generator; `build-image`;
  container exec mode with same-path mounts; enforced `--network=none`; network-denial eval;
  the host-vs-container determinism test.
- **W1 — SAST:**
  - Opengrep pinned
  - rule pack assembly from vetted sources (scripted, per-file license filter)
  - `rules/lgpl/` sub-pack
  - fixtures + `opengrep test` in CI
  - the `sast` lane and adapter
  - `radr rules coverage`
- **W2 — Health lanes:** `maint` (lizard, jscpd); `license` (ScanCode in the image);
  `iac` (Checkov, hadolint); `hygiene` (Scorecard `--local`).
- **W3 — Stacks, static:** detection for the six stacks; OSV ecosystems; census languages;
  a fixture per stack; SAST seed coverage per stack.
- **W4 — Report and rubric:** rubric v1 base entries for the new tools; scorecard
  complexity and duplication; methodology lists the rule pack and its support bar.
- **W5 — Stacks, sandboxed:** pinned images and recipes for golangci-lint, clippy, PMD,
  PHPStan, RuboCop, and dotnet analyzers, plus coverage where practical.
- **W6 — E2E, docs, and as-built.**

## As built (2026-10-07)

### Acceptance criteria

| AC | Status | Evidence |
|---|---|---|
| AC1 image build, offline-verifiable | ✅ | `radr tools build-image`; fetch.py checks every sha256; `--require-hashes`; `npm ci --ignore-scripts` |
| AC2 container mode, network denied | ✅ | e2e: static lanes in the image + network-denial eval |
| AC3 host = container findings | ✅ | e2e: identical findings-set hashes (including `maint`) |
| AC4 sast with the versioned pack | ✅ | rule-pack hashes in `toolchain.lock`; CWE/OWASP tags; rubric mapping |
| AC5 provenance, licenses, fixtures | ✅ | `scripts/check-rules.ts` in CI (349 rules, every fixture passes) |
| AC6 support bar | ✅ | `radr rules coverage`; all 8 stacks supported; stated in the report methodology |
| AC7 maint + scorecard rows | ✅ | lizard/jscpd findings; `complex_functions_pct`, `duplication_pct` |
| AC8 license + DD overrides | ✅ | ScanCode + SBOM; rubric §4b classes; §4c due-diligence step |
| AC9 iac offline | ✅ | Checkov + hadolint in the image; e2e planted signals |
| AC10 hygiene optional | ✅ | Scorecard offline subset; the matrix row never makes a run partial |
| AC11 six stacks detected; sca + sast each | ✅ | polyglot e2e: every advisory and planted SAST signal found |
| AC12 per-stack sandboxed lint/types/tests | ✅ (coverage % for Go only) | stack sandbox e2e; see the W5 table |

### W0 — Container toolchain

The toolchain image is built locally from a generated Containerfile:
- a pinned base
- apt from a fixed Debian snapshot
- every binary sha256-checked during the build
- Python tools installed with `--require-hashes`

Container mode (`network.enforcement: container`) runs static lanes in the image with
`--network=none` and same-path mounts. The image ID is locked in `toolchain.lock`.

### W1 — SAST

Opengrep 1.30.1 runs with `--no-rewrite-rule-ids` and a UTF-8 locale. The pack is built by
`scripts/pack-rules.ts` from pinned GitLab sast-rules and elttam commits. Each file is
classified by its own license header (MIT/Apache-2.0 into `rules/pack`, LGPL-3.0 into
`rules/lgpl`), and a rule is kept only if it passes its own fixtures. `PROVENANCE.lock`
records every file, and `check-rules` re-verifies it in CI.

### W2 — Health lanes

- **`maint`** (host and container). lizard 1.24.1 gets an explicit, sorted file list,
  because given a directory it walks in filesystem order and silently drops byte-identical
  files. In host mode it is installed with `pip --target` from the same hash lock as the image
  (lizard, pathspec, pygments) and run as `python3 -m lizard`. `doctor` locks it like any tool,
  so the host's `python3` is now a prerequisite. jscpd 5.4.0 (a Rust rewrite; new CLI) comes
  from node-tools. Findings are CCN > 15 (low) / > 30 (medium) and clones (info). Metrics
  fill the scorecard's `complex_functions_pct` and `duplication_pct` rows (AC7). `maint` joins
  the triage lane set and the rubric's auto-confirm lanes.
- **`license`** (container only). ScanCode reports source licenses, and the sca lane's SBOM
  for the same run reports dependency licenses that syft reads from lockfiles. Classes are
  defined in rubric v1 §4b:
  - class assignment works by exact SPDX id or `prefix*`
  - AND takes the worse class, OR the better one
  - `WITH` a linking exception caps the class at weak-copyleft
  - unmapped ids are `unknown`, never guessed

  Permissive licenses and the engagement's `client_licenses` are never flagged. §4c raises
  license findings one step for due-diligence engagements (AC8). The image gains
  `libmagic-mgc`.
- **`iac`** (container only). Checkov runs with `--directory=DIR` as one token, from `raw/`:
  Checkov reads `.checkov.yaml` from the `-d DIR` argument and from its cwd, so this keeps
  client config files from suppressing checks. hadolint runs on the Dockerfiles it finds,
  using radr's own config. Offline Checkov has no severities, so every failed check is
  medium (AC9).
- **`hygiene`** (optional, host and container). Scorecard `--local` runs only the 8 checks
  that work offline. Fuzzing, SAST and Vulnerabilities need the network or PR history and
  would differ between host and container. Scores 0–2 are medium findings and 3–4 are low.
  The matrix row never makes a run partial, though version drift still aborts (AC10).
- Every tool runs with radr's own config (`.jscpd.json`, `.checkov.yaml` and `.hadolint.yaml`
  in the client repo are ignored). Inline suppression comments are still honored, as with
  lint.
- `license` and `iac` need `network.enforcement: container`: `parseEngagement` refuses them
  in host mode, and `radr scope` never proposes them there. `hygiene` is opt-in.
- Verified with real tools: host-vs-container findings hashes stay identical with `maint`. A
  container e2e on a health fixture finds every planted signal across all four lanes, and two
  runs produce identical hashes.

### W3 — Stacks, static

- `STACKS` now includes go, rust, java-kotlin (the JVM), php, ruby and csharp (.NET). The keys
  match `rules/targets.yml`. Detection reads each stack's manifests and lockfiles plus its
  source extensions, and skips build output (`target/`, `bin/`, `obj/`, `.gradle/`,
  `.bundle/`). Scala, Swift, C/C++, Elixir and Dart are recognized and reported as
  unsupported.
- `radr db sync` now pulls all 8 OSV ecosystems: npm, PyPI, Go, crates.io, Maven, Packagist,
  RubyGems and NuGet. The new seven total about 80 MB; npm alone is about 220 MB. The sca
  lane checks that the pinned snapshot covers every detected stack's ecosystem. If one is
  missing, it reports `tool-missing` and names the ecosystem. Without this check,
  osv-scanner offline fails with a generic exit 127. `radr scope` warns about the same gap.
- osv-scanner runs with `--no-call-analysis=all --no-resolve`. Call analysis only runs when a
  Go or Rust toolchain happens to be on PATH, which would make host and image results
  differ. Transitive resolution needs registries. Lockfiles and pinned manifests are read
  offline for every stack (verified: go.mod, Cargo.lock, pom.xml, gradle.lockfile,
  composer.lock, Gemfile.lock, packages.lock.json and .csproj).
- **Authored rules for PHP, Ruby and Rust.** Each stack has 10 rules, one per top-10 target,
  and each has positive and negative fixtures under `opengrep test`. Every stack in
  `radr rules coverage` is now **supported**. The unit test also checks that removing the
  authored rules shows PHP, Ruby and Rust as partial again.
  - PHP and Ruby rules use taint mode: superglobals or `params`/`cookies` flow to sinks.
  - Rust rules use taint mode for paths, SSRF and commands, with axum/actix extractors as
    sources (Opengrep's Rust taint works, including destructured extractors).
  - Rust crypto, TLS, unsafe-memory, cast and bincode rules match patterns.
- AC11: a polyglot fixture holds one service per new stack. Each has a lockfile with a
  vendored OSV advisory and a planted SAST signal. The real-tool e2e confirms that all six
  stacks are detected and that every advisory and SAST finding is found.

### W4 — Report and rubric

- The rubric base entries and the scorecard's complexity and duplication rows landed in W2.
- **Methodology additions:**
  - the toolchain mode (host binaries, or the container image ID with the network denied)
  - the image's Python tool versions
  - a **SAST coverage** table: the rule packs used and the support bar for the stacks that
    were reviewed, with gaps listed by CWE
  - the Top 25 weaknesses no tool detects (authorization and authentication), stated
    explicitly
- **New report sections:**
  - **Licenses:** an inventory by §4b class, split into source files and dependencies.
  - **Repository hygiene:** Scorecard's offline scores.
- ScanCode skips lockfiles. They name dependency licenses as text, which the SBOM already
  reports; without the skip, the same dependency fact would appear twice.

### W5 — Stacks, sandboxed

| Stack | Image | Offline install (warm → run) | types | lint | tests |
|---|---|---|---|---|---|
| Go | golang 1.27 + golangci-lint 2.14.0 | `go mod download` → modcache copy, `GOPROXY=off` | `go vet` | golangci-lint (`--no-config`) | `go test -vet=off -coverprofile` → statement % |
| Rust | rust 1.99 + clippy (rustup) | `cargo fetch` → `CARGO_HOME` copy, `--offline` | `cargo check` errors | clippy lints | `cargo test` (pass/fail, stability) |
| JVM | temurin 21 + Maven 3.10.0 + PMD 7.28.0 | Maven `go-offline` + test (or Gradle wrapper `testClasses`) → `-o` / `--offline` | javac/kotlinc errors | PMD quickstart | `mvn test` / `gradlew test` |
| PHP | php 8.4 + Composer 2.10.3 + PHPStan 2.3.0 | `composer install` → cache copy, network disabled | PHPStan level 5 | (PHPStan) | PHPUnit when declared |
| Ruby | ruby 3.4 + RuboCop 1.91.0 (checksummed lock) | `bundle cache` → `bundle install --local` | — | RuboCop Lint + Security | rspec / `rake test` |
| .NET | SDK 8.0 or 10.0 (by target framework) | `dotnet restore` → restore from the warmed packages folder | compiler errors | CA analyzers (security: all) | `dotnet test` when declared |

- **Stack images.**
  - Built locally from pinned base digests (`toolchain/sandbox-images.yml`, which now
    includes Microsoft's registry) and named `localhost/radr-sandbox-<stack>:<context hash>`.
  - Downloaded tools (`toolchain/sandbox-tools.yml`, from `scripts/pin-sandbox-tools.ts`)
    are sha256-checked in a separate fetch stage.
  - clippy comes from rustup, which verifies it against the channel manifest.
  - RuboCop comes from bundler with `BUNDLE_FROZEN` and a lockfile with `CHECKSUMS`
    (`scripts/pin-rubocop.sh`).
  - Maven is fetched from Maven Central and verified against Apache's published sha512.
    archive.apache.org was too slow to use during builds.
  - `radr deps warm` builds or pulls the images a recipe needs; it is the online step.
    `radr tools build-image --stack <s>` does the same on its own. `tools install` now pulls
    only the node and python images.
  - The stack image tags are recorded in `toolchain.lock`, so a pin change shows up as
    sandbox drift.
- **Lanes.**
  - The types and coverage lanes run each stack's driver (`src/sandbox/stacks.ts`).
  - The lint lane runs the stack linters in the sandbox, except in the triage tier.
  - Without a container runtime, the lint lane records a note instead of failing.
  - Static linters (PMD, RuboCop) skip the dependency install.
  - Coverage has a percentage for Go only (statement coverage). The other stacks run their
    tests twice for pass/fail and stability, and the report says so.
- **Every linter uses radr's own configuration:** golangci-lint `--no-config`, an explicit
  RuboCop config, a radr PHPStan config, and the PMD quickstart ruleset.
- **Found while building:**
  - Maven's resolver spins forever on file locks over virtiofs-mounted caches. Maven and
    Gradle therefore warm into container-local storage and copy the result into the cache.
  - PHPStan resolves `excludePaths` relative to its config file, so the exclude path is
    absolute.
  - `go test` runs vet checks by default; tests use `-vet=off` because vet is the types
    lane's job.
- **Tests:**
  - goldens from real outputs of every W5 tool (`test/golden/stacks/`)
  - driver and recipe unit tests
  - the AC12 e2e (`test/fixtures/stack-sandbox`): warm once, then lint, types and tests run
    offline for all six stacks, every planted signal is found, nothing fails to build, and
    tests are stable

### Open items carried forward

- Coverage percentages for Rust, JVM, PHP, Ruby and .NET need per-project build
  configuration (cargo-llvm-cov, JaCoCo, pcov, SimpleCov, coverlet).
- The LGPL sub-pack is pending counsel.
- ~~Package license~~: resolved, MIT (LICENSE).
- Per-test flaky detection (today a whole run is compared to a whole run).
- Kotlin lint (detekt) and Gradle builds without a wrapper.
