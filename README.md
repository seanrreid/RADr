# RAD Review (`radr`)

**Review, Address, Debug.** Deterministic code-review engagements for consulting.

> RAD ships determinism, not intelligence. Tools decide findings; the model explains them.

`radr` turns a client code review into a reproducible, auditable engagement:

- A pinned, checksum-verified toolchain produces every finding.
- An append-only, hash-chained event log is the authority for every gate and decision.
- Re-running the same approved scope gives byte-identical findings, regardless of machine,
  timezone, or locale.

See [PRD.md](PRD.md) for the full design and [docs/m1-plan.md](docs/m1-plan.md) for the
current milestone.

**Status: M2** covers Review and Address for TS/JS + Python:
- the deterministic core and static lanes
- a build sandbox for types and coverage
- rubric v1, with EPSS/KEV exploitability promotion
- a triage scorecard
- the client report and remediation plan, Gate 2 sign-off, and a branded PDF

The container toolchain image and other stacks (M3), the LLM lane (M4), Debug (M5), and
PR review and verify (M6) are still to come.

## Requirements

- Node 22+ (24 LTS recommended; see `.nvmrc`)
- git
- macOS or Linux, on arm64 or x64
- Optional: Podman (preferred) or Docker, for the sandboxed lanes (types, coverage, lint
  project mode). Without one, static lanes still run and sandboxed lanes are skipped.

## Install

```bash
npm ci --ignore-scripts
npm run build
alias radr="node $PWD/bin/radr.js"
```

## Quickstart

```bash
# One-time, on a connected machine:
radr tools install        # pinned, sha256-verified toolchain (+ sandbox images if Podman/Docker is up)
radr db sync              # snapshot OSV (npm, PyPI), EPSS, and CISA KEV for offline scans

# Per engagement (export RADR_ENGAGEMENT=acme-health-2026q4 to drop the -e flags):
radr init acme health-2026q4
radr scope --source ~/forks/acme-app       # a fork/clone of the client repo; proposes lanes + build recipe
$EDITOR ~/radr/engagements/acme-health-2026q4/engagement.yml   # review the scope and recipe
radr deps warm                              # sandboxed lanes: cache dependencies (network)
radr scope                                  # pin the warmed cache
radr approve scope                          # Gate 1: freezes the fingerprint
radr review                                 # all lanes; routine findings auto-confirm (rubric v1)
radr scorecard                              # triage verdict
radr findings --state pending               # the review set: decisions only you can make
radr disposition F-0003 confirmed
radr disposition --lane lint dismissed --reason "generated code"   # bulk, shared reason
radr address                                # report.md + remediation.md (edit the keep-blocks)
radr approve report                         # Gate 2 (or --accept-partial "<reason>")
radr render                                 # report.pdf + remediation.pdf
```

For a quick **"is this any good?"** verdict, set `engagement_type: triage` and
`tier: triage` in `engagement.yml`. Triage runs a fixed set of fast static lanes, scans
secrets at HEAD only, and produces a one-page report.

`-e` can be omitted if `RADR_ENGAGEMENT` is set, or if you run commands from inside the
engagement folder.

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

Static lanes run in host mode, where network isolation is **declared**, not enforced (sandboxed
lanes are enforced offline). Enforced offline static lanes
arrive with the container toolchain in M3.

## Layout

```
$RADR_HOME (default ~/radr)
├── tools/                       pinned toolchain (radr tools install)
├── snapshots/osv/<id>/          OSV DB snapshots (radr db sync)
└── engagements/<client>-<slug>/
    ├── engagement.yml           the scope (Gate 1)
    ├── events.jsonl             append-only, hash-chained authority
    ├── toolchain.lock, snapshots.lock
    ├── source/mirror.git, source/worktree/   radr-owned source snapshot (read-only)
    ├── raw/<run>/<lane>.attempt-N/           untouched tool output
    ├── findings.jsonl           normalized findings + per-run sets
    ├── metrics/<run>/<lane>.json  lane metrics (census, history, tests, coverage)
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
```

Install scripts are disabled everywhere (`.npmrc`). Adding a runtime dependency requires an
entry in [docs/dependencies.md](docs/dependencies.md).
