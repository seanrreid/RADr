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
