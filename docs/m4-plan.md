# M4 Plan: The LLM lane

**Status:** complete (as built below)
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

## As built (2026-10-07)

### Acceptance criteria

| AC | Status | Evidence |
|---|---|---|
| AC1 three policies, fingerprinted, on the cover | ✅ | `parseEngagement`; `engagementHash` differs per policy (unit); methodology row |
| AC2 off / unset: no spawn | ✅ | AC16 trap test now also runs `triage` and `address --draft`; gate unit tests |
| AC3 metadata-only quotes no repo code | ✅ | unit (synthetic interpolated messages); real-tool e2e scans every prompt against the whole worktree; the planted AWS key is in no prompt, under `code-allowed` too |
| AC4 prompts, responses, `llm-call` hashes | ✅ | `llm/L-NNNN.{prompt,response}.txt`; hashes asserted equal to the files |
| AC5 `fail-protocol` → retry → partial | ✅ | matrix `llm` row; fake agent returning bad JSON and schema-invalid JSON |
| AC6 no decision from agent output | ✅ | adversarial fake agent (invariant 5); ESLint boundary on `src/llm/**` + guardrail test |
| AC7 `radr triage` annotations and proposals | ✅ | `llm/annotations.jsonl`; `[LLM]` lines in `radr findings` |
| AC8 judgment anchors, `proposed`, Gate 2 | ✅ | `judgments.jsonl`; anchor rejection recorded; Gate 2 refuses `proposed`/`pending` judgments |
| AC9 `--draft`, marker, Gate 2 | ✅ | untouched blocks only; drafts with markup rejected; Gate 2 refuses a marker |
| AC10 LLM work labelled in the report | ✅ | "Judgment findings" section; provenance sentence and "AI (LLM) agent calls" row only when the LLM was used |
| AC11 opt-in real-agent harness | ✅ (not yet run) | `test/e2e/agent.test.ts`, skipped unless `RADR_E2E_AGENT=1` |

### Decisions made while building

- **Rubric v2.** v1 says a published rubric is never edited (its hash is in the fingerprint),
  so the judgment entry ships as `rubric/v2.yml` (v1 + `radr-judgment: { judgment: medium }`).
  New scopes default to v2. Under v0/v1, triage still explains and clusters, and rejects
  judgment proposals rather than giving them a default severity. The auto-confirm actor is now
  `rubric@v2` for new engagements.
- **Judgment findings live apart from tool findings** (`judgments.jsonl`, `J-NNNN` ids), so the
  findings-set hash, which is the determinism proof, never depends on model output. The
  dispositions hash covers judgments only when there are some, so earlier approvals still
  verify.
- **`severity-override` is for judgment findings only** in M4. Tool-finding severity stays
  rubric-only.
- **Agent wiring is agent-agnostic.** `RADR_AGENT_CMD` is a JSON argv array (or one executable
  path); an argv element `{schema}` is replaced by the call's JSON Schema; `RADR_AGENT_OUTPUT=
  claude-json` unwraps Claude Code's envelope (`structured_output`, else `result`).
  `RADR_AGENT_ENV` names the extra variables the agent gets. The README's Claude Code argv was
  checked against the installed CLI (v2.1.293): it has no `--max-turns`, and `--bare`
  authenticates only with `ANTHROPIC_API_KEY`.
- **The schema sent to the agent is minimal** (types, required fields, enums). Bounds, ID
  membership and anchors are checked per item in radr, so one bad item is rejected and recorded
  instead of failing the batch.
- **`code-allowed` sends no code from a file the secrets lane flagged.** A neighbouring
  finding's ±5 lines could include the secret, and history findings' line numbers come from
  old commits, so line-level redaction can't be trusted.
- **Annotations never reach the report.** Only confirmed judgment findings and drafts a person
  has reviewed do.
- **LLM metrics** (calls, schema-valid, fail-protocol, judgments proposed/kept/dismissed) are a
  fold over the event log in `src/state/llm-metrics.ts`, shown by `radr status`. They live
  outside `src/llm` because the boundary bans `src/llm` from importing the dispositions module.

### Open items carried forward

- Run the real-agent eval (`RADR_E2E_AGENT=1`, needs an API key) and record the schema-valid
  and anchor-valid rates.
- Judgment findings aren't in the remediation plan: plan acceptance criteria are lane re-runs,
  which can't re-check a judgment. Decide how a confirmed judgment is tracked to closure (M6
  `verify`).
- Severity overrides for tool findings (PRD §10) are not built.
- Clusters are only found within one prompt batch (200 KB); cross-batch clustering isn't done.
- The `{schema}` keywords radr sends are deliberately minimal; whether an agent enforces more
  (lengths, patterns) is untested.

