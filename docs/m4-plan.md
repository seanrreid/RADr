# M4 Plan: The LLM lane

**Status:** approved 2026-10-07; in progress
**Source:** [PRD.md](../PRD.md) §19 (M4), §9 (LLM boundary), §8 (data model), §17 invariants 2–5
**Builds on:** [M3](m3-plan.md) (as built)
**Date:** 2026-10-07

## Goal

1. **The LLM policy becomes real.** `llm_policy: metadata-only | code-allowed` is accepted
   and fingerprinted, and every agent call goes through one gate (`src/llm/policy.ts`)
   that enforces it.
2. **`radr triage`:** cluster duplicate findings across tools, explain findings in client
   language, propose dispositions, and propose judgment findings. Every one of these is a
   proposal; nothing changes state until the consultant acts.
3. **Drafting:** `radr address --draft` fills the executive-summary, recommendations and
   plan-notes keep-blocks with LLM prose that the consultant must review.
4. **Evals:** invariants 2, 3 and 5 are asserted in CI with a scripted fake agent. Evals
   against a real agent are opt-in.

The LLM never decides anything. Severity stays in `src/rubric/rubric.ts`. Dispositions
are set only by the consultant or the rubric's auto-confirm. Gates are approved only by the
consultant.

## Decisions

- **One agent command, no shell.** `RADR_AGENT_CMD` is a JSON array of argv
  (`["claude", "-p", ...]`), spawned through `run()` with `shell: false`. Its environment
  is an allowlist, its cwd is an empty temp directory, and it gets a timeout and an output
  cap. Unset means no LLM, by construction. The recommended Claude Code invocation, with no
  tools and JSON output, is documented in the README and checked against the current CLI
  docs in W1.
- **Prompt in, typed JSON out.** The prompt goes in on stdin. The response must validate
  against a per-purpose JSON Schema (ajv, already a dependency). Invalid output is the
  matrix outcome `fail-protocol`, with a bounded retry, then `partial`. No new runtime
  dependencies.
- **Everything that leaves the machine is persisted:**
  - `llm/<call-id>.prompt.txt` and `llm/<call-id>.response.json`
  - an `llm-call` event with purpose, policy, prompt hash, response hash, agent argv hash,
    and outcome
  - A client can audit every byte that was sent.
- **The LLM output isn't part of the scope fingerprint**, since it can't be deterministic.
  The policy is part of the fingerprint (it already is).
- **`metadata-only` redaction is deterministic and runs before the gate:**
  - `snippet` fields are dropped.
  - Each tool `message` is checked against the anchored source lines: if any run of 12 or
    more non-space characters from those lines appears in the message, the message is
    replaced by the rule ID.
  - Secrets-lane findings never carry message text.
  - The invariant-3 eval, not the filter, is the proof: it scans every persisted prompt
    for any 12-character run from any repo file.
- **`code-allowed`:** bounded snippets (anchor ±5 lines, capped per finding and per
  prompt). Secrets-lane findings are still metadata-only.
- **Judgment findings:**
  - A new `finding-proposed` event, plus a `proposed` state ahead of `pending` in the
    disposition machine. Only `radr disposition <id> pending` (the consultant) promotes
    one, and Gate 2 already refuses `pending`.
  - Anchors are validated: the file must exist in the worktree, the line must be in range,
    and an anchor that fails validation is rejected.
  - `class: judgment` keeps them in the review set (rubric v1 already routes them there).
- **Judgment severity:** rubric v1 gets a base entry for the `judgment` tool at `medium`.
  The consultant adjusts it with a `severity-override` event (PRD §10).
- **Clusters and explanations are annotations, not edits.** They're stored as
  `llm/annotations.jsonl` keyed by finding ID. The report shows them labelled as
  LLM-written. Raw and normalized findings are never touched.
- **Drafts carry a marker.** A drafted keep-block starts with `<!-- radr:llm-draft -->`.
  Gate 2 refuses while any marker remains: the consultant has to read the draft and delete
  the marker. `--draft` only fills blocks still at their default text, so it never
  overwrites consultant prose.
- **Event schemas stay additive:** the new event types are `llm-call`,
  `finding-proposed` and `severity-override`. No existing event type gains a required
  field.

## Decided with Sean (2026-10-07)

1. **Judgment-finding severity:** `medium` by default from the rubric; the consultant
   adjusts it with `severity-override`.
2. **Real-agent evals:** opt-in only (`RADR_E2E_AGENT=1`), never in CI. They measure
   schema-valid rate, anchor-valid rate, and judgment findings confirmed ÷ proposed.
3. **Drafting scope:** the executive summary, recommendations and plan notes only.
   Remediation items, and every result in the report, come from the deterministic
   pipeline, never from the LLM.

## Acceptance criteria

- **AC1:** `parseEngagement` accepts all three policies; the policy is in the fingerprint,
  and the report cover shows it.
- **AC2:** With `off`, or with `RADR_AGENT_CMD` unset, no agent process is ever spawned.
  An eval runs the full pipeline with a trap agent that fails the test if it is executed
  (invariant 2).
- **AC3:** With `metadata-only`, no persisted prompt contains a 12-character run from any
  repo file. The eval runs over the vulnerable fixtures, where tool messages interpolate
  code (invariant 3).
- **AC4:** Every agent call writes its prompt and response under `llm/` and an `llm-call`
  event whose hashes match the files.
- **AC5:** Output that fails its schema becomes `fail-protocol`, is retried per the matrix,
  then makes the lane `partial`. It's covered by a fake agent that returns bad JSON.
- **AC6:** No code path lets agent output set or change severity, a disposition, a raw or
  normalized finding, or a gate. It's asserted by a fake agent whose output tries each one
  (invariant 5), and by an ESLint rule that blocks `src/llm/**` from importing the
  findings store's writers, the disposition module or the gate modules.
- **AC7:** `radr triage` writes clusters, explanations and proposed dispositions as
  annotations, and writes judgment findings as `proposed`. `radr findings` shows them,
  labelled.
- **AC8:** A judgment finding with an invalid anchor is rejected and recorded. A valid one
  is `proposed`, and only a consultant action moves it to `pending`. Gate 2 refuses while
  any judgment finding is still `proposed` or `pending`.
- **AC9:** `radr address --draft` fills only untouched keep-blocks, adding the draft
  marker. Gate 2 refuses while a marker remains.
- **AC10:** The report labels everything LLM-written. The methodology appendix records the
  policy, the agent argv hash, and the number of calls.
- **AC11:** The real-agent eval harness runs when opted in and writes a metrics summary.

## Waves

- **W0: Policy and plumbing:** accept the three policies; parse `RADR_AGENT_CMD`; build
  the agent runner (allowlisted env, empty cwd, timeout, cap); `llm/` persistence and the
  `llm-call` event; the `fail-protocol` outcome and an `llm` row in the matrix; the fake
  agent for tests; AC2 and AC4.
- **W1: Redaction and prompts:** the metadata-only filter, code-allowed snippet bounds,
  prompt builders per purpose, response schemas, batching under a prompt-size cap, and the
  invariant-3 eval (AC3, AC5). Also verify the recommended Claude Code argv.
- **W2: `radr triage`:** clusters, explanations, proposed dispositions as annotations, and
  judgment findings via `finding-proposed`; the `proposed` state; anchor validation; the
  `severity-override` event if decision 1 lands that way (AC6–AC8).
- **W3: Drafting:** `address --draft`, the draft marker, the Gate 2 check, and report
  labelling (AC9, AC10).
- **W4: Evals:** the invariant-5 adversarial fake agent, the ESLint import boundary, and
  the opt-in real-agent harness (AC6, AC11).
- **W5: E2E, docs, and as-built.**
