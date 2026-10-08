# RAD Review (`radr`)

**Read, Address, Debug.** Deterministic code-review engagements for consulting.

`radr` is a RAD review: you **Read** the code, **Address** what you found, and **Debug**
what needs hands-on work.

> RAD ships determinism, not intelligence. Tools decide findings; the model explains them.

`radr` turns a client code review into a reproducible, auditable engagement:

- A pinned, checksum-verified toolchain produces every finding.
- An append-only, hash-chained event log is the authority for every gate and decision.
- Re-running the same approved scope gives byte-identical findings, regardless of machine,
  timezone, or locale.

See [PRD.md](PRD.md) for the full design. Milestone plans with as-built notes:
[M1](docs/m1-plan.md), [M2](docs/m2-plan.md), [M3](docs/m3-plan.md), [M4](docs/m4-plan.md), [M5](docs/m5-plan.md).

**Status: M5.** Read, Address and Debug work for **TS/JS, Python, Go, Rust,
JVM (Java/Kotlin), PHP, Ruby, and .NET**:

- the deterministic core
- static lanes:
  - census, lint, secrets, dependencies + SBOM, history, tests
  - SAST (Opengrep with a curated, fixture-tested rule pack)
  - maintainability (complexity, duplication)
  - licenses, IaC, repository hygiene
- a build sandbox per stack for type checks, linters that need the toolchain, and tests
  (coverage for TS/JS, Python, and Go)
- **container mode:** every static lane runs in a locally built, checksum-verified
  toolchain image with the network denied
- rubric v1 with EPSS/KEV promotion, the triage scorecard, and the client report with its
  remediation plan, Gate 2 sign-off, and a branded PDF
- **an optional LLM lane** (per engagement): explanations, clusters and proposed
  dispositions; judgment findings a person must confirm; drafts of the report's prose
  blocks. The model never sets severity or makes a decision.
- **Debug:** a root-cause workflow for one bug. Reproduce in the sandbox, bisect, test
  hypotheses with recorded experiments, conclude (gated), and deliver a regression test.

Still to come: PR review and `radr verify` (M6).

## Requirements

- Node 22+ (24 LTS recommended; see `.nvmrc`)
- git
- macOS or Linux, on arm64 or x64
- python3 on PATH (host mode: runs lizard for the maintainability lane)
- Optional: Podman (preferred) or Docker, for the sandboxed lanes (types, coverage, the
  stack linters, lint project mode) and for container mode. Without one, static lanes still
  run in host mode and sandboxed lanes are skipped.

## Install

```bash
npm ci --ignore-scripts
npm run build
alias radr="node $PWD/bin/radr.js"
```

## Quickstart

```bash
# One-time, on a connected machine:
radr tools install        # pinned, sha256-verified toolchain (+ node/python sandbox images if Podman/Docker is up)
radr tools build-image    # optional: the container toolchain image (container mode; license and iac lanes)
radr db sync              # snapshot OSV (8 ecosystems), EPSS, and CISA KEV for offline scans

# Per engagement (export RADR_ENGAGEMENT=acme-health-2026q4 to drop the -e flags):
radr init acme health-2026q4
radr scope --source ~/forks/acme-app       # a fork/clone of the client repo; proposes lanes + build recipe
$EDITOR ~/radr/engagements/acme-health-2026q4/engagement.yml   # review the scope and recipe
radr deps warm                              # sandboxed lanes: build/pull stack images, cache dependencies (network)
radr scope                                  # pin the warmed cache
radr approve scope                          # Gate 1: freezes the fingerprint

# Read
radr review                                 # all lanes; routine findings auto-confirm (rubric v2 for new scopes)
radr scorecard                              # triage verdict
radr findings --state pending               # the review set: decisions only you can make
radr disposition F-0003 confirmed
radr disposition --lane lint dismissed --reason "generated code"   # bulk, shared reason

# Optional, with llm_policy metadata-only or code-allowed (see "The LLM lane"):
radr triage                                 # explanations, clusters, proposals, judgment findings (J-…)
radr disposition J-0001 pending             # accept a proposed judgment for review (or dismiss it)

# Address
radr address                                # report.md + remediation.md (edit the keep-blocks)
radr address --draft                        # optional: LLM drafts of untouched prose blocks
radr approve report                         # Gate 2 (or --accept-partial "<reason>")
radr render                                 # report.pdf + remediation.pdf
```

## Debug

A root-cause workflow for one bug, inside an engagement with an approved scope: from a
finding (`--from-finding F-0003`) or an issue (`--issue "…"`). For a debug on its own, use
`engagement_type: debug` with `lanes: []`. Every step is a sandbox run or a recorded
decision, and gates enforce the order.

```bash
radr debug open --issue "checkout total is off by one cent" --expected "…" --actual "…"
$EDITOR debug/D-0001/repro/repro.sh         # exit 0 = bug absent, 125 = can't tell, else present
radr debug repro D-0001                     # runs in the build sandbox at the approved commit
radr debug bisect D-0001 --good v2.3.0      # first bad commit (≤ 512 candidates; skips → a range)
radr debug propose D-0001 "rounding happens before tax"
radr debug experiment D-0001 --hypothesis H-0001 rounding.sh   # debug/D-0001/experiments/rounding.sh
radr debug decide D-0001 H-0001 confirmed --run DR-0004 --reason "…"
radr debug conclude D-0001 root-caused --hypothesis H-0001 --summary "…" [--to-plan]
radr debug guard D-0001 [--fix-commit <sha>]  # guard/test.patch must fail without the fix, pass with it
radr debug show D-0001                      # or: radr debug report D-0001 → debug/D-0001/root-cause.md
```

- **Gates:** a hypothesis is decided only by an experiment recorded against it, and
  confirmed only after the bug was reproduced. A root cause needs a reproducing run and a
  confirmed hypothesis. "Cannot reproduce" is a valid conclusion, with the attempts on record.
- **The repro is frozen once it reproduces:** bisect and the guard rerun exactly that script.
- **radr never writes the fix.** The consultant supplies `guard/fix.patch` (or a fix commit);
  `guard/test.patch` is the deliverable.
- `radr debug suggest D-0001` (LLM policy permitting) proposes hypotheses and experiments,
  labelled `[LLM]`. They're proposals like any other.

For a quick **"is this any good?"** verdict, set `engagement_type: triage` and
`tier: triage` in `engagement.yml`. Triage runs a fixed set of fast static lanes, scans
secrets at HEAD only, and produces a one-page report.

`-e` can be omitted if `RADR_ENGAGEMENT` is set, or if you run commands from inside the
engagement folder.

**Container mode** (`network: { mode: offline, enforcement: container }` in
`engagement.yml`) runs every static lane in the toolchain image with `--network=none`. Host
and container modes produce identical findings for the same scope (tested end to end).

These lanes are opt-in:

- **`license` and `iac`** need container mode, because ScanCode and Checkov live only in
  the image.
- **`hygiene`** (OpenSSF Scorecard, offline checks) can be added in either mode. It never
  makes a run partial.

`radr rules coverage` shows the SAST support bar per stack: every top-10 weakness target
has a fixture-tested rule. The report's methodology section states the same.

## The LLM lane (optional)

An engagement's `llm_policy` is `off` (the default), `metadata-only` (rule IDs, paths,
lines and metrics; no source), or `code-allowed` (the anchored lines ±5, never from a file
the secrets lane flagged). The policy is part of the scope fingerprint. Under
`metadata-only`, a tool message that quotes the matched code is replaced by its rule ID.

- **`radr triage`** sends the run's findings in batches. The model's explanations, clusters
  and proposed dispositions are shown by `radr findings`, labelled `[LLM]`, and never change
  a finding. **Judgment findings** it proposes (`J-0001`, …) must point at a real line range
  in scope; they start `proposed`, and you accept (`pending`) or dismiss each one. Their
  severity comes from the rubric (`medium`, rubric v2); change it with
  `radr severity J-0001 high --reason "…"`. Gate 2 refuses while any is undecided.
- **`radr address --draft`** drafts the executive summary, recommendations and plan notes,
  only where you haven't written anything. Each draft carries a `<!-- radr:llm-draft -->`
  marker; Gate 2 refuses until you've read it and deleted the marker.
- **`radr status`** shows how many agent calls returned valid output and how many proposed
  judgment findings you kept.

radr runs one agent command, never through a shell, from an empty temp directory, with
only `PATH`, `HOME` and the variables you name in `RADR_AGENT_ENV`. Every prompt and
response is kept under the engagement's `llm/`, and each call is an `llm-call` event.
For Claude Code (checked against v2.1.293):

```bash
export RADR_AGENT_CMD='["claude", "-p", "--bare", "--tools", "", "--strict-mcp-config",
  "--no-session-persistence", "--model", "claude-sonnet-5-5",
  "--output-format", "json", "--json-schema", "{schema}"]'
export RADR_AGENT_OUTPUT=claude-json       # read Claude Code's JSON envelope
export RADR_AGENT_ENV=ANTHROPIC_API_KEY    # --bare authenticates only with an API key
```

`{schema}` is replaced by each call's response schema; radr validates the response
against it as well. A response that doesn't validate is retried once, then that batch is
marked partial (`policy/matrix.yml`, row `llm`).

## What radr guarantees

| Guarantee | How it's enforced |
|---|---|
| Client code runs only in isolation | The sandbox is non-root, with `--network=none` (offline), a read-only source, no capabilities, and resource limits. Installs come only from the pinned dependency cache. |
| The client report reflects the record | Gate 2 refuses stale reports, pending findings, review-set findings no person has decided, and unaccepted partial runs. It freezes the findings, dispositions, report, plan, and theme. |
| What you approved is what the client gets | `render` refuses if anything changed after sign-off. PDFs are byte-identical across renders. |
| Severity follows exploitability | Rubric v1 promotes known-exploited (CISA KEV) issues to critical, and EPSS ≥ 10% by one step. It only ever promotes, and every input is recorded. |
| No lane runs without an approved scope | The scope gate is folded from the hash-chained event log. It's re-checked before **every** lane attempt. |
| Any scope change re-opens Gate 1 | The fingerprint covers `engagement.yml`, `toolchain.lock`, and `snapshots.lock`. |
| Lanes scan exactly the approved commit | radr keeps its own mirror and a read-only worktree, verified clean at the approved SHA. |
| Tools are what was approved | Tool binaries are checksum-verified at install. A drifted or missing tool aborts the run. |
| Offline vulnerability data is pinned | OSV snapshots are content-addressed and pinned per engagement. |
| Nothing fails silently | Every tool outcome resolves through `policy/matrix.yml`, with no default fallthrough. |
| Secrets are never written in clear | gitleaks runs with `--redact`, and the adapter refuses unredacted output. |
| Severity is never guessed | The rubric maps every (tool, severity) pair explicitly. Unmapped pairs refuse. |
| Same scope, same findings | The findings-set hash is identical across homes, `TZ`, and `LANG` (tested end to end). |
| Debug conclusions rest on evidence | Every repro, bisect step, experiment and guard run is a sandbox run whose script, log and exit code are hashed into the event log. Root cause needs a reproducing run and a confirmed hypothesis (invariant 7). |
| The LLM proposes, people decide | Under policy `off` the agent is never spawned. Agent output can't set a severity, a disposition, or a gate (ESLint boundary + an adversarial eval). Judgment findings are kept apart from tool findings, so they never change the findings-set hash. |
| You can audit what left the machine | Every prompt and response is stored in `llm/`, hash-linked from an `llm-call` event. A `metadata-only` prompt quotes no client code (checked against the whole repo in tests). |

In host mode, static lanes' network isolation is **declared**, not enforced. Container mode
enforces it (`--network=none`), and an end-to-end test proves a lane cannot reach the
network. Sandboxed lanes are always enforced offline.

## Layout

```
$RADR_HOME (default ~/radr)
├── tools/                       pinned toolchain (radr tools install)
├── build/                       image build contexts (toolchain image, stack sandboxes)
├── snapshots/osv/<id>/          OSV DB snapshots (radr db sync)
├── snapshots/deps/<engagement>/ warmed dependency caches (radr deps warm)
└── engagements/<client>-<slug>/
    ├── engagement.yml           the scope (Gate 1)
    ├── events.jsonl             append-only, hash-chained authority
    ├── toolchain.lock, snapshots.lock
    ├── source/mirror.git, source/worktree/   radr-owned source snapshot (read-only)
    ├── raw/<run>/<lane>.attempt-N/           Read: untouched tool output
    ├── findings.jsonl           normalized findings + per-run sets
    ├── metrics/<run>/<lane>.json  lane metrics (census, history, tests, coverage)
    ├── llm/                     LLM lane prompts and responses (when llm_policy is not off)
    ├── report/report.md, report.pdf        Address: the client report (Gate 2)
    ├── plan/remediation.md, remediation.pdf
    └── artifacts/               SBOMs and other non-finding outputs
```

## Development

```bash
npm test                                       # unit tests (e2e skipped)
RADR_HOME=/tmp/radr-tools node bin/radr.js tools install
RADR_E2E_TOOLS=/tmp/radr-tools npm test        # + real-tools e2e (AC17, AC18)
npm run lint                                   # includes the determinism guardrails
npm run check:deps                             # runtime dependency budget (≤ 8)
UPDATE_GOLDEN=1 npm test                       # regenerate adapter goldens (review the diff!)
node dist/scripts/pin-toolchain.js             # maintainers: re-pin toolchain/manifest.yml
node dist/scripts/pin-images.js                # … sandbox base images (index digests)
node dist/scripts/pin-sandbox-tools.js         # … tools baked into the stack sandbox images
scripts/pin-rubocop.sh                         # … RuboCop's checksummed Gemfile.lock
OPENGREP=<path> node dist/scripts/check-rules.js   # rule pack: provenance, licenses, every fixture
RADR_E2E_TOOLS=/tmp/radr-tools RADR_E2E_SANDBOX=1 npm test   # + sandbox and container e2e (needs Podman/Docker)
```

Install scripts are disabled everywhere (`.npmrc`). Adding a runtime dependency requires an
entry in [docs/dependencies.md](docs/dependencies.md).
