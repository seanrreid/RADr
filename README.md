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

**Status: M1** covers the deterministic core and first lanes for TS/JS + Python. Reports
(Address), the LLM lane, Debug, and the other stacks arrive in M2–M6.

## Requirements

- Node 22+ (24 LTS recommended; see `.nvmrc`)
- git
- macOS or Linux, on arm64 or x64

## Install

```bash
npm ci --ignore-scripts
npm run build
alias radr="node $PWD/bin/radr.js"
```

## Quickstart

```bash
# One-time, on a connected machine:
radr tools install        # pinned scc, gitleaks, osv-scanner, syft, ruff, eslint; sha256-verified
radr db sync              # snapshot the OSV vulnerability DBs (npm, PyPI) for offline scans

# Per engagement:
radr init acme health-2026q4
radr scope -e acme-health-2026q4 --source ~/forks/acme-app   # a fork/clone of the client repo
$EDITOR ~/radr/engagements/acme-health-2026q4/engagement.yml   # review the proposed scope
radr approve scope -e acme-health-2026q4                      # Gate 1: freezes the fingerprint
radr review -e acme-health-2026q4                             # runs census, lint, secrets, sca
radr findings -e acme-health-2026q4 --severity medium
radr disposition F-0003 confirmed -e acme-health-2026q4
radr disposition F-0007 dismissed --reason "test fixture" -e acme-health-2026q4
radr status -e acme-health-2026q4
```

`-e` can be omitted if `RADR_ENGAGEMENT` is set, or if you run commands from inside the
engagement folder.

## What M1 guarantees

| Guarantee | How it's enforced |
|---|---|
| No lane runs without an approved scope | The scope gate is folded from the hash-chained event log. It's re-checked before **every** lane attempt. |
| Any scope change re-opens Gate 1 | The fingerprint covers `engagement.yml`, `toolchain.lock`, and `snapshots.lock`. |
| Lanes scan exactly the approved commit | radr keeps its own mirror and a read-only worktree, verified clean at the approved SHA. |
| Tools are what was approved | Tool binaries are checksum-verified at install. A drifted or missing tool aborts the run. |
| Offline vulnerability data is pinned | OSV snapshots are content-addressed and pinned per engagement. |
| Nothing fails silently | Every tool outcome resolves through `policy/matrix.yml`, with no default fallthrough. |
| Secrets are never written in clear | gitleaks runs with `--redact`, and the adapter refuses unredacted output. |
| Severity is never guessed | The rubric maps every (tool, severity) pair explicitly. Unmapped pairs refuse. |
| Same scope, same findings | The findings-set hash is identical across homes, `TZ`, and `LANG` (tested end to end). |

Network enforcement in M1 (host mode) is **declared**, not enforced. Enforced offline runs
arrive with the container in M3.

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
