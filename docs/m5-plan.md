# M5 Plan: Debug

**Status:** approved 2026-10-08; in progress (built before M6)
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
