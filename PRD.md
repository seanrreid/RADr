# PRD: RAD Review — Review, Address, Debug

**Status:** draft r2 (consistency pass 2026-10-07)
**Owner:** Sean Reid (TorchCodeLab consulting)
**Date:** 2026-10-07
**Lineage:** Sibling in spirit to [RAD: Research, Architect, Deliver](../RAD_framework/README.md). Fully standalone — no code or runtime coupling — but built on the same thesis.

> **RAD ships determinism, not intelligence.**
> In RAD Review, *tools decide findings; the model explains them.*

---

## 1. Summary

RAD Review is a CLI that turns a client code review into a reproducible, auditable
engagement. A pinned toolchain of deterministic analyzers (linters, typecheckers,
SAST, secret, dependency, IaC, license, and maintainability scanners) produces the
findings. An optional, per-engagement LLM lane clusters related findings, explains
them, and drafts the write-up, but never invents a finding's existence or severity.
Deduplication itself is deterministic (§14.5). Every
finding traces to tool output, a rule ID, and a `file:line` at a fingerprinted
commit, or it is explicitly labeled a *judgment* finding and gated behind consultant
confirmation.

Three phases:

| Phase | Question it answers | Primary output |
|---|---|---|
| **Review** | What is true about this codebase? | Normalized, dispositioned `findings.jsonl` |
| **Address** | What should the client do about it? | Client report (Markdown → PDF) + executable remediation plan |
| **Debug** | Why is *this specific bug* happening? | Root-cause record with reproduction, bisect evidence, and regression test |

---

## 2. Problem

Code reviews sold as a consulting deliverable have three recurring failures:

1. **Not reproducible.** Two runs (or two reviewers) produce different findings. A
   client can't tell whether a re-review shows real improvement or reviewer drift.
2. **Not defensible.** LLM-assisted reviews produce plausible-sounding findings with
   no evidence anchor. One hallucinated "critical" in a due-diligence report costs
   more credibility than ten real findings earn.
3. **Not actionable.** Reports end in a list. The client has no sequenced, sized
   plan, and the consultant has no clean on-ramp from "here's what's wrong" to
   "let us fix it."

## 3. Goals

- **G1 — Reproducibility.** The same scope fingerprint (§7, Gate 1) yields
  byte-identical tool findings. The only exception is measured coverage, which is
  classified `stable` or `unstable` rather than assumed identical (§14.1a).
- **G2 — Defensibility.** 100% of reported findings carry an evidence anchor; LLM-only
  findings are visibly labeled and individually consultant-confirmed.
- **G3 — Per-engagement data control.** A single scoping switch guarantees no client
  code reaches an LLM, verifiable from the event log.
- **G4 — Client-ready deliverable.** A branded report a client can read, plus a
  remediation plan a team can execute.
- **G5 — Disciplined debugging.** Root-cause work follows a fixed, evidence-logged
  method: no root-cause claim without a reproduction.
- **G6 — Fast triage.** An "Is this any good?" verdict in under ~30 minutes of wall
  clock on a typical mid-size repo.

## 4. Non-goals

- Not a SaaS or hosted scanner. Runs on the consultant's machine (or
  consultant-controlled sandbox), against a forked or cloned copy of the client's
  code. No execution in client infrastructure in v1, including client CI.
- Not a replacement for penetration testing or dynamic (DAST) testing — v1 is static
  analysis + repository forensics + debugging method.
- Not an autonomous fixer. Address produces a plan; executing it is a separate,
  human-approved engagement.
- Not coupled to RAD_framework. No shared runtime, config, or file formats are
  required (though concepts are borrowed freely).
- Not a new analyzer. RAD Review orchestrates and normalizes existing tools; it does
  not write its own SAST engine.
- No client-executed run kit in v1. A client who forbids code leaving their
  environment can still be served by the consultant running `radr` on
  client-provided infrastructure. A "run kit + redacted bundle" flow is deferred
  (see §20 #6).

---

## 5. Engagement types

All engagement types share one pipeline; they differ in **tier**, **lane selection**,
and **report template**.

| Engagement | Tier | Emphasis | Report template |
|---|---|---|---|
| **"Is this any good?" triage** | `triage` | Fixed fast lanes, no LLM write-up required | One-page verdict + scorecard |
| **Code quality review** | `standard` | Lint, typecheck, complexity, duplication, dead code, test signal | Quality report |
| **Codebase health audit** | `standard` | All `standard`-tier lanes, balanced | Health report |
| **Security-focused review** | `deep` | SAST, secrets (incl. history), SCA, IaC, licenses | Security report w/ CVSS/EPSS |
| **Tech due diligence** | `deep` | All lanes + hotspots, bus factor, license risk, exec summary | DD report (exec-first) |
| **Ongoing PR review** | `diff` | Same lanes, scoped to changed files, baseline-suppressed | PR comment / SARIF upload |
| **Debug** | n/a | Root-cause method (Section 11) | Root-cause record |

### Tiers

- **`triage`** — Fixed lane set, targeted to finish in under ~30 minutes (a target,
  not a cutoff: lanes are never truncated by wall clock). Covers size/language
  census, lint + typecheck error counts (typecheck only when dependencies resolve
  in the sandbox; otherwise reported as unavailable), complexity distribution, duplication %, dependency vuln counts,
  secrets (HEAD only), test presence/ratio, churn hotspots. Produces a scorecard
  against fixed thresholds from the rubric. Deterministic end to end; LLM only for an
  optional prose paragraph.
- **`standard`** — Triage plus full-findings lanes, a **full-history secrets scan**,
  and the disposition workflow.
- **`deep`** — Standard plus license compliance, IaC,
  SBOM, OpenSSF Scorecard, and judgment-finding review passes.
- **`diff`** — Any lane set, restricted to a diff range, with findings suppressed
  against a recorded baseline so only *new* findings surface.

---

## 6. Principles (how "determinism, not intelligence" applies)

| # | Principle | In RAD Review |
|---|---|---|
| P1 | **The harness owns authority** | A finding exists because a tool emitted it (or a consultant confirmed a judgment finding). The model never creates, deletes, or re-severities a finding. |
| P2 | **Artifacts, not memory** | Every phase writes files in the engagement folder. The chat transcript is never the record. |
| P3 | **Append-only event log is the source of truth** | Gates and dispositions are folds over `events.jsonl`. Report headers are display mirrors. |
| P4 | **Fingerprinted scope** | Scope approval freezes a fingerprint (contents defined in §7, Gate 1). Any change invalidates approval, failing closed. |
| P5 | **The matrix owns control flow** | Every typed outcome resolves through one declared table (`matrix.yml`), with no default fallthrough. Outcomes include `success`, `tool-missing`, `tool-error`, `timeout`, `partial`, `version-drift`, `fail-protocol`, `build-failed`, `tests-failed`, `unstable`, and `no-repro`. An unknown outcome throws. |
| P6 | **Bounded hand-offs** | Lanes return normalized finding sets. The LLM lane receives bounded, policy-filtered inputs and returns typed output; it never gets ambient access. |
| P7 | **Fail-closed at gates, fail-open for observation** | A missing required tool stops the run; a failed optional enrichment (e.g., EPSS lookup) is recorded and the run continues with the gap visible in the report. |
| P8 | **No silent partials** | A report generated from an incomplete run says so on its cover page, enumerating missing lanes. |

---

## 7. Lifecycle

```
                 ┌───────────── Gate 1: Scope approval ─────────────┐
 radr init  →  radr scope  →  radr approve scope   (fingerprint frozen)
                                     │
                                     ▼
 REVIEW      radr review     run pinned lanes → raw SARIF/JSON → normalize →
                             dedupe → baseline-diff → findings.jsonl
             radr triage     (LLM lane, optional) cluster, explain, propose
                             dispositions + judgment findings → pending
             radr disposition  consultant confirms / marks FP / waives
                                     │
                                     ▼
 ADDRESS     radr address    rubric → priorities → remediation plan (waves,
                             effort, AC per item) + report.md
                 ┌───────────── Gate 2: Report sign-off ────────────┐
             radr approve report   (fingerprint of findings + report)
             radr render     report.md → report.pdf (only after Gate 2)
                                     │
                                     ▼
 DEBUG       radr debug open [--from-finding F-123 | --issue "..."]
   (also     repro → bisect → hypotheses → root cause → regression test
  standalone)                → root-cause record (Gate: repro required)
                                     │
 VERIFY      radr verify --against <run-id>   re-run same fingerprint (new SHA)
             on fixed code → findings marked fixed / verified / regressed
```

### Gate 1 — Scope approval

`radr scope` records the following. **This is the canonical list of what the scope
fingerprint covers**; other sections refer back to it.

- client, engagement type, tier, report template
- repo URL + HEAD commit SHA; include / exclude paths
- lanes enabled
- rule pack version + hash, and the `rules/lgpl/` sub-pack version + hash (§14.2)
- any runtime-fetched rulesets (hash)
- rubric version
- toolchain image digest, or host lockfile hash (§14.4)
- vulnerability/EPSS DB snapshot hash (§14.1) and dependency cache snapshot hash
  (§14.1a)
- build recipe (§14.1a)
- **network mode** (`offline` | `network`)
- **LLM policy** (`off` | `metadata-only` | `code-allowed`)
- client-supplied tool licenses (CodeQL, Brakeman), if any

`radr approve scope` writes a `scope-approved` event with the fingerprint. `radr review`
refuses to run without it, and re-checks the fingerprint before every lane.

### Gate 2 — Report sign-off

`radr approve report` refuses while any finding is in `pending` state, any judgment
finding is unconfirmed, or the run is partial without an explicit
`--accept-partial "<reason>"` (recorded in the event and printed on the cover). The
event freezes the hashes of the findings set, `report.md`, `remediation.md`, and the
theme. PDF rendering is gated on this event.

---

## 8. Data model

### Engagement folder

```
engagements/<client>-<slug>/
├── engagement.yml          # scope (human-edited before Gate 1)
├── events.jsonl            # append-only; the authority
├── toolchain.lock          # resolved tool versions + container digest
├── snapshots.lock          # vuln/EPSS DB + dependency-cache snapshot hashes & dates
├── source/mirror.git       # radr-owned mirror clone of the client fork (history for secrets/history lanes)
├── source/worktree/        # read-only checkout of the approved SHA; what lanes scan
├── raw/<lane>/<run-id>.*   # untouched tool output (SARIF/JSON), never edited
├── findings.jsonl          # normalized findings (append-only records)
├── baseline.json           # optional: suppression baseline for diff tier
├── llm/                    # every prompt + response sent, when LLM policy ≠ off
├── report/report.md        # Address output (source of truth)
├── report/report.pdf       # rendered after Gate 2
├── plan/remediation.md     # Address output: executable plan
└── debug/<id>/             # Debug records (Section 11)
```

`engagements/` lives outside client repos by default.

### Source snapshot

The consultant points `radr scope --source <path-or-url>` at a forked or cloned copy
of the client's code.
- `radr` makes its **own** mirror clone in `source/mirror.git`, then checks out the
  approved SHA into `source/worktree/`, which is made read-only.
- Lanes only ever see that worktree (mounted read-only in container mode). Later
  edits, branch switches, or uncommitted changes in the consultant's working copy
  can't leak into a run.
- `radr review` verifies that `HEAD` of the worktree equals the fingerprinted SHA
  before every lane.
- New commits (re-review, `verify`, `diff` PR refs) arrive via `radr source fetch`,
  which records the new SHAs as events.

### Finding record

```json
{
  "type": "finding",
  "id": "F-0042",
  "fingerprint": "sha256:…",          // stable: rule + path + normalized snippet hash
  "run_id": "R-2026-10-07T14:02Z",
  "lane": "sast",
  "tool": "opengrep", "tool_version": "1.x.y", "rule_id": "…",
  "class": "tool",                     // tool | judgment
  "category": "security",              // security | quality | maintainability | dependency | license | iac | secrets | test | coverage
  "file": "src/auth/token.ts", "line": 42, "end_line": 44,
  "message": "…",                      // adapters never interpolate code into message
  "snippet": "…",                      // separable; redacted under metadata-only / future export
  "snippet_hash": "sha256:…",
  "tool_severity": "ERROR",
  "severity": "high",                  // mapped by rubric — never by the LLM
  "rubric_version": "1",
  "cvss": null, "epss": null, "cve": null,   // stored as strings, never floats (§15)
  "evidence": { "raw_ref": "raw/sast/R-….sarif#/runs/0/results/17" }
}
```

### Disposition state machine

```
pending ──confirm──▶ confirmed ──fix observed──▶ fixed ──re-run clean──▶ verified
   │                    │                                     │
   ├──false-positive──▶ dismissed (reason required)           └──reappears──▶ regressed
   └──waive───────────▶ waived (reason + approver required)
```

Each transition is an event with actor, timestamp, and reason. Transitions not in
the table are rejected.

**Disposition at volume.** A single lint lane can emit thousands of findings, so
the rubric (§10) splits them into two sets:
- **Auto-confirm classes.** By default: `lint`, `types`, `maint`/metrics, `coverage`,
  and `sca` findings with a known CVE, all below High. These move `pending →
  confirmed` through an event whose actor is `rubric@v<N>`. The step is deterministic,
  versioned, and visible in the log.
- **Review set.** Always needs a human decision: every `sast`, `secrets`, `iac`, and
  `license` finding, every judgment finding, and anything at High or above,
  regardless of class.
- **Bulk disposition.** `radr disposition --rule <id> | --category <c> | --path
  <glob> <state> --reason "…"` writes one event per finding, all sharing the reason.

Gate 2 counts only findings still `pending` or `proposed`.

A `regressed` finding re-enters as `confirmed` for the next
remediation cycle. Severity overrides are a separate `severity-override` event, not a
state transition (§10). Judgment findings start in `proposed` and can only move to
`pending` via explicit consultant confirmation.

---

## 9. LLM boundary

- **One configurable agent command** (`RADR_AGENT_CMD`) — any CLI that reads a prompt
  on stdin and writes structured output (Claude Code headless, other agents). Unset
  ⇒ no LLM, by construction.
- **LLM policy is part of the scope fingerprint:**
  - `off` — agent command is never invoked; `radr` errors if asked for an LLM step.
  - `metadata-only` — the model sees rule IDs, messages, paths, and metrics, but no
    source lines. A deterministic redaction filter strips `snippet` fields before
    invocation, along with any tool message text that embeds matched code (some
    rule messages interpolate metavariables). Invariant 3 asserts the result.
  - `code-allowed` — bounded snippets (± N lines around anchors) may be sent.
- **Every prompt and response is persisted** under `llm/` and referenced from the
  event log, so a client can audit exactly what left the machine.
- **What the LLM may do:** cluster duplicates across tools; explain a finding in
  client language; propose (not apply) dispositions; draft report prose and
  remediation-plan narrative; propose judgment findings with `file:line` evidence.
- **What the LLM may not do:** set severity; transition dispositions; edit raw or
  normalized findings; suppress anything; approve a gate.
- **Output contract:** typed JSON validated against a schema; invalid output is a
  `fail-protocol` outcome routed through the matrix (bounded retry, then surface).

---

## 10. Severity

- **Rubric** (`rubric/v<N>.yml`, versioned, part of the fingerprint) defines
  Critical / High / Medium / Low / Info and deterministic mappings from
  `(tool, rule_id | tool_severity, category)` → severity, with path modifiers
  (e.g., test/fixture paths demoted, auth paths promoted).
- **Vulnerabilities** (SCA, SAST-with-CWE) carry the CVSS base score, EPSS
  probability, and CISA KEV status through to the report. CVSS bands set the base
  severity. Being listed in KEV promotes to critical, and EPSS ≥ 10% promotes one
  step. Promotion only, never demotion.
- **Draft rubric:** [`rubric/v1.yml`](rubric/v1.yml) (integer-only thresholds;
  calibrate after the first 3 engagements).
- **Auto-confirm classes and the review set** (§8) are declared in the rubric, so
  changing them is a rubric version bump.
- **Triage scorecard thresholds** live in the same rubric (e.g., "duplication > 8%
  ⇒ amber").
- Severity overrides are a `severity-override` event with a reason, never an edit.
- CVSS comes from the vulnerability DB snapshot, and EPSS from a dated EPSS snapshot
  pulled by `radr db sync`. EPSS changes daily, so its snapshot is fingerprinted. A
  missing EPSS snapshot is a fail-open enrichment gap, shown in the report (P7).

---

## 11. Debug

Debug is a root-cause workflow for a specific bug, reachable standalone
(`--issue`) or from a Review finding (`--from-finding F-…`). Debug runs client code,
so it always operates inside an engagement with an approved scope (Gate 1). A
standalone debug uses engagement type `debug`, whose scope covers repo, SHA, build
recipe, network mode, and LLM policy. All repro scripts, tests, and logs live in
`debug/<id>/` in the engagement folder. The client repo stays read-only. A
regression test is *delivered* to the client as a patch file.

Its determinism is in the *method*, enforced by gates:

1. **Intake** — symptom, environment, expected vs. actual, first-seen. Recorded as an
   event.
2. **Reproduce (gate)** — a runnable repro (script or failing test, stored in
   `debug/<id>/repro/` and run in the build sandbox) with
   recorded command, exit code, and output hash. *No hypothesis may be marked
   confirmed until a repro is recorded.* "Cannot reproduce" is a valid terminal
   outcome with evidence of attempts.
3. **Localize** — automated `git bisect run <repro>` when a known-good revision
   exists; coverage diff of passing vs. failing runs; log/trace capture. Each
   tool run recorded with its output.
4. **Hypothesis log** — each hypothesis is an event: `proposed` → `confirmed` |
   `refuted`, each with the evidence (command + output) that decided it. The LLM may
   propose hypotheses and next experiments; only recorded evidence decides them.
5. **Root cause** — names the defect, the introducing commit (if bisected), and the
   mechanism. Gate: requires a confirmed hypothesis and a repro.
6. **Regression guard** — the repro converted to a test that fails before the fix
   and passes after; both runs recorded.
7. **Output** — `debug/<id>/root-cause.md`, and (optional) a remediation item
   appended to the Address plan.

---

## 12. Address outputs

### Client report (`report/report.md` → PDF)

Template per engagement type. Sections: cover (scope fingerprint, toolchain,
LLM policy, completeness), executive summary, scorecard, top risks, findings by
category (severity-sorted, with evidence anchors), judgment findings (labeled),
waivers and dismissed-count, methodology appendix (exact tools + versions + rules),
and full findings appendix. Markdown is the source of truth; PDF is rendered by a
pinned renderer.

**Theming.** Branding is a theme directory (`themes/<name>/`: Typst template, logo,
colors, fonts, footer, and legal/disclaimer text). The **TorchCodeLab** theme is the
default. `engagement.yml` may name another theme for white-label, partner, or
co-branded delivery. The theme's content hash is frozen into the `report-approved`
event, so the PDF the client receives renders exactly what was signed off.

### Remediation plan (`plan/remediation.md`)

Waves of remediation items; each item cites the finding IDs it resolves, an
effort size (S/M/L from a rubric table), an acceptance criterion that is
**verifiable by re-running a lane** (e.g., "rule X reports zero results in
`src/auth/`"), and dependencies. The plan is the on-ramp to a follow-on delivery
engagement.

---

## 13. Ongoing PR review (`diff` tier)

`radr review --tier diff --base <ref> --head <ref>` runs the engagement's lanes on
changed files, suppresses against `baseline.json`, and emits SARIF and a Markdown
summary the consultant posts to the PR. LLM policy applies identically.

**v1 execution model: consultant-side.** The consultant keeps a fork or clone of the
client repo and fetches the PR refs into it. `radr` snapshots that source (§8,
source snapshot) and runs the lanes on the consultant's machine or sandbox, exactly
like any other tier. Nothing runs in client infrastructure, and the toolchain image
isn't distributed. Running in the client's CI is deferred (§20 #11).

---

## 14. Toolchain

Tool selection criteria, in order: (1) license permits use on closed-source client
code in a paid engagement and redistribution in our image; (2) runs offline; (3)
emits SARIF or stable JSON; (4) pinnable by digest/checksum; (5) actively maintained.
Vetting notes and sources: Appendix A (checked 2026-10-07; re-verify at pin time).

### Lanes and default tools

| Lane | Default | Alternates / per-stack | Notes |
|---|---|---|---|
| `census` | scc | — | LOC, languages, COCOMO-free |
| `lint` | eslint (TS/JS), ruff (Py), golangci-lint (Go), clippy (Rust), PMD / detekt (JVM), PHPStan (PHP), RuboCop (Ruby), NetAnalyzers (.NET) | Biome, staticcheck, Checkstyle, ktlint, Roslynator | Two modes. **Baseline:** radr's own pinned configs, no client deps, comparable across engagements. **Project:** the client's own config and plugins, run in the sandbox. Findings are tagged with their mode. |
| `types` | tsc (client's own, else pinned), mypy (pinned) | pyright, PHPStan levels | Needs deps installed → sandboxed build (mypy chosen over pyright in M2: installs with pip in the Python sandbox) |
| `sast` | **Opengrep** + curated rule pack; bandit, gosec, SpotBugs + FindSecBugs, Psalm taint, NetAnalyzers CA security rules | Semgrep CE (fetched rules only, see §14.2) | CodeQL and Brakeman are **client-licensed plug-ins only** |
| `secrets` | gitleaks (HEAD in `triage`; **full history in `standard`/`deep`**; the PR's commit range in `diff`) | Betterleaks (planned successor), TruffleHog **with `--no-verification` only** | Live verification is forbidden. No commit or time bound on history: the timeout exists only as a safety net, and hitting it is a `partial` outcome that blocks Gate 2 unless `--accept-partial` is used |
| `sca` | osv-scanner v2 (`--offline`, snapshotted DB) + syft SBOM | grype (second opinion), cargo-audit, govulncheck, bundler-audit | npm/pip/composer/dotnet auditors are network-mode only |
| `license` | ScanCode Toolkit | syft license data, licensee | |
| `iac` | Checkov | Trivy config (digest-pinned), hadolint | tfsec is deprecated; KICS excluded pending trust |
| `maint` | lizard (complexity), jscpd (duplication) | knip (TS), vulture (Py), Go `deadcode` | |
| `history` | built-in `git log --numstat` analyzer (churn × complexity, ownership, bus factor) | code-maat (GPL, external process) | Own implementation keeps it deterministic and dependency-free |
| `tests` | static test signal (presence / ratio) | — | All tiers |
| `coverage` | measured coverage run in the build sandbox (§14.1a) | c8, pytest-cov, `go test -cover`, cargo-llvm-cov, JaCoCo, phpunit+pcov, simplecov, coverlet → LCOV/Cobertura | `standard`/`deep`; runs client code → sandbox |
| `hygiene` | OpenSSF Scorecard `--local` | Full Scorecard (network + token) | Optional lane |

Debug toolkit: `git bisect run`, native test runners + coverage diff, py-spy /
async-profiler / samply / perf, `rr` (Linux x86-64 only). Pernosco is excluded by
default (recordings leave the machine).

Rendering: pandoc + Typst (default), WeasyPrint (alternate). SARIF: Microsoft
sarif-tools and SARIF SDK Multitool for merge, validate, and baseline matching.

### 14.1 Network modes

Network mode is part of the scope fingerprint:

- **`offline`** (default): no lane may open a network socket (enforced by running the
  container with networking disabled). Vulnerability DBs (OSV, grype, RustSec,
  ruby-advisory-db, Go vulndb) come from a **DB snapshot** pulled on a connected
  machine by `radr db sync` (which also pulls the dated EPSS file and the CISA KEV catalog). Each snapshot's
  timestamp and hash are recorded in `snapshots.lock` and printed in the report's
  methodology section.
- **Enforcement depends on packaging.** In container mode, `offline` is *enforced*
  (no network namespace). In host mode it can only be *declared*: lanes are
  configured for offline operation, but nothing blocks a socket. The scope records
  `network_enforcement: container | declared`, and the methodology section prints
  it. Engagements whose contract requires enforced offline must use container mode.
- **`network`**: additionally enables registry-backed auditors (npm audit,
  pip-audit, composer audit, `dotnet list package --vulnerable`), full Scorecard,
  and dependency installation for build-dependent lanes.

Lanes that need a build (`types`, JVM/.NET SAST, coverage, Debug repro) run in a
**throwaway sandbox container**. In `offline` mode that container has no network,
so it needs a vendored or warmed dependency cache. Running client code is always an
explicit, recorded scope decision.

### 14.1a Build sandbox and coverage lane (v1)

Coverage is **measured, not imported, in v1**. The build sandbox it needs is shared
with `types`, the JVM/.NET analyzers, and Debug (repro, `git bisect run`), so it is
core infrastructure rather than a coverage-only feature.

- **Sandbox.** A throwaway container per run, built from a pinned per-stack base
  image (digest recorded). The client repo is mounted read-only and copied into a
  scratch workspace. The container runs as non-root with a CPU, memory, and
  wall-clock limit, and has no host credentials. Network follows the engagement's
  network mode. In `offline` mode, dependencies come from a vendored directory or a
  **dependency cache snapshot** created by `radr deps warm` on a connected machine.
- **Build recipe.** Declared explicitly in `engagement.yml` (install, build, and test
  commands, plus the coverage tool). `radr scope` auto-detects a *proposed* recipe
  from manifests (package.json scripts, pyproject, go.mod, Cargo.toml,
  pom/gradle, composer.json, Gemfile, *.csproj), but only the approved recipe runs.
  The recipe is part of the scope fingerprint.
- **Coverage tools per stack.** c8/istanbul (jest, vitest), pytest-cov, `go test
  -coverprofile`, cargo-llvm-cov, JaCoCo, phpunit + pcov/Xdebug, simplecov, coverlet.
  All output is normalized to LCOV or Cobertura and then to `coverage` findings and
  metrics (line/branch %, per-directory, uncovered hotspots × churn).
- **Determinism.** Test suites can be flaky, so the lane runs the suite
  **N times (default 2)** and records each run's pass/fail set and coverage hash.
  - If the runs agree, the result is `stable`.
  - If they disagree, the result is `unstable`. The report then shows the range and
    lists the flaky tests. Flaky tests are themselves a finding, not noise to hide.
- **Outcomes.** `build-failed`, `tests-failed`, `timeout`, and `unstable` are typed
  matrix outcomes, not crashes. A failed build is reported as a finding ("project
  does not build from a clean checkout with declared steps"), which is often one of
  the most useful findings in due diligence.
- **Fallback.** If the client's own CI coverage artifact is supplied, it may be
  imported *alongside* the measured run, with its provenance (CI run URL and SHA)
  recorded. It never replaces a failed measurement silently: the report labels which
  numbers are measured and which are imported.
- **Tiers.** `triage` skips the coverage run (it reports static test signal only, to
  stay inside the time box). `standard` and `deep` run it by default. `diff` runs it
  only when the engagement opts in.

### 14.2 Rules licensing

- **Never bundle the Semgrep Registry rules.** The Semgrep Rules License permits
  internal use (including by consultants) but forbids distributing the rules or
  offering them as a service. If an engagement opts into them, they are *fetched at
  runtime* by the consultant's own install, and the fetched ruleset hash is recorded.
- **`opengrep-rules` is archived and unusable.** Its LICENSE is LGPL-2.1 plus the
  Commons Clause, which forbids selling, including consulting services that derive
  value from the rules. There is no maintained, permissively licensed rule corpus
  (Appendix B). RAD Review ships its **own curated rule pack** (versioned, part of the
  fingerprint), seeded from permissively licensed sources and grown from findings
  that recur across engagements. This is a standing workstream, not a one-off task.
- **Rule pack strategy (hybrid, CWE-driven).**
  - **Targets:** a per-stack CWE target list (`rules/targets.yml`), derived from the
    CWE Top 25 and filtered for relevance to each stack.
  - **Seed then author:** seed each target from permissively licensed third-party
    rules where they exist (vetted sources: Appendix B), and author our own rules
    for the gaps.
  - **Provenance:** every rule carries `metadata.source`, `metadata.license`,
    `metadata.cwe`, and `metadata.owasp`. Rules with copyleft or non-redistributable
    licenses are rejected by a CI license check. The one exception is the
    unmodified LGPL-3.0 sub-pack in `rules/lgpl/` (§20 #10).
  - **Fixtures are mandatory:** every rule ships with positive (`ruleid:`) and
    negative (`ok:`) test fixtures, and `opengrep test` runs in CI. A rule without
    passing fixtures can't be merged.
  - **Versioning:** the pack is versioned (`rules/VERSION`). Its content hash is part
    of the scope fingerprint.
  - **Tuning loop:** false-positive dispositions are aggregated per `rule_id` across
    engagements (`radr insights rules`) to drive tuning. Rule changes always land as
    a new pack version, never as an in-place edit.
- **Target list:** [`rules/targets.yml`](rules/targets.yml), built against the
  2025 CWE Top 25. Each Top 25 entry is classified by how it's detected: `sast`,
  `judgment`, `memory-safety`, or `types`. The authorization family (CWE-862, 863,
  284, 306, 639) is **judgment-only**: pattern rules can't prove a check is
  *missing*. It's covered by the judgment lane and the consultant's review
  checklist, never counted toward the SAST support bar.
- **Support bar.** A stack's `sast` lane is marked **supported** only when it covers
  its **top-10 CWE targets** (e.g., injection, XSS, path traversal, unsafe
  deserialization, SSRF, authn/authz flaws, hard-coded credentials, weak crypto,
  open redirect, XXE) with passing fixtures. Below that bar the lane still runs, but
  the report's methodology section labels it **partial** and lists the uncovered
  CWEs.
- **CodeQL** (proprietary; free only for OSI-licensed code) and **Brakeman**
  (Brakeman Public Use License; commercial use needs a paid license) run only under
  a license the client supplies, and that license is recorded at scoping.

### 14.3 Supply-chain hygiene

There were real compromises of scanner distribution channels in 2026 (malicious
Trivy releases and tags, poisoned KICS images). So:

- The toolchain image is **built by us from checksum- or cosign-verified upstream
  artifacts**. We never pull vendor `latest` or other mutable tags.
- Every image is referenced by `sha256` digest. Every binary in host mode is
  checksum-verified by `radr doctor`.
- License texts and source offers for GPL/AGPL components (golangci-lint, hadolint,
  pandoc, TruffleHog, bundler-audit, code-maat) ship with the image. All are invoked
  as separate processes and never linked.

### 14.4 Packaging

A versioned OCI image (the default) and a host mode driven by a tool manifest plus
lockfile. The image digest or host lockfile hash is part of the scope fingerprint.
Drift is a `version-drift` outcome and fails closed.

### 14.5 Normalization

SARIF 2.1.0 is the interchange format. Tools without native SARIF (clippy, vulture,
lizard, scc, TruffleHog, the ecosystem auditors, the history analyzer) each get a
per-tool adapter with a fixture-based golden test. Deduplication uses
engine-provided fingerprints where available (Opengrep emits them; Semgrep CE no
longer does) and RAD Review's own `rule + path + normalized-snippet` hash otherwise.

---

## 15. Implementation

**Decision (2026-10-07): TypeScript on Node.**

Rationale: `radr` is orchestration plus JSON processing (spawning processes,
normalizing SARIF/JSON, folding an event log, validating schemas, rendering
templates), not systems programming. Go's main advantages don't apply here. A
single binary matters little because the default mode is a container image that
already ships ~30 tools. Importing Go scanners as libraries would contradict §14,
which runs scanners as separate pinned processes for isolation, per-tool version
pinning, and GPL separation. The maintainer's JS/TS fluency matters most where the
product's value is: the correctness of gates, fingerprints, and normalization.

### Stack

- **Runtime:** Node 22 LTS or later, ESM only. Version pinned in `.nvmrc`,
  `package.json` `engines`, and the toolchain image.
- **Language:** TypeScript with `strict: true`, `noUncheckedIndexedAccess`, and
  `exactOptionalPropertyTypes`. Compiled with `tsc` to `dist/`; no bundler in v1.
- **Tests:** `node:test` + `node:assert` on compiled output, with golden-fixture
  tests for every tool adapter and replay tests for every gate and disposition fold.
- **CLI parsing:** `util.parseArgs` (built-in).
- **Process execution:** `node:child_process` (`spawn`, never `shell: true`), with
  explicit timeouts, environment allowlists, and captured exit codes, stdout, and
  stderr hashes.
- **Hashing:** `node:crypto` (SHA-256).

### Dependency budget

**At most 8 runtime dependencies**, each justified in `docs/dependencies.md`.
Expected:

| Need | Candidate |
|---|---|
| JSON Schema validation (findings, events, LLM output, `engagement.yml`) | ajv |
| YAML (engagement, rubric, matrix, gates) | yaml |
| SARIF types | @types/sarif (dev only) |
| Report templating | a logic-less engine (e.g., mustache-style) or plain template literals |
| Markdown processing (only if needed) | unified/remark |

Supply-chain rules, matching §14.3:
- commit `package-lock.json`
- install with `npm ci --ignore-scripts` everywhere, including the image build
- CI fails on new install scripts or unreviewed dependency additions
- prefer Node built-ins over packages

Dev dependencies (typescript, eslint, @types/*) don't count toward the budget but
follow the same install rules.

### Determinism utilities (`src/core/determinism.ts`)

Built and tested in M1, before any lane code. All fingerprinting, hashing, and
ordering goes through this module. A lint rule forbids direct
`JSON.stringify`-then-hash and `localeCompare` outside it.

| Helper | Guards against |
|---|---|
| `canonicalJson(value)` | `JSON.stringify` key order: sorts object keys recursively, rejects `undefined`, `NaN`, `Infinity`, and non-plain objects |
| `stableSort(items, key)` | Locale-dependent sorting: code-point comparison only, never `localeCompare` or `Intl` |
| `hash(value)` | `sha256(canonicalJson(value))`, the only way a fingerprint is computed |
| `normalizePath(p)` | OS separators, `./` prefixes, absolute paths, symlinks (repo-relative POSIX output) |
| `normalizeSnippet(s)` | Line endings, trailing whitespace, and tab/space drift when computing snippet hashes |
| `clock` (injected) | Wall-clock time leaking into fingerprints. Timestamps live only in events, never in hashed content |
| No floats in hashed content | Floating-point formatting drift. Scores like CVSS are stored as strings or scaled integers |

Property tests check that shuffled key order, shuffled finding order, CRLF versus
LF line endings, and different `LANG`/`TZ` values all produce identical hashes.

### Distribution

- **Primary:** inside the toolchain OCI image.
- **Host mode:** `npm ci` from a tagged release tarball, verified against a published
  checksum.
- **Deferred:** a single-executable build (Node SEA) if host-mode installs or client
  hand-off become painful. The architecture must not preclude it (no native addons,
  no runtime filesystem lookups outside the package).

---

## 16. CLI surface (v1)

```
radr init <client> <slug>              create engagement folder
radr scope --source <path|url> [--sha <sha>] [--edit]
                                       mirror source, detect stacks, propose lanes, write engagement.yml
radr approve scope                     Gate 1
radr doctor                            verify toolchain vs. lock (offline)
radr review [--tier ...] [--lanes ...] run lanes, normalize, write findings
radr triage                            LLM lane (policy permitting)
radr findings [query]                  list/filter findings
radr disposition <id> <state> --reason "..."
radr address                           report.md + remediation.md
radr approve report [--accept-partial "..."]   Gate 2
radr render                            report.pdf
radr debug open|repro|bisect|hypothesis|conclude|guard
radr status                            engagement dashboard
radr verify --against <run-id>         re-run on fixed SHA; mark fixed/verified/regressed
radr source fetch [<ref>...]           update the radr-owned mirror; record new SHAs
radr db sync                           (connected machine) snapshot vuln DBs + EPSS
radr deps warm                         (connected machine) build dependency-cache snapshot
radr insights rules                    per-rule FP rates across engagements (tuning input)
```

All commands are deterministic except `triage`, the drafting step of `address`, and
debug hypothesis proposal — each of which only runs through `RADR_AGENT_CMD`.

---

## 17. Invariants (enforced + tested)

1. No lane runs without a `scope-approved` event whose fingerprint matches current scope.
2. With LLM policy `off`, the agent command is never executed (asserted by an eval
   that runs the full pipeline with a trap agent command).
3. With `metadata-only`, no prompt contains source bytes from the client repo
   (asserted by an eval that diffs prompts against the repo).
4. Every finding in a rendered report has an evidence anchor or `class: judgment`
   with a confirming event.
5. No severity is written by the LLM lane.
6. PDF rendering requires a `report-approved` event matching the current findings,
   report, and theme fingerprint.
7. A debug root cause cannot be concluded without a recorded repro and a confirmed
   hypothesis.
8. Events are append-only (CI check, as in RAD).
9. In container mode with network `offline`, no lane or sandbox has a network
   interface (asserted by an eval lane that attempts a connection and must fail).
10. A run with any `partial`, `timeout`, or `tool-missing` lane cannot pass Gate 2
    without an `--accept-partial` reason, and the cover page lists the missing lanes.
11. Every file in `rules/lgpl/` matches its recorded upstream hash, and no rule
    outside it carries a copyleft or non-redistributable license (CI).

---

## 18. Success metrics

- Re-running a review on an unchanged fingerprint: 0 finding diffs.
- Judgment findings confirmed ÷ proposed (tracks LLM signal quality over time).
- False-positive rate per tool/rule (from dispositions) → feeds ruleset tuning.
- Triage tier wall clock on a ~100k LOC repo: < 30 min.
- Time from `radr init` to signed-off report for a standard audit.
- Remediation-plan items verified closed by `radr verify`.

---

## 19. Milestones

| M | Scope |
|---|---|
| **M1** ✅ ([as built](docs/m1-plan.md#as-built-2026-10-07)) | TypeScript project skeleton, determinism utilities + property tests (§15), dependency budget + `--ignore-scripts` CI check, engagement folder, hash-chained event log, source snapshot (mirror + read-only worktree), Gate 1, fingerprint, host-mode toolchain (`tools install`, `doctor`, `db sync`), `census` / `lint` (baseline mode) / `secrets` / `sca` lanes for TS/JS + Python, SARIF normalization, findings + dispositions, no-LLM mode |
| **M2** ✅ ([as built](docs/m2-plan.md#as-built-2026-10-07)) | `triage` tier + scorecard, rubric v1, Address report.md + PDF render, Gate 2, **build sandbox, then on top of it the `types` lane, `lint` project mode, and the `coverage` lane for TS/JS + Python** (recipe detection, `radr deps warm`, N-run stability), rubric auto-confirm + bulk disposition |
| **M3** | Container image, remaining lanes (`sast`, `maint`, `history`, `license`, `iac`, `hygiene`), Go/Rust/JVM/PHP/Ruby/.NET packs **including their build recipes and coverage tools** |
| **M4** | LLM lane (`triage`, drafting, judgment findings) with policy enforcement + evals |
| **M5** | Debug workflow (reuses the M2 sandbox for repro and `git bisect run`) |
| **M6** | `diff` tier (consultant-side, against a fork; §13), `verify` |

---

## 20. Open questions

1. ~~**Implementation language.**~~ **Resolved 2026-10-07:** TypeScript on Node 22+
   (see §15).
2. ~~**Tool name / CLI binary.**~~ **Resolved 2026-10-07:** product **RAD Review**,
   CLI **`radr`**, published as `@torchcodelab/radr`. No npm or PATH collisions;
   `rr` was avoided because the Mozilla record-and-replay debugger already uses it.
3. ~~**Branding.**~~ **Resolved 2026-10-07:** theme directories, TorchCodeLab
   default, selectable per engagement (white-label/partner/co-brand); theme hash
   frozen at Gate 2 (§12).
4. ~~**Coverage runs.**~~ **Resolved 2026-10-07:** coverage is measured in v1 in a
   shared build sandbox (§14.1a), shipping in M2 for TS/JS + Python and M3 for the
   other stacks. Imported CI coverage is an optional, labeled supplement.
5. ~~**History secrets on large repos.**~~ **Resolved 2026-10-07:** every non-triage
   tier scans full history (the `diff` tier scans the PR's commit range). Long runs
   are accepted. A safety-net timeout yields a typed `partial` outcome, never a
   silent cut. The scope fingerprint records the HEAD SHA, so "full history" is
   exactly defined.
6. ~~**Client-side execution.**~~ **Deferred past v1 (2026-10-07).** Notes for later:
   - Raw SARIF and secret findings contain code and secret values, so any export
     from the client side needs deterministic redaction (snippets and secrets
     replaced by hashes; `file:line` kept).
   - The report must state "client-executed" provenance, because tampering can't
     be ruled out.
   - v1 constraint: keep `raw/` and the findings schema redaction-friendly (snippets
     in separable fields, never baked into message text by our adapters).
7. ~~**Rule pack bootstrap.**~~ **Resolved 2026-10-07:** hybrid, CWE-driven strategy;
   top-10 CWE support bar per stack, with fixtures required (§14.2). Seed sources
   vetted in Appendix B.
8. ~~**Brakeman.**~~ **Resolved 2026-10-07:** v1 uses Opengrep with Ruby rules we
   write ourselves (no permissive Ruby rules exist), plus a plug-in that runs Brakeman under a license the client supplies. Rails SAST is
   labeled **partial** in the methodology section unless Brakeman ran.
   Reaffirmed after the rule vetting showed no permissively licensed Ruby rules exist
   (Appendix B): Brakeman is handled **as needed**, since Rails demand may be nil for
   a while. Until then, a Rails engagement's report states plainly that Ruby SAST
   is partial.
   **Trigger to revisit:** a specific Rails engagement where security is in scope, or
   Rails engagements recurring (e.g., 3 in a rolling 12 months).
9. ~~**Secrets scanner.**~~ **Resolved 2026-10-07:** gitleaks is the default.
   Betterleaks is adopted only after passing an **adoption gate**:
   - SARIF or stable JSON output, with an adapter golden test
   - recall at least equal to gitleaks on our secrets fixture corpus
     (`fixtures/secrets/`: synthetic keys and tokens across providers, including
     history-only secrets)
   - a false-positive count no higher than gitleaks' on the same corpus

   The switch ships as a toolchain version bump, so it changes the scope fingerprint
   and appears in every report's methodology section.
10. **LGPL-3.0 rules: decided 2026-10-07, pending counsel.** Included as an
    isolated sub-pack, `rules/lgpl/` (GitLab `rules/lgpl/` JS and Kotlin rules, plus
    njsscan/mobsfscan lineage where it adds coverage):
    - **Unmodified.** We don't edit these files. Tuning goes in separate override
      rules or path excludes in our own pack. If an edit is ever unavoidable, the
      modified file is published in a public `radr-rules-lgpl` repository.
    - **Notices.** Original license headers are kept; the LGPL-3.0 text and the
      sources are listed in `THIRD_PARTY_NOTICES`.
    - **Fingerprinted separately.** `rules/lgpl/` has its own version and hash in
      the scope fingerprint, and the methodology appendix names it.
    - **Release gate.** Consultant-run engagements may use the sub-pack now.
      Distributing it to third parties (e.g., a future client-CI mode, #11) is
      blocked until counsel signs off. v1 doesn't distribute the image, so the gate
      doesn't block anything in v1. If counsel says no,
      the sub-pack is dropped, JS and Kotlin rules are authored in-house, and the
      gap table in Appendix B applies unchanged.
11. ~~**`diff` tier in client CI.**~~ **Deferred past v1 (2026-10-07).** v1 runs
    PR review consultant-side against a fork (§13). Questions to answer when this
    is revisited:
    - who approves Gate 1 for a long-running PR-review retainer (once per retainer,
      re-approved on toolchain or rule bumps?)
    - where the event log, baseline, and findings live (client repo branch, CI
      artifacts, or the consultant's store)
    - whose LLM credentials are used, and how LLM policy is enforced in the client's
      runner
    - distributing the image to the client, which triggers GPL source-offer
      obligations (§14.3) and the LGPL release gate (#10)

---

## Appendix A — Tool vetting notes (2026-10-07)

| Tool | License | Verdict |
|---|---|---|
| Opengrep | LGPL-2.1 | **Default SAST engine**; active; SARIF w/ fingerprints |
| Semgrep CE engine | LGPL-2.1 | OK; cross-file taint now paid-only |
| Semgrep Registry rules | Semgrep Rules License v1.0 | **Do not bundle**; runtime fetch only |
| CodeQL | Proprietary | **Client-GHAS only** |
| Brakeman | Brakeman Public Use License | **Client/paid license only** |
| Security Code Scan (.NET) | LGPL-3.0 | **Exclude** — unmaintained |
| tfsec | MIT | **Exclude** — deprecated into Trivy |
| Trivy | Apache-2.0 | OK, digest-pinned only (2026 compromise) |
| KICS | Apache-2.0 | Exclude pending trust (2026 image poisoning) |
| TruffleHog | AGPL-3.0 | OK as process; `--no-verification` mandatory |
| gitleaks | MIT | Default; frozen upstream |
| osv-scanner v2, syft, grype, Checkov, ScanCode | Apache-2.0 | Defaults |
| npm audit / pip-audit / composer audit / dotnet --vulnerable | various | Network mode only |
| OpenSSF Scorecard | Apache-2.0 | `--local` offline subset; full needs API |
| Pernosco | Proprietary SaaS | Exclude (code leaves machine) |
| pandoc + Typst, sarif-tools, SARIF Multitool | GPL-2.0+/Apache-2.0/MIT | Defaults |

Sources: docs.semgrep.dev/licensing, semgrep.dev/legal/rules-license,
github.com/opengrep/opengrep, github.com/github/codeql-cli-binaries (LICENSE.md),
github.com/presidentbeef/brakeman (LICENSE.md), gitlab.com/gitlab-org/gitlab/-/issues/390416,
aquasec.com (Trivy supply-chain advisory, CVE-2026-33634),
google.github.io/osv-scanner-v1/experimental/offline-mode, github.com/ossf/scorecard,
github.com/microsoft/sarif-tools. Licenses of common permissive tools were taken from
SPDX metadata and not re-fetched. Confirm each against its LICENSE file when writing
the pin manifest.

---

## Appendix B — Rule pack seed sources (vetted 2026-10-07)

How these were checked: each LICENSE file was read from the repository, per-file
license headers were counted, and fixtures were counted by searching for
`ruleid:`/`ok:` annotations. **This is not legal advice. Have counsel confirm before
the pack ships.**

### Usable (permissive: bundle with notices)

| Source | License | Coverage | CWE/OWASP | Fixtures | Notes |
|---|---|---|---|---|---|
| GitLab sast-rules: **only files whose header says `License: MIT` or `License: Apache 2.0`** | MIT / Apache-2.0 (per file) | ~270 rules: py 68, java 55, scala 87, cs 22, js 11, go 26 (gosec-derived) | Y / Y | Y | Primary seed. **Filter on the per-file header, not the root LICENSE.** |
| elttam/semgrep-rules | MIT | 100: java 43, generic 15, go 14, js/ts 13, py 5, cs 5 | partial | Y | Copyright line says "Semgrep" (looks like a copied template); record it in provenance |
| 0xdea/semgrep-rules | MIT | 50: C/C++ | Y / Y | Y | Only for native-code engagements |
| dgryski/semgrep-go | MIT | 66: Go correctness | N | N | Needs CWE tags and fixtures written before inclusion |
| AikidoSec/opengrep-rules | MIT | 2: GitHub Actions / npm publishing | N | N | CI supply-chain rules |
| federicodotta/semgrep-rules | MIT | 11: php 7, kotlin 3 | partial | N | Stale (2023). Validate before use |

### Included pending counsel (LGPL-3.0 sub-pack, unmodified)

GitLab `rules/lgpl/` (js 83, kotlin 58) and its likely upstreams njsscan and
mobsfscan. These fill the JS and Kotlin gaps. They live in the isolated `rules/lgpl/`
sub-pack, under the conditions and release gate in §20 #10.

### Excluded

| Source | Why |
|---|---|
| semgrep/semgrep-rules | Semgrep Rules License v1.0: no redistribution, no "as a service" |
| opengrep/opengrep-rules, amplify-security fork | LGPL-2.1 + Commons Clause: no selling (including consulting); archived; contains a proprietary Semgrep rule |
| GitLab `rules/lgpl-cc/` (ruby 40, php 9, java 39, py 6) | Commons Clause |
| GitLab `c/` (flawfinder-derived), `rules/gitlab/` | GPL-2.0; GitLab EE proprietary |
| trailofbits/semgrep-rules | AGPL-3.0 |
| mindedsecurity android rules | GPL-3.0 |
| Decurity/semgrep-smart-contracts | CC BY-NC-SA 4.0 (non-commercial) |
| kondukto-io/semgrep-rules | No LICENSE file (all rights reserved) |
| patched-codes/semgrep-rules | Stale copy of GitLab's set. Use upstream instead |

### Gaps after the permissive seed (where we author rules)

| Stack | State | Must author |
|---|---|---|
| TS/JS | **Thin** (~24 rules) | Express, Node core, React/Next.js taint (unless LGPL is accepted) |
| Python | Reasonable (~73) | Django, Flask, FastAPI framework and taint rules |
| Go | Fair (~106 incl. correctness) | gin/echo web taint |
| Rust | **None** | Everything (unsafe, FFI, deserialization, command/SQL injection) |
| Java | Fair (~98) | Spring taint gaps |
| Kotlin | **Gap** (permissive) | Most (unless LGPL is accepted) |
| PHP | **Major gap** (~8, stale) | Most. Psalm taint (MIT) carries PHP security in the meantime |
| Ruby | **Major gap** (0) | Everything. This strengthens the Brakeman revisit trigger (§20 #8) |
| C# | Thin (~27) | ASP.NET Core and Entity Framework taint |

### Pack hygiene

- Keep each rule's license header and copyright notice.
- Ship `THIRD_PARTY_NOTICES` and the Apache-2.0 text for gosec-derived rules.
- A CI license check rejects any rule whose header or `metadata.license` contains
  `Commons Clause`, `GPL`, `AGPL`, or `proprietary`. LGPL-3.0 is accepted **only**
  inside `rules/lgpl/`, and a CI check fails if any file there differs from its
  recorded upstream hash (enforcing "unmodified").
