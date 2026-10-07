// `radr address --draft` (M4 W3): the LLM drafts the consultant-owned prose blocks: the
// executive summary, recommendations and plan notes. Everything else in the report, including
// every result, comes from the deterministic pipeline.
//
// A block is drafted only while it still holds its default text, so consultant prose is never
// overwritten. A drafted block starts with DRAFT_MARKER, and Gate 2 refuses while any marker is
// left: a person has to read the draft and delete the marker.

import { readFileSync, writeFileSync } from "node:fs";
import { stableSort } from "../core/determinism.js";
import { RefusedError } from "../core/errors.js";
import type { Layout } from "../engagement/home.js";
import type { Finding } from "../findings/types.js";
import { SEVERITIES } from "../findings/types.js";
import type { RunInputs } from "../address/inputs.js";
import { applyKeeps, extractKeeps } from "../address/markdown.js";
import { buildPlan } from "../address/plan.js";
import { KEEP_DEFAULTS, addressPaths } from "../address/report.js";
import { computeScorecard } from "../address/scorecard.js";
import { invokeAgent, type AgentContext } from "./policy.js";
import { renderPrompt } from "./prompt.js";
import { promptFinding } from "./redact.js";

export const DRAFT_MARKER = "<!-- radr:llm-draft -->";
export const PURPOSE = "draft";
const MAX_DRAFT = 6000;
const TOP_FINDINGS = 15;

type BlockId = keyof typeof KEEP_DEFAULTS;
const FIELD: Readonly<Record<BlockId, "executive_summary" | "recommendations" | "plan_notes">> = {
  "executive-summary": "executive_summary", recommendations: "recommendations", "plan-notes": "plan_notes",
};

export const INSTRUCTIONS = `You are drafting prose for a code-review report that a consultant will edit and sign.
The <data> block holds the review's results: the scorecard, finding counts, the most severe
findings, confirmed judgment findings, and the remediation waves. These results are final;
pinned tools and the consultant produced them.

Return JSON matching the provided schema, each field in Markdown without top-level headings:
- executive_summary: 2–4 short paragraphs for a non-technical client: overall verdict, the most
  important risks, and what to do first.
- recommendations: a short prioritized list of recommendations, referring to findings by id.
- plan_notes: brief sequencing notes for the remediation waves.

Do not invent findings, numbers, or severities, and do not restate a severity differently from
the data. Never include HTML comments.`;

const str = { type: "string" } as const;
export const RESPONSE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["executive_summary", "recommendations", "plan_notes"],
  properties: { executive_summary: str, recommendations: str, plan_notes: str },
} as const;
type DraftResponse = Readonly<Record<(typeof FIELD)[BlockId], string>>;

export interface DraftResult {
  readonly status: "drafted" | "nothing-to-draft" | "partial" | "aborted";
  readonly drafted: readonly string[];
  readonly kept: readonly string[];
  readonly rejected: readonly string[];
}

/** The data block: results only, every finding through the policy filter. */
function draftData(inp: RunInputs, policy: "metadata-only" | "code-allowed", worktree: string) {
  const live = (f: Finding) => !["dismissed"].includes(inp.states.get(f.id) ?? "pending");
  const sevOrder = (f: Finding): [number, string] => [-SEVERITIES.indexOf(f.severity), f.id];
  const top = stableSort(inp.findings.filter(live), sevOrder).slice(0, TOP_FINDINGS);
  const judged = stableSort(inp.judgments.filter((j) => ["confirmed", "waived"].includes(inp.states.get(j.id) ?? "")), sevOrder);
  const card = inp.rubric.scorecard === undefined ? undefined : computeScorecard(inp.rubric.scorecard, inp);
  const waves = buildPlan(inp.findings, inp.states, inp.rubric.effort?.by_kind ?? {});
  const count = (fs: readonly Finding[], key: (f: Finding) => string) => {
    const out: Record<string, number> = {};
    for (const f of fs) out[key(f)] = (out[key(f)] ?? 0) + 1;
    return out;
  };
  const open = inp.findings.filter(live);
  return {
    context: {
      engagement_type: inp.doc.engagement_type,
      tier: inp.doc.tier,
      run_status: inp.runStatus,
      verdict: card?.verdict ?? "n/a",
      scorecard: (card?.rows ?? []).map((r) => ({ metric: r.label, rating: r.rating, value: r.value === null ? "unavailable" : String(r.value) })),
      open_findings_by_severity: count(open, (f) => f.severity),
      open_findings_by_category: count(open, (f) => f.category),
      waves: waves.map((w) => ({ wave: w.wave, focus: w.label, items: w.items.map((i) => ({ title: i.title, severity: i.severity, effort: i.effort, finding_ids: i.findings })) })),
    },
    findings: [...top, ...judged].map((f) => promptFinding(f, policy, worktree)),
  };
}

export async function draftKeeps(l: Layout, inp: RunInputs, agent: AgentContext): Promise<DraftResult> {
  if (agent.policy === "off") throw new RefusedError(`LLM policy is "off" for ${l.id}; refusing to draft`);
  const paths = addressPaths(l);
  const files = [paths.report, paths.remediation].map((file) => ({ file, text: readFileSync(file, "utf8") }));
  const targets: { file: string; id: BlockId }[] = [];
  const kept: string[] = [];
  for (const f of files) {
    for (const [id, body] of extractKeeps(f.text)) {
      if (!Object.hasOwn(KEEP_DEFAULTS, id)) continue;
      if (body.trim() === KEEP_DEFAULTS[id as BlockId]) targets.push({ file: f.file, id: id as BlockId });
      else kept.push(id);
    }
  }
  if (targets.length === 0) return { status: "nothing-to-draft", drafted: [], kept, rejected: [] };

  const data = draftData(inp, agent.policy, l.worktree);
  const prompt = renderPrompt(INSTRUCTIONS, { purpose: PURPOSE, ...data });
  const r = await invokeAgent<DraftResponse>(agent, { purpose: PURPOSE, prompt, schema: RESPONSE_SCHEMA });
  if (r.status !== "ok") return { status: r.status === "abort" ? "aborted" : "partial", drafted: [], kept, rejected: [] };

  const drafted: string[] = [];
  const rejected: string[] = [];
  for (const f of files) {
    const mine = targets.filter((t) => t.file === f.file);
    if (mine.length === 0) continue;
    const replace = new Map<string, string>();
    for (const t of mine) {
      const text = r.output[FIELD[t.id]].trim();
      // Keep-block syntax inside a draft could break the document's structure: refuse it.
      if (text === "" || text.length > MAX_DRAFT || text.includes("<!--")) {
        rejected.push(t.id);
        continue;
      }
      replace.set(t.id, `${DRAFT_MARKER}\n${text}`);
      drafted.push(t.id);
    }
    if (replace.size > 0) writeFileSync(f.file, applyKeeps(f.text, replace));
  }
  return { status: "drafted", drafted, kept, rejected };
}

/** Gate 2: files that still carry an unreviewed draft. */
export function filesWithDrafts(l: Layout): string[] {
  const p = addressPaths(l);
  return [p.report, p.remediation].filter((f) => readFileSync(f, "utf8").includes(DRAFT_MARKER));
}
