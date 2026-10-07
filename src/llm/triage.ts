// `radr triage` (PRD §7, §9; M4 W2): the LLM explains findings, clusters duplicates across
// tools, proposes dispositions, and proposes judgment findings. Every output is a PROPOSAL:
//   explanations, clusters, proposed dispositions → llm/annotations.jsonl (display only)
//   judgment findings                             → judgments.jsonl, state `proposed`
// Nothing here writes a finding-disposition, a severity, or a tool finding (invariant 5).
//
// The schema sent to the agent uses only types, required fields and enums. Bounds, ID
// membership and anchors are checked here per item, so one bad item is rejected and recorded
// without failing the whole call.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { canonicalJson, stableSort } from "../core/determinism.js";
import { RefusedError } from "../core/errors.js";
import type { EngagementDoc } from "../engagement/config.js";
import type { Layout } from "../engagement/home.js";
import { JUDGMENT_CATEGORIES, proposeJudgments, type JudgmentProposal } from "../findings/judgments.js";
import { SEVERITIES, type Finding } from "../findings/types.js";
import type { Matrix } from "../matrix/matrix.js";
import type { Rubric } from "../rubric/rubric.js";
import type { EventLog } from "../state/events.js";
import { invokeAgent, type AgentContext } from "./policy.js";
import { batchPrompts } from "./prompt.js";
import { promptFinding } from "./redact.js";

export const PURPOSE = "triage";
const MAX_TEXT = 2000;
const PROPOSABLE = ["confirmed", "dismissed", "waived"] as const;

export const INSTRUCTIONS = `You are assisting a code-review consultant. The <data> block lists findings that pinned
static-analysis tools reported on a client repository. Tools decided these findings; you do not.

Return JSON matching the provided schema:
- explanations: for findings worth explaining, a short plain-language explanation for the
  client of what the finding means and why it matters. Use the finding's id.
- clusters: groups of two or more findings (by id) that describe the same underlying problem,
  for example the same issue reported by two tools, with a one-sentence rationale.
- dispositions: optional proposals that a finding be confirmed, dismissed (false positive),
  or waived, each with a reason. The consultant decides; you only propose.
- judgments: optional additional concerns the tools did not report. Each must point at a real
  file and line range in the repository and use one of these categories: ${JUDGMENT_CATEGORIES.join(", ")}.
  Propose a judgment only with specific evidence at that location.

Never assign or change severity. Use only ids that appear in the data. Return empty arrays
when you have nothing to add.`;

const str = { type: "string" } as const;
const int = { type: "integer" } as const;
const object = (properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });

/** The response schema sent to the agent (and enforced by the gate). */
export const RESPONSE_SCHEMA = object({
  explanations: { type: "array", items: object({ id: str, text: str }) },
  clusters: { type: "array", items: object({ ids: { type: "array", items: str }, rationale: str }) },
  dispositions: { type: "array", items: object({ id: str, proposed: { enum: PROPOSABLE }, reason: str }) },
  judgments: { type: "array", items: object({ title: str, category: { enum: JUDGMENT_CATEGORIES }, file: str, line: int, end_line: int, rationale: str }) },
});

interface TriageResponse {
  readonly explanations: readonly { readonly id: string; readonly text: string }[];
  readonly clusters: readonly { readonly ids: readonly string[]; readonly rationale: string }[];
  readonly dispositions: readonly { readonly id: string; readonly proposed: (typeof PROPOSABLE)[number]; readonly reason: string }[];
  readonly judgments: readonly JudgmentProposal[];
}

/** One line of llm/annotations.jsonl. Display only: never read by gates, the rubric, or ingest. */
export type Annotation =
  | { readonly type: "explanation"; readonly run_id: string; readonly call_id: string; readonly finding_id: string; readonly text: string }
  | { readonly type: "cluster"; readonly run_id: string; readonly call_id: string; readonly finding_ids: readonly string[]; readonly rationale: string }
  | { readonly type: "disposition-proposal"; readonly run_id: string; readonly call_id: string; readonly finding_id: string; readonly proposed: string; readonly reason: string }
  | { readonly type: "rejected"; readonly run_id: string; readonly call_id: string; readonly item: string; readonly reason: string };

export function annotationsFile(l: Pick<Layout, "llm">): string {
  return `${l.llm}/annotations.jsonl`;
}

export function readAnnotations(l: Pick<Layout, "llm">, runId: string): Annotation[] {
  const file = annotationsFile(l);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter((x) => x !== "").map((x) => JSON.parse(x) as Annotation).filter((a) => a.run_id === runId);
}

export interface TriageInputs {
  readonly layout: Layout;
  readonly doc: EngagementDoc;
  readonly rubric: Rubric;
  readonly runId: string;
  readonly findings: readonly Finding[];
  readonly env: NodeJS.ProcessEnv;
  readonly log: EventLog;
  readonly actor: string;
  readonly matrix: Matrix;
  readonly maxPromptBytes?: number;
}

export interface TriageResult {
  readonly status: "complete" | "partial" | "aborted";
  readonly calls: number;
  readonly batches: number;
  readonly explanations: number;
  readonly clusters: number;
  readonly proposals: number;
  readonly judgments: number;
  readonly duplicates: number;
  readonly rejected: number;
}

const ok = (text: string): boolean => text.trim() !== "" && text.length <= MAX_TEXT;

export async function triage(inp: TriageInputs): Promise<TriageResult> {
  const policy = inp.doc.llm_policy;
  if (policy === "off") throw new RefusedError(`LLM policy is "off" for ${inp.layout.id}; set llm_policy in engagement.yml and re-approve the scope`);
  const ctx: AgentContext = { policy, env: inp.env, llmDir: inp.layout.llm, log: inp.log, actor: inp.actor, matrix: inp.matrix };
  const ordered = stableSort(inp.findings, (f) => [-SEVERITIES.indexOf(f.severity), f.id]);
  const items = ordered.map((f) => promptFinding(f, policy, inp.layout.worktree));
  const context = { engagement_type: inp.doc.engagement_type, policy };
  const batches = items.length === 0 ? [] : batchPrompts(INSTRUCTIONS, PURPOSE, context, items, inp.maxPromptBytes);

  const totals = { calls: 0, explanations: 0, clusters: 0, proposals: 0, judgments: 0, duplicates: 0, rejected: 0 };
  let status: TriageResult["status"] = "complete";
  for (const b of batches) {
    const r = await invokeAgent<TriageResponse>(ctx, { purpose: PURPOSE, prompt: b.prompt, schema: RESPONSE_SCHEMA });
    totals.calls += r.callIds.length;
    if (r.status !== "ok") {
      // The matrix decided: abort stops triage; partial skips this batch and marks the run.
      status = r.status === "abort" ? "aborted" : "partial";
      if (r.status === "abort") break;
      continue;
    }
    const output = r.output;
    const callId = r.callIds.at(-1) ?? "";
    const inBatch = new Set(b.ids);
    const notes: Annotation[] = [];
    const reject = (item: string, reason: string) => {
      notes.push({ type: "rejected", run_id: inp.runId, call_id: callId, item, reason });
      totals.rejected++;
    };
    for (const e of output.explanations) {
      if (!inBatch.has(e.id)) reject(`explanation ${e.id}`, "id not in this batch");
      else if (!ok(e.text)) reject(`explanation ${e.id}`, `text must be 1–${String(MAX_TEXT)} characters`);
      else { notes.push({ type: "explanation", run_id: inp.runId, call_id: callId, finding_id: e.id, text: e.text.trim() }); totals.explanations++; }
    }
    for (const c of output.clusters) {
      const ids = stableSort([...new Set(c.ids)], (x) => x);
      if (ids.length < 2 || !ids.every((x) => inBatch.has(x))) reject(`cluster ${ids.join(",")}`, "needs two or more ids from this batch");
      else if (!ok(c.rationale)) reject(`cluster ${ids.join(",")}`, `rationale must be 1–${String(MAX_TEXT)} characters`);
      else { notes.push({ type: "cluster", run_id: inp.runId, call_id: callId, finding_ids: ids, rationale: c.rationale.trim() }); totals.clusters++; }
    }
    for (const d of output.dispositions) {
      if (!inBatch.has(d.id)) reject(`disposition ${d.id}`, "id not in this batch");
      else if (!ok(d.reason)) reject(`disposition ${d.id}`, `reason must be 1–${String(MAX_TEXT)} characters`);
      else { notes.push({ type: "disposition-proposal", run_id: inp.runId, call_id: callId, finding_id: d.id, proposed: d.proposed, reason: d.reason.trim() }); totals.proposals++; }
    }
    const j = proposeJudgments(
      { file: inp.layout.judgments, worktree: inp.layout.worktree, doc: inp.doc, rubric: inp.rubric, runId: inp.runId, callId, log: inp.log, actor: inp.actor },
      output.judgments,
    );
    totals.judgments += j.added.length;
    totals.duplicates += j.duplicates;
    for (const x of j.rejected) reject(`judgment ${x.proposal.file}:${String(x.proposal.line)}`, x.reason);
    if (notes.length > 0) appendFileSync(annotationsFile(inp.layout), notes.map((n) => `${canonicalJson(n)}\n`).join(""));
  }
  return { status, batches: batches.length, ...totals };
}
