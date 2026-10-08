# M5 Plan: Debug

**Status:** complete (as built below); the real-sandbox e2e runs in CI
**Source:** [PRD.md](../PRD.md) §11 (Debug), §19 (M5), §17 invariant 7, §14.1a (build sandbox)
**Builds on:** [M4](m4-plan.md) (as built); the M2/M3 build sandbox
**Date:** 2026-10-08

## Goal

The **D** in RAD: a root-cause workflow for one specific bug, whose determinism is in the
*method*. Every step is a sandbox run or a recorded decision, and gates enforce the order:

1. **Intake:** symptom, expected vs. actual, environment, first seen.
2. **Reproduce (gate):** a repro script runs in the build sandbox and fails at the approved
   commit. "Cannot reproduce" is a valid ending, with the attempts as evidence.
3. **Localize:** an automated bisect between a known-good and the known-bad commit.
4. **Hypotheses:** each one is proposed, then confirmed or refuted by a recorded
   experiment (a sandbox run). Never by assertion.
5. **Root cause (gate):** needs a recorded repro and a confirmed hypothesis (invariant 7).
6. **Regression guard:** a test that fails before the fix and passes after it; both runs
   recorded. Delivered as a patch file.
7. **Output:** `debug/<id>/root-cause.md`, and optionally a remediation-plan item.

It's reachable standalone (engagement type `debug`, `--issue`) or from a finding
(`--from-finding F-…`). The client repo stays read-only throughout.

## Decisions

- **Commands:** `radr debug open | repro | bisect | hypothesis | experiment | conclude |
  guard | show`. Each debug is `D-NNNN`, with its files in `debug/D-NNNN/`.
- **Everything is an event** (additive event types): `debug-opened`, `debug-run` (repro,
  experiment, bisect step or guard: command hash, commit, exit code, output hash, log path),
  `debug-bisected`, `hypothesis-proposed`, `hypothesis-decided` (confirmed or refuted, citing
  a `debug-run`), and `debug-concluded` (root-caused or cannot-reproduce). Gates are folds
  over these, like Gates 1 and 2.
- **The repro contract matches `git bisect run`:** exit 0 means the bug is absent, 1–124
  and 126–127 mean present, and 125 means "can't tell" (skip). The consultant writes
  `debug/D-NNNN/repro/repro.sh`. radr hashes it into every run and refuses to run it if it
  changed after being recorded.
- **Runs reuse the build sandbox:** the recipe's stack image and its install steps (from the
  dependency cache when offline), then the repro script. Network, read-only source, no
  capabilities and resource limits are all unchanged from the coverage lane.
- **radr drives the bisect, not `git bisect` in the container.** The source mount is
  read-only and the images have no git. radr lists the commits between good and bad
  (`git rev-list --first-parent --reverse`) from its mirror, checks each candidate out into
  a temporary read-only worktree, and runs the repro there in a fresh sandbox. It's a binary
  search over a fixed list, so given the same results it always tests the same commits.
  Every step is a `debug-run`.
- **Offline bisect may skip commits.** The dependency cache was warmed for the approved
  commit; an older commit whose lockfile differs can't install offline. That's exit 125
  (skip), recorded, and the result may be a range ("first bad is one of …"), never a guess.
- **Hypotheses are decided only by experiments.** `radr debug experiment D-1 --hypothesis
  H-2 <script>` runs a script in the sandbox. `radr debug hypothesis D-1 H-2 confirmed
  --run <run-id> --reason …` must cite an experiment run that's recorded against that
  hypothesis.
- **LLM (policy permitting):** `radr debug suggest D-1` asks the agent for hypotheses and
  next experiments, given the intake, repro output tail (code-allowed only) and bisect
  result. Suggestions land as `proposed` hypotheses, labelled. Same gate, persistence and
  invariant-5 boundary as M4.
- **Regression guard:** the consultant supplies a test patch (`guard/test.patch`) and the
  fix (`guard/fix.patch`, or a commit in the mirror). radr runs the test without the fix
  (must fail) and with it (must pass), applying patches inside the sandbox's scratch copy.
  The test patch is the deliverable.
- **Debug items in the plan:** a concluded debug can add a "Debug fixes" section to
  `remediation.md`, with its acceptance criterion "the guard test passes at the fixed
  commit" (re-runnable).

## Decided with Sean (2026-10-08)

1. **Where a debug lives:** both. A standalone `debug` engagement works for `--issue`, and
   debugs inside any review engagement work for `--from-finding` and `--issue`.
2. **Bisect bounds:** capped at 512 candidate commits (about 9 sandbox runs). A wider range
   is refused with a request for a closer known-good commit.
3. **Fixes** (my recommendation, not asked; Sean may revisit): radr never writes the fix. It
   runs and records the consultant's fix patch.

## Acceptance criteria

- **AC1:** `radr debug open` (from a finding or `--issue`) writes `debug-opened` and
  creates `debug/D-NNNN/`. It refuses without an approved scope.
- **AC2:** `radr debug repro` runs the repro in the sandbox at the approved commit and
  records command hash, exit code and output hash. Exit 0 means not reproduced. A repro
  edited after a recorded run is refused.
- **AC3:** `radr debug conclude` refuses root-cause without a reproducing run and a
  confirmed hypothesis (invariant 7, eval-tested). Cannot-reproduce needs at least one
  recorded attempt.
- **AC4:** `radr debug bisect --good <rev>` finds the first bad commit on a fixture repo
  with a planted regression, and every step is a `debug-run`. Given the same results it
  tests the same commits. Skips produce a range, never a guess.
- **AC5:** A hypothesis can only be confirmed or refuted by citing an experiment run
  recorded against it.
- **AC6:** `radr debug guard` records the test failing without the fix and passing with it,
  and refuses otherwise. The test patch is written to `debug/D-NNNN/guard/`.
- **AC7:** `root-cause.md` is a pure function of the events plus consultant keep-blocks,
  regenerated byte-identically.
- **AC8:** `radr debug suggest` (policy permitting) proposes hypotheses only. Policy `off`
  never spawns the agent.
- **AC9:** A concluded debug can add a re-runnable item to the remediation plan.

## Waves

- **W0: Records and gates:** event types, the debug fold, `open`, `show`, the
  invariant-7 gate, and the fixture repo with a planted regression (AC1, AC3 skeleton).
- **W1: Repro in the sandbox:** the repro contract, script hashing, the sandbox
  composition from the recipe, and `debug-run` (AC2).
- **W2: Bisect:** the candidate list, a temporary worktree per commit, binary search with
  skip handling, and `debug-bisected` (AC4).
- **W3: Hypotheses and experiments:** propose, experiment, decide, conclude, and
  `root-cause.md` (AC3, AC5, AC7).
- **W4: Guard, plan item, and suggest:** before/after runs with patches, the plan section,
  and LLM suggestions (AC6, AC8, AC9).
- **W5: E2E, docs, and as-built.**

## As built (2026-10-08)

### Acceptance criteria

| AC | Status | Evidence |
|---|---|---|
| AC1 open, behind the scope gate | ✅ | `radr debug open --issue | --from-finding` (F- or J-); refused without Gate 1 |
| AC2 repro in the sandbox, recorded | ✅ | `debug-run`: script hash, exit code, outcome, log ref + hash; a repro edited after it reproduced is refused |
| AC3 conclusion gate (invariant 7) | ✅ | unit evals over recorded events; cannot-reproduce needs an attempt and no reproducing run |
| AC4 bisect | ✅ | planted-regression fixture: the planted commit found in ≤ 7 runs; identical probe sequence across homes; skips give a range |
| AC5 hypotheses decided only by experiments | ✅ | an experiment recorded against that hypothesis is required; confirmation waits for a reproducing run |
| AC6 regression guard | ✅ | fails without / passes with the fix (patch or `--fix-commit`); patch hashes recorded; refuses unless it holds |
| AC7 `root-cause.md` is a pure function | ✅ | regenerated byte-identically; mechanism/notes keep-blocks preserved |
| AC8 `debug suggest`, policy permitting | ✅ | fake agent: `[LLM]` proposals only; policy `off` never spawns; metadata-only withholds intake that quotes code |
| AC9 plan item | ✅ | `conclude --to-plan` → "Debug fixes" in remediation.md, done when the guard passes at the fixed commit |

The whole flow (repro, bisect, experiment, decide, conclude, guard) runs in the real sandbox
in `test/e2e/sandbox.test.ts` on CI's Linux job. Unit tests use a host stand-in for the sandbox
(`test/helpers/local-sandbox.ts`, no isolation) to test radr's own logic.

### Decisions made while building

- **The repro is frozen once it reproduces**, rather than on its first run: a consultant can
  iterate on a repro that doesn't reproduce yet, but once it has, bisect and the guard rerun
  exactly that script (hash-checked) and `repro` refuses an edited one.
- **An install that fails is "can't tell" (skip)**, the same as exit 125, so an old commit
  that doesn't install offline is stepped around by bisect instead of failing it. A sandbox
  that fails to run at all is an `error` and stops a bisect.
- **Bisect checks the good end first** and refuses if it shows the bug or can't tell.
  Candidates are the first-parent commits from good to bad; the bad end is the reproduced
  commit, so it isn't rerun. Temporary checkouts live under the engagement's `cache/` (Podman
  machines on macOS share the home directory, not `/tmp`) and are removed and pruned.
- **Patches are applied with git on the host**, into a temporary checkout made read-only
  before mounting: the sandbox images may not carry `patch` or `git`, and the source mount
  stays read-only.
- **Gates live in code** (`src/debug/state.ts`), like Gate 2's refusals, not in
  `policy/gates.yml`: they're workflow rules with several preconditions, not a single fold
  condition.
- **`debug suggest` under `code-allowed`** adds the reproducing run's log tail (40 lines) and
  the first bad commit's diff (8 KB), with files the secrets lane flagged excluded from the
  diff. A standalone debug engagement has no secrets scan to consult, so `code-allowed` is the
  consultant's call there.
- **A standalone debug engagement** is `engagement_type: debug` with `lanes: []`; `radr
  review` refuses it.

### Open items carried forward

- Coverage diff of passing vs. failing runs (PRD §11 step 3) is not built; bisect is.
- `root-cause.md` isn't part of the client report or PDF yet; it's delivered as its own file.
- Bisect follows first parents only; a regression introduced inside a merged branch is
  reported as the merge commit.

