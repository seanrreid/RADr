// `radr debug suggest` (PRD §11 step 4; M5 W4): the LLM proposes hypotheses and experiments.
// Suggestions land as `proposed` hypotheses with source "llm"; only a recorded experiment can
// decide them (src/debug/state.ts), exactly like a consultant's.
//
// What the agent sees, per policy:
//   metadata-only  the intake (any field that quotes repository code is withheld), run kinds,
//                  exit codes and outcomes, the bisect result (commit ids), existing hypotheses
//   code-allowed   the same, plus the reproducing run's log tail and the first bad commit's
//                  diff, each capped. Files the secrets lane flagged in this engagement are left
//                  out of the diff. A standalone debug engagement has no secrets scan to consult,
//                  and logs are sent as they are, so code-allowed is the consultant's call there.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { RefusedError } from "../core/errors.js";
import { assertOpen, nextId, reproducing, type DebugState } from "../debug/state.js";
import type { Layout } from "../engagement/home.js";
import { gitOut } from "../engagement/git.js";
import type { Finding } from "../findings/types.js";
import type { EventLog } from "../state/events.js";
import { invokeAgent, type AgentContext } from "./policy.js";
import { renderPrompt } from "./prompt.js";
import { leakedRuns, promptFinding } from "./redact.js";

export const PURPOSE = "debug-suggest";
const LOG_TAIL_LINES = 40;
const MAX_DIFF_BYTES = 8192;
const MAX_TEXT = 500;
const MAX_EXPERIMENT = 1000;
const MAX_SUGGESTIONS = 10;

export const INSTRUCTIONS = `You are helping a consultant find the root cause of one bug. The <data> block holds the
intake, the reproduction and bisect results so far, and the hypotheses already proposed.

Return JSON matching the provided schema: up to ${String(MAX_SUGGESTIONS)} hypotheses about the root cause, each with
one concrete experiment (a short shell script idea, run in the project directory) whose exit
code would confirm or refute it. Don't repeat existing hypotheses. Hypotheses are only
proposals: recorded experiments decide them.`;

const str = { type: "string" } as const;
export const RESPONSE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["hypotheses"],
  properties: { hypotheses: { type: "array", items: { type: "object", additionalProperties: false, required: ["text", "experiment"], properties: { text: str, experiment: str } } } },
} as const;
interface SuggestResponse { readonly hypotheses: readonly { readonly text: string; readonly experiment: string }[] }

export interface SuggestResult {
  readonly status: "ok" | "partial" | "aborted";
  readonly proposed: readonly string[];
  readonly rejected: number;
}

/** `secretFiles`: repo paths the secrets lane flagged, excluded from the diff (code-allowed). */
export async function suggest(l: Layout, log: EventLog, actor: string, agent: AgentContext, d: DebugState, finding: Finding | undefined, secretFiles: ReadonlySet<string> = new Set()): Promise<SuggestResult> {
  assertOpen(d);
  if (agent.policy === "off") throw new RefusedError(`LLM policy is "off" for ${l.id}; refusing to suggest`);
  const policy = agent.policy;
  // Consultant-written intake can still quote code; under metadata-only such a field is withheld.
  const intake = (v: string | undefined) => (v === undefined ? null : policy === "metadata-only" && leakedRuns(v, l.worktree).length > 0 ? "[withheld: quotes repository code]" : v);
  const context: Record<string, unknown> = {
    symptom: d.from === "finding" ? null : intake(d.symptom),
    expected: intake(d.expected), actual: intake(d.actual), environment: intake(d.environment), first_seen: intake(d.firstSeen),
    runs: d.runs.map((r) => ({ run: r.runId, kind: r.kind, exit_code: r.exitCode, outcome: r.outcome })),
    bisect: d.bisect === undefined ? null : { good: d.bisect.good, bad: d.bisect.bad, first_bad: [...d.bisect.firstBad] },
    hypotheses: d.hypotheses.map((h) => ({ hypothesis: h.id, state: h.state, text: h.text })),
  };
  if (policy === "code-allowed") {
    const rep = reproducing(d)[0];
    const logFile = rep === undefined ? undefined : path.join(l.dir, rep.logRef);
    context["repro_log_tail"] = logFile !== undefined && existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").slice(-LOG_TAIL_LINES).join("\n") : null;
    const first = d.bisect?.firstBad.length === 1 ? d.bisect.firstBad[0] : undefined;
    context["first_bad_diff"] = first === undefined ? null : Buffer.from(await gitOut(["show", "--no-color", "--format=%H", first, "--", ".", ...[...secretFiles].map((f) => `:(exclude,literal)${f}`)], l.mirror)).subarray(0, MAX_DIFF_BYTES).toString("utf8").replace(/�$/, "");
  }
  const findings = finding === undefined ? [] : [promptFinding(finding, policy, l.worktree)];
  const prompt = renderPrompt(INSTRUCTIONS, { purpose: PURPOSE, context, findings });
  const r = await invokeAgent<SuggestResponse>(agent, { purpose: PURPOSE, prompt, schema: RESPONSE_SCHEMA });
  if (r.status !== "ok") return { status: r.status === "abort" ? "aborted" : "partial", proposed: [], rejected: 0 };
  const callId = r.callIds.at(-1) ?? "";
  const proposed: string[] = [];
  let rejected = 0;
  const known = new Set(d.hypotheses.map((h) => h.text.trim()));
  for (const h of r.output.hypotheses.slice(0, MAX_SUGGESTIONS)) {
    const text = h.text.trim();
    const exp = h.experiment.trim();
    if (text === "" || text.length > MAX_TEXT || exp.length > MAX_EXPERIMENT || known.has(text)) {
      rejected++;
      continue;
    }
    const id = nextId(log.read(), "H");
    log.append("hypothesis-proposed", actor, { debug_id: d.id, hypothesis_id: id, text: exp === "" ? text : `${text} (suggested experiment: ${exp})`, source: "llm", call_id: callId });
    known.add(text);
    proposed.push(id);
  }
  rejected += Math.max(0, r.output.hypotheses.length - MAX_SUGGESTIONS);
  return { status: "ok", proposed, rejected };
}
