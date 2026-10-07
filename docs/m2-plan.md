# M2 Plan: Triage, sandbox, Address, Gate 2, PDF

**Status:** in progress
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
