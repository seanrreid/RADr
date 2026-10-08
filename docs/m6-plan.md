# M6 Plan: PR review (`diff` tier) and `radr verify`

**Status:** complete (as built below)
**Source:** [PRD.md](../PRD.md) §13 (diff tier), §8 (disposition state machine, baseline),
§12 (remediation plan acceptance), §19 (M6)
**Builds on:** [M4](m4-plan.md) (as built)
**Date:** 2026-10-08

## Goal

1. **`radr verify`:** re-run the approved lanes on the client's fixed commit and mark each
   finding `fixed`, `verified` or `regressed`. This is what checks off the remediation
   plan's "done when" criteria.
2. **PR review (`diff` tier):** review a pull request's changes against a recorded
   baseline, so only *new* findings surface. Output is SARIF 2.1.0 plus a Markdown summary
   the consultant posts to the PR. Consultant-side, against a fork (PRD §13).

## Decisions

- **Both move the scope to a new commit, through Gate 1.** The approved SHA is part of the
  fingerprint, so `verify` and each PR review start with `radr source fetch` and `radr scope
  --rev <sha>` (diff: `--base <ref> --head <ref>`), then `radr approve scope`. Nothing runs
  on a commit a person hasn't approved. The rubric, toolchain, lanes, rule packs and
  vulnerability snapshot must match the run being verified, or `verify` refuses: a change in
  any of them would make the comparison meaningless. The commit and the dependency-cache
  snapshot may differ, because a fixed lockfile needs a fresh `radr deps warm`.
- **Matching uses the existing finding fingerprint** (tool + rule + path + normalized code,
  or the engine's own fingerprint), so code moving around doesn't change identity. The same
  fingerprint on the new commit means the same finding.
  - **Caveat:** a finding without a snippet falls back to its line number
    (`identityKey` in `findings/store.ts`). If such a finding moves, verify would see one
    `fixed` plus one new finding. W0 measures how many findings per tool lack snippets on the
    fixtures. For those, verify matches on tool + rule + path + message as well, and marks
    an ambiguous match "needs manual check" rather than guessing.
- **`verify` transitions** (actor `verify@<run>`, recorded as `finding-disposition` events):
  - confirmed, absent → `fixed`
  - `fixed`, absent, and its lane ended `success` (not partial) → `verified`. A finding
    absent from a clean lane goes straight through `fixed` to `verified` in one run, as two
    events. A partial lane can't vouch for absence, so the finding stays `fixed`.
  - `fixed` or `verified`, present again → `regressed`, and the consultant re-confirms it
  - pending, dismissed or waived findings are never touched
- **Judgment findings** can't be re-checked by a tool. The consultant closes one with
  `radr disposition J-… fixed --reason …` (a new manual transition, J- only); `verify` lists
  them as "needs manual check".
- **`radr verify` output:** the counts per transition, a `verify-completed` event, and a
  "Verification" section in the next `radr address` report. Each remediation item shows done
  / partly done / not done from its findings' states.
- **Baseline:** `radr baseline set --from R-NNNN` records `baseline.json`, the fingerprint
  set of a completed run plus its hash, frozen by a `baseline-set` event. The baseline's hash
  is part of a diff scope's fingerprint.
- **Diff runs all approved lanes on the head commit, then filters**, instead of pointing
  each tool at a file list. A finding surfaces if its file is changed in `base..head` and its
  fingerprint isn't in the baseline. Some tools need the whole tree (types, SCA, maint), and
  filtering after the run keeps every lane deterministic. Dependency findings surface when
  their manifest or lockfile changed. Secrets are scanned over the `base..head` commits only.
- **Diff outputs:** `review/pr-<head12>.sarif` (SARIF 2.1.0: new findings only, with
  `partialFingerprints`, and canonical JSON so it's byte-stable) and `review/pr-<head12>.md`.
  Dispositions and Gate 2 work as usual. LLM policy applies unchanged (`radr triage` works on
  a diff run).
- **Coverage in diff** runs only if the engagement opts in (PRD §14.1a).

## Decided with Sean (2026-10-08)

1. **`fixed` → `verified` in one run:** yes, when the finding's lane ran clean. A partial
   lane leaves it `fixed`.
2. **Diff filtering** (my recommendation, not asked; Sean may revisit): run every lane on
   the head commit, then filter. Per-tool file targeting can come later if PR reviews get
   slow.
3. **Gate 1 per PR** (my recommendation, not asked; Sean may revisit): each PR review's head
   commit needs `radr approve scope`. A convenience command may prepare everything up to
   the approval.

## Acceptance criteria

- **AC1:** `radr verify --against R-NNNN` refuses unless the current approved scope differs
  from R-NNNN's only in the commit (and the dependency snapshot).
- **AC2:** On a fixture where the fixed commit removes one finding, keeps one and
  reintroduces a previously fixed one, verify writes `fixed`/`verified`, leaves the kept one
  `confirmed`, and writes `regressed`, all as events with actor `verify@R-NNNN`.
- **AC3:** A partial lane in the verify run leaves its absent findings `fixed`, never
  `verified`.
- **AC4:** Judgment findings are listed as needing a manual check. `fixed` is settable by
  hand for J- findings only, with a reason.
- **AC5:** The report gains a Verification section; remediation items show their status.
- **AC6:** `radr baseline set --from R-NNNN` writes `baseline.json` and a `baseline-set`
  event, and its hash is in a diff scope's fingerprint.
- **AC7:** `radr review` on a diff scope surfaces only findings in changed files that aren't
  in the baseline. A planted new issue appears; an existing one doesn't.
- **AC8:** SARIF 2.1.0 output validates against the schema and is byte-identical across
  runs, homes, `TZ` and `LANG`. The Markdown summary is too.
- **AC9:** Secrets in a diff scope are scanned over `base..head` only.

## Waves

- **W0: Verify core:** scope-compatibility check, fingerprint matching (including the
  no-snippet fallback), the transitions and `verify-completed` (AC1–AC3).
- **W1: Verify outputs:** the judgment manual path, the report's Verification section and
  plan item status (AC4, AC5).
- **W2: Baseline and diff scope:** `baseline set`, `--base/--head` scoping, and the
  changed-file set (AC6).
- **W3: Diff run:** the post-run filter, secrets over the commit range, and dependency
  manifests (AC7, AC9).
- **W4: Outputs:** the SARIF writer plus schema validation, and the Markdown summary (AC8).
- **W5: E2E, docs, and as-built.**

## As built (2026-10-08)

### Acceptance criteria

| AC | Status | Evidence |
|---|---|---|
| AC1 verify refuses a scope that changed beyond the commit | ✅ | every review writes `raw/<run>/scope.json` (hash in `run-started`); verify compares it with the current scope, ignoring only the commit and the dependency snapshot, and refuses the same commit and pre-M6 runs |
| AC2 fixed / verified / still present / regressed | ✅ | four-commit fixture with a commit-dependent fake ruff; real-tool e2e (real ruff) |
| AC3 a partial lane can't verify | ✅ | the "break lint" commit: absent findings stay `fixed` |
| AC4 judgment findings close by hand | ✅ | `radr disposition J-… fixed --reason` (J- only); verify lists confirmed judgments |
| AC5 Verification in the report | ✅ (adjusted) | a Verification section (counts plus every finding verify moved) and a summary line on the plan; see below |
| AC6 baseline, pinned in the fingerprint | ✅ | `radr baseline set`, `baseline-set` event, `diff.baseline` hash in `engagement.yml`; an edited baseline refuses the run |
| AC7 only new findings in changed files | ✅ | diff fixture: the untouched file's finding and the baselined one are suppressed (counted in a run note) |
| AC8 SARIF 2.1.0, byte-identical | ✅ | validated against a structural SARIF 2.1.0 schema; identical across two homes with different `TZ`/`LANG` (real-tool e2e) |
| AC9 secrets over base..head | ✅ | gitleaks gets `--log-opts=<base>..<head>` in a diff scope |

### Decisions made while building

- **AC5 adjusted:** a verify run's report contains only the findings present at the fixed
  commit, so its remediation plan already holds only what's still open, and fixed work drops
  out of it. Instead of per-item status badges, the report's Verification section lists what
  closed, what was verified and what regressed, and the plan opens with a one-line summary.
- **Verify writes dispositions through the same transition table** as a person
  (`canTransition`), with actor `verify@<run>`. Confirmed + absent becomes two events
  (`fixed`, then `verified`) when the lane ran clean.
- **No-snippet findings:** an absent one whose tool/rule/file/message twin appears as a new
  finding is listed for a manual check, not marked fixed.
- **The baseline holds every finding of its run**, whatever its state, so a dismissed false
  positive stays suppressed in PR reviews.
- **Fingerprints are computed before the diff filter**, so occurrence numbering (two copies
  of the same mistake) doesn't depend on what the filter keeps.
- **Secrets in a diff scope** come from the PR's commits and surface even if the file has
  changed again since. A secret added and removed within a PR still leaked.
- **The SARIF schema check is a structural subset** of SARIF 2.1.0 covering what radr writes;
  the full OASIS schema isn't vendored (it would need its own license review). GitHub's
  upload is the final check.
- **Scope snapshots** live in `src/review/scope-snapshot.ts` so the baseline and verify
  modules don't import the review runner's internals.

### Open items carried forward

- A `radr pr fetch <n>` convenience that prepares a PR scope up to the approval.
- Per-tool file targeting for the diff tier, if reviews of large repos get slow.
- Coverage in the diff tier (opt-in per PRD §14.1a) isn't specialised: if the coverage lane is
  enabled, it runs as in any review and its findings are filtered like the rest.
- Uploading SARIF (to GitHub code scanning) and posting the comment stay manual.

