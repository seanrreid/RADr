# M6 Plan: PR review (`diff` tier) and `radr verify`

**Status:** approved 2026-10-08; built after M5
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
