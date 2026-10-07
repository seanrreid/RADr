# M2 Plan: Triage, sandbox, Address, Gate 2, PDF

**Status:** implemented (2026-10-07). See "As built" at the end.
**Source:** [PRD.md](../PRD.md) §19 (M2), §5 (tiers), §8 (dispositions), §10 (severity), §12 (Address), §14.1a (sandbox)
**Builds on:** [M1](m1-plan.md) (as built)
**Date:** 2026-10-07

## Goal

Turn findings into a **signed-off client deliverable**:

```
radr review (triage | standard)  →  rubric v1 auto-confirm + bulk disposition
  →  radr address (report.md + remediation.md)  →  radr approve report (Gate 2)  →  radr render (PDF)
```

M2 also adds the **build sandbox**, which the `types` lane, lint project mode, and the
`coverage` lane run in. They run client code, so the sandbox has no network unless the scope
says otherwise.

## Decisions (from check-in, 2026-10-07)

- **Sandbox runtime:** Podman or Docker, whichever is found (Podman preferred). Only
  sandboxed lanes need it. Static lanes keep working without a container runtime.
- **Theme:** derived from torchcodelab.com. Primary `#f1362a`, accent `#ac1694`, gradient
  `#b81c83 → #ac1694`, base `#040404` / `#2f2929`; Raleway for headings, Montserrat for
  body; the site logo. Dark cover, light body pages (printable).
- **Check-in:** after M2.

## In scope

1. **Rubric v1 engine** (`rubric/v1.yml`, drafted in M1 docs): base map, rule overrides,
   CVSS bands, KEV/EPSS promotion, path modifiers, metric findings, disposition routing,
   scorecard, effort.
2. **Vulnerability context snapshots:** `radr db sync` adds the dated EPSS file and the CISA
   KEV catalog. Both are content-addressed and pinned in `snapshots.lock`.
3. **Auto-confirm + bulk disposition** (PRD §8): the actor is `rubric@v1`; bulk selection
   is by `--rule/--category/--path/--lane`.
4. **`history` lane** (built-in `git log` analyzer, no new tool): churn, churn × complexity
   hotspots (complexity from scc), and bus factor.
5. **`tests` lane** (static): test files and test LOC vs. source LOC.
6. **`triage` tier:** a fixed lane set and the scorecard (rubric v1 §7); metrics with no
   lane yet are shown grey ("unavailable") and never guessed.
7. **Build sandbox:** runtime detection, per-stack base images pinned by digest, approved
   build recipe in `engagement.yml`, `radr deps warm` (dependency cache snapshot), and no
   network in `offline` mode.
8. **Sandboxed lanes (TS/JS + Python):**
   - `types`: tsc from the client's own install; pyright pinned in node-tools
   - `lint` project mode: the client's own eslint/ruff config
   - `coverage`: c8/istanbul or pytest-cov, run N=2 times, with stable/unstable
     classification and flaky tests as findings
9. **Address:** a deterministic `report.md` (per engagement-type template) and
   `remediation.md` (waves, effort, re-runnable acceptance criteria). Consultant-editable
   prose blocks are preserved across regeneration.
10. **Gate 2:** `radr approve report` freezes the hashes of the findings set,
    `report.md`, `remediation.md`, and the theme. It refuses while findings are
    pending/proposed, or while the run is partial without `--accept-partial`.
11. **PDF:** pandoc 3.12 (Markdown → Typst) + Typst 0.15.1, pinned and checksum-verified.
    The theme is under `themes/torchcodelab/`. Rendering refuses without a matching Gate 2.

## Out of scope (later)

Container toolchain image and enforced-offline static lanes (M3); other stacks and the
`sast`/`maint`/`license`/`iac`/`hygiene` lanes (M3); LLM drafting (M4); Debug (M5); `diff`
and `verify` (M6).

---

## Acceptance criteria

- **AC1:** Rubric v1 loads, is schema-validated, and maps every (tool, severity) the enabled
  lanes emit. Rule overrides, path modifiers (demote/promote, one step, clamped), and
  CVSS→severity with KEV→critical and EPSS ≥ 1000 bp → +1 all have tests, including the
  boundary cases.
- **AC2:** `radr db sync` snapshots EPSS and KEV next to OSV. Each is content-addressed and
  verified on use. A missing EPSS/KEV snapshot is a visible fail-open gap (P7), never a crash.
- **AC3:** After a review, the auto-confirm classes move `pending → confirmed` as
  `rubric@v1`. The review set (sast, secrets, iac, license, judgment, ≥ high) never
  auto-confirms.
- **AC4:** Bulk disposition writes one event per finding, all with the shared reason, and
  refuses a selector that matches nothing.
- **AC5:** The `history` lane's churn, hotspot, and bus-factor metrics are deterministic for
  a fixture repo with fixed dates, and are bounded by the approved SHA's ancestry.
- **AC6:** The `triage` tier runs only its fixed lanes and produces a scorecard (green/amber/
  red/grey per metric, plus a verdict) that matches rubric v1 §7 on fixture data.
- **AC7:** The sandbox refuses to start without a runtime. It runs as non-root with
  `--network=none` in offline mode, a read-only source mount, and CPU/memory/time limits.
  Image digests and the recipe are part of the scope fingerprint.
- **AC8:** `radr deps warm` produces a content-addressed dependency cache. An offline
  `coverage`/`types` run installs from it with no network.
- **AC9:** The coverage lane runs N=2 and classifies the result `stable` (identical pass/fail
  sets and coverage hashes) or `unstable` (findings for flaky tests). A failed build is a
  finding, not a crash.
- **AC10:** `radr address` is deterministic: the same findings, dispositions, and rubric give
  byte-identical `report.md` and `remediation.md`. Consultant prose between
  `<!-- radr:keep id=… -->` markers survives regeneration.
- **AC11:** `radr approve report` refuses on pending/proposed findings, on an unaccepted
  partial run, and on missing reports. On success it freezes the hashes of the findings
  set, report, remediation plan, and theme.
- **AC12:** `radr render` refuses without a matching `report-approved` event. It produces a
  PDF with pinned pandoc + Typst, `--ignore-system-fonts`, and a fixed creation timestamp,
  and the bytes are identical across two renders.
- **AC13:** End-to-end: the fixture repo goes through triage → standard → address →
  approve → render using the real tools (the sandbox e2e runs where a container runtime
  exists).

## Wave plan

- **W0 — Rubric v1 + vulnerability context:** rubric v1 schema/engine; EPSS/KEV in
  `db sync` and `snapshots.lock`; auto-confirm; bulk disposition.
- **W1 — Static metrics + triage:** `history` lane; `tests` lane; the `triage` tier and
  scorecard.
- **W2 — Sandbox:** runtime detection; pinned base images; recipe detection and approval;
  `deps warm`; sandbox exec with its isolation flags.
- **W3 — Sandboxed lanes:** `types`; lint project mode; `coverage` with N-run stability.
- **W4 — Address + Gate 2:** report/remediation generators and templates; keep-blocks;
  `approve report`; `--accept-partial`.
- **W5 — PDF:** pin pandoc + Typst (asset digests from the GitHub release API, recorded as
  such); tar.xz/zip install support; the TorchCodeLab theme; `render`.
- **W6 — E2E + docs:** AC13; determinism of report and PDF bytes; README and plan "As built".

---

## As built (2026-10-07)

### Verification

- 170 tests pass on macOS arm64. That includes the real-tools e2e (M1 pipeline plus
  address → approve → render with byte-identical PDFs) and the real-Podman sandbox e2e
  (offline types + stable coverage for both stacks).
- A triage engagement on the M1 fixture runs end to end: HEAD-only secrets, the scorecard,
  and a 3-page PDF.
- **Linux arm64** (Node 24.21 container): real toolchain incl. pandoc/Typst installs and passes
  `doctor`; all 170 tests pass incl. the real-tools e2e with PDF render; lint clean. The
  sandbox e2e needs a runtime inside the container, so it is covered by macOS/Podman here and
  by CI on ubuntu (Docker). Linux x64 and CI: pending a remote.

### Acceptance criteria

| AC | Where |
|---|---|
| AC1 rubric v1 | `rubric/v1.yml`, `src/rubric/rubric.ts`; boundaries in `test/unit/rubric-v1.test.ts` |
| AC2 EPSS/KEV | `src/toolchain/vulnctx.ts` (string-arithmetic basis points, content-addressed, fail-open notes) |
| AC3 auto-confirm | runner `applyAutoConfirm`; actor `rubric@v1`; never the review set |
| AC4 bulk disposition | `radr disposition --rule/--category/--lane/--path … --reason` |
| AC5 history | `src/lanes/metrics.ts` (window anchored to the approved commit's date) |
| AC6 triage + scorecard | fixed lane set, `src/address/scorecard.ts`, `radr scorecard` |
| AC7 sandbox isolation | `src/sandbox/runtime.ts`; flags pinned by unit tests; real Podman e2e |
| AC8 deps warm | `src/sandbox/deps.ts`; offline installs from the pinned cache |
| AC9 coverage stability | N=2 runs, identical exit codes + coverage hashes ⇒ stable |
| AC10 address | `src/address/report.ts` + `plan.ts`; byte-identical regeneration; keep-blocks |
| AC11 Gate 2 | `src/address/gate2.ts` |
| AC12 render | `src/address/render.ts`; `themes/torchcodelab/` |
| AC13 e2e | `test/e2e/pipeline.test.ts`, `test/e2e/sandbox.test.ts` |

### Deviations from this plan

| Plan | As built | Why |
|---|---|---|
| pyright for Python types | **mypy** (pinned; installed from the dependency cache) | The Python sandbox image has no Node; mypy installs with pip. pyright also pulled in an install script |
| Flaky tests listed individually | Suite-level `unstable-results` finding (exit codes + coverage hashes differ across 2 runs) | Per-test pass/fail sets need a runner-specific reporter for each stack; deferred |
| `coverage` in auto-confirm | Removed | A failing or flaky suite needs a person's eyes |
| Gate 2 freezes findings/report/plan/theme | Also freezes a **dispositions hash** | Without it, a report generated before a decision could be signed off with stale states |
| — | Event schemas are **additive-only** | Making a new field required made an existing valid log unreadable |
| — | Findings are **re-assessed every run** (stable ids, latest record wins) | A rubric change previously left stale severities |

### Findings from building against the real tools

1. **Read-only worktree inside the sandbox:** `cp -R` preserves modes, so the scratch copy
   was read-only (`EACCES` on `node_modules`). The scratch copy is now `chmod -R u+w`; `/src`
   stays read-only.
2. **c8 argument parsing** swallowed `sh` as a flag value. c8's options now end with `--`.
3. **LCOV** dropped `node_modules` only at the top level. It's now dropped at any depth.
4. **gitleaks `dir` mode** (triage) embeds the **absolute** path in its fingerprint, which
   would break cross-home determinism. Fingerprints are now rebuilt from repo-relative paths.
5. **EPSS** "current" redirects to a dated file. The published score date is read from the
   file itself.
6. **The YAML library** emitted anchors/aliases for repeated values, which radr's strict
   parser rejects. Aliasing is now disabled on every writer.
7. **pandoc** wraps tables in non-breaking Typst figures and centers cells. The theme makes
   them breakable and left-aligned. Column widths come from pipe-table separators.

### Open items carried forward

- Per-test flaky detection (JUnit-style reporters per stack).
- Coverage includes Python test files (coverage.py's default); consider `--omit` for tests.
- The report's Recommendations section can start on a new page with space left above
  (Typst flow); cosmetic.
